// @aso/server/db — Postgres Store implementation via the `postgres` package. SQL per schema.sql.
// Wallet atomicity (D4 v4): debit/grant in a transaction with FOR UPDATE (wallet serialization,
// including across instances) + UNIQUE indexes (ledger_run_keyword_uq, ledger_stripe_event_uq,
// ON CONFLICT DO NOTHING) — idempotent debits/grants. NB: not exercised against a live DB in the
// offline build environment (no network) — exercised by `bun run migrate` + happy-path on deploy.

import postgres from "postgres";
import type {
  Store, UserRow, LicenseRow, LedgerRowDb, LlmStepRow, RunRow, RunEventRow, JobRow, AppleCacheRow,
} from "./types.ts";

export class PostgresStore implements Store {
  private sql: postgres.Sql;
  constructor(connectionString: string) {
    this.sql = postgres(connectionString, { transform: { undefined: null } });
  }

  async createUser(u: UserRow) {
    await this.sql`INSERT INTO users (id, email, stripe_customer_id)
      VALUES (${u.id}, ${u.email}, ${u.stripe_customer_id})
      ON CONFLICT (email) DO NOTHING`;
  }
  async getUserByEmail(email: string) {
    const [r] = await this.sql<UserRow[]>`SELECT id, email, stripe_customer_id FROM users WHERE email = ${email}`;
    return r ?? null;
  }
  async getUserById(id: string) {
    const [r] = await this.sql<UserRow[]>`SELECT id, email, stripe_customer_id FROM users WHERE id = ${id}`;
    return r ?? null;
  }
  async getUserByStripeCustomer(customerId: string) {
    const [r] = await this.sql<UserRow[]>`SELECT id, email, stripe_customer_id FROM users WHERE stripe_customer_id = ${customerId}`;
    return r ?? null;
  }
  async setStripeCustomer(userId: string, customerId: string) {
    await this.sql`UPDATE users SET stripe_customer_id = ${customerId} WHERE id = ${userId}`;
  }

  async createLicense(l: LicenseRow) {
    await this.sql`INSERT INTO licenses (key_hash, user_id, device_fp, status, revoked_at)
      VALUES (${l.key_hash}, ${l.user_id}, ${l.device_fp}, ${l.status}, ${l.revoked_at})
      ON CONFLICT (key_hash) DO NOTHING`;
  }
  async getLicenseByKeyHash(keyHash: string) {
    const [r] = await this.sql<LicenseRow[]>`SELECT key_hash, user_id, device_fp, status, revoked_at
      FROM licenses WHERE key_hash = ${keyHash}`;
    return r ?? null;
  }
  async bindDevice(keyHash: string, deviceFp: string) {
    await this.sql`UPDATE licenses SET device_fp = ${deviceFp}
      WHERE key_hash = ${keyHash} AND device_fp IS NULL`;
  }
  async revokeLicense(keyHash: string) {
    await this.sql`UPDATE licenses SET status='revoked', revoked_at=now() WHERE key_hash = ${keyHash}`;
  }

  async getBalance(userId: string) {
    const [r] = await this.sql<{ balance_credits: number }[]>`SELECT balance_credits FROM wallet WHERE user_id = ${userId}`;
    return r ? Number(r.balance_credits) : 0;
  }
  async ensureWallet(userId: string, initialCredits: number) {
    await this.sql`INSERT INTO wallet (user_id, balance_credits) VALUES (${userId}, ${initialCredits})
      ON CONFLICT (user_id) DO NOTHING`;
  }
  // D4 v4: per-keyphrase debit — atomic in a transaction with FOR UPDATE (wallet serialization,
  // including across instances), idempotent by UNIQUE(run_id, keyword) on ledger.
  async debitForKeyphrase(userId: string, runId: string, keyword: string, price: number) {
    return this.sql.begin(async (sql) => {
      const [existing] = await sql`SELECT 1 AS x FROM ledger WHERE run_id = ${runId} AND keyword = ${keyword} AND type = 'debit' LIMIT 1`;
      const [w] = await sql<{ balance_credits: number }[]>`SELECT balance_credits FROM wallet WHERE user_id = ${userId} FOR UPDATE`;
      const balance = w ? Number(w.balance_credits) : 0;
      if (existing) return { charged: false, alreadyCharged: true, balance };
      if (balance < price) return { charged: false, alreadyCharged: false, balance };
      await sql`UPDATE wallet SET balance_credits = balance_credits - ${price} WHERE user_id = ${userId}`;
      await sql`INSERT INTO ledger (user_id, delta, type, run_id, keyword)
        VALUES (${userId}, ${-price}, 'debit', ${runId}, ${keyword}) ON CONFLICT DO NOTHING`;
      return { charged: true, alreadyCharged: false, balance: balance - price };
    });
  }
  async grantCredits(userId: string, credits: number, stripeEventId: string | null) {
    return this.sql.begin(async (sql) => {
      const inserted = await sql`INSERT INTO ledger (user_id, delta, type, stripe_event_id)
        VALUES (${userId}, ${credits}, 'grant', ${stripeEventId}) ON CONFLICT DO NOTHING RETURNING id`;
      if (inserted.length === 0) {
        const [w] = await sql<{ balance_credits: number }[]>`SELECT balance_credits FROM wallet WHERE user_id = ${userId}`;
        return { granted: false, balance: w ? Number(w.balance_credits) : 0 };
      }
      const [w] = await sql<{ balance_credits: number }[]>`
        UPDATE wallet SET balance_credits = balance_credits + ${credits} WHERE user_id = ${userId} RETURNING balance_credits`;
      return { granted: true, balance: w ? Number(w.balance_credits) : credits };
    });
  }
  async listLedger(userId: string, limit = 100) {
    return await this.sql<LedgerRowDb[]>`SELECT id, user_id, delta, type, run_id, keyword, step_seq, stripe_event_id, ts
      FROM ledger WHERE user_id = ${userId} ORDER BY id DESC LIMIT ${limit}`;
  }
  async sumDebitsForRun(runId: string) {
    const [row] = await this.sql<{ total: string | number | null }[]>`
      SELECT COALESCE(SUM(ABS(delta)), 0) AS total FROM ledger WHERE run_id = ${runId} AND type = 'debit'`;
    return Number(row?.total ?? 0);
  }

  async insertLlmStep(row: LlmStepRow) {
    await this.sql`INSERT INTO llm_steps (run_id, logical_step, step_seq, request_hash, result_json, valid, usage, cost_usd, model, duration_ms)
      VALUES (${row.run_id}, ${row.logical_step}, ${row.step_seq}, ${row.request_hash},
        ${this.sql.json(row.result_json as any)}, ${row.valid}, ${this.sql.json(row.usage as any)}, ${row.cost_usd},
        ${row.model ?? null}, ${row.duration_ms ?? null})
      ON CONFLICT (run_id, step_seq) DO NOTHING`;
  }
  async nextStepSeq(runId: string) {
    const [r] = await this.sql<{ n: number }[]>`SELECT COALESCE(MAX(step_seq),0)+1 AS n FROM llm_steps WHERE run_id = ${runId} AND step_seq >= 1`;
    return r ? Number(r.n) : 1;
  }
  async getLastValidStep(runId: string, logicalStep: string) {
    const [r] = await this.sql<LlmStepRow[]>`SELECT * FROM llm_steps
      WHERE run_id = ${runId} AND logical_step = ${logicalStep} AND valid = true
      ORDER BY step_seq DESC LIMIT 1`;
    return r ?? null;
  }
  async listLlmSteps(runId: string) {
    return await this.sql<LlmStepRow[]>`SELECT run_id, logical_step, step_seq, request_hash, result_json, valid, usage, cost_usd, model, duration_ms, ts
      FROM llm_steps WHERE run_id = ${runId} ORDER BY step_seq ASC`;
  }

  async tryMarkProcessed(eventId: string) {
    const rows = await this.sql`INSERT INTO processed_events (stripe_event_id) VALUES (${eventId})
      ON CONFLICT DO NOTHING RETURNING stripe_event_id`;
    return rows.length > 0;
  }

  async createRun(r: RunRow) {
    await this.sql`INSERT INTO runs (id, user_id, phase, config, brief, estimate_credits, context, final, usage, state)
      VALUES (${r.id}, ${r.user_id}, ${r.phase}, ${this.sql.json(r.config as any)}, ${r.brief}, ${r.estimate_credits},
        ${this.sql.json(r.context as any)}, ${this.sql.json(r.final as any)},
        ${this.sql.json(r.usage as any)}, ${this.sql.json(r.state as any)})`;
  }
  async getRun(id: string) {
    const [r] = await this.sql<RunRow[]>`SELECT id, user_id, phase, config, brief, estimate_credits, context, final, usage, state, updated_at
      FROM runs WHERE id = ${id}`;
    return r ?? null;
  }
  async updateRun(patch: Partial<RunRow> & { id: string }) {
    const s = this.sql;
    // Dynamic UPDATE over the provided fields only.
    const fields: Record<string, unknown> = {};
    for (const k of ["phase", "config", "brief", "estimate_credits", "context", "final", "usage", "state"] as const) {
      if (k in patch) {
        const raw = (patch as any)[k];
        fields[k] = (k === "config" || k === "context" || k === "final" || k === "usage" || k === "state")
          ? this.sql.json(raw) : raw;
      }
    }
    if (Object.keys(fields).length === 0) return;
    await s`UPDATE runs SET ${s(fields as any)}, updated_at = now() WHERE id = ${patch.id}`;
  }
  async listRunsByUser(userId: string) {
    return await this.sql<RunRow[]>`SELECT id, user_id, phase, config, brief, estimate_credits, context, final, usage, state, updated_at
      FROM runs WHERE user_id = ${userId} ORDER BY updated_at DESC`;
  }

  async appendRunEvent(runId: string, event: RunEventRow["event"]) {
    const [r] = await this.sql<{ seq: number }[]>`
      INSERT INTO run_events (run_id, seq, event)
      VALUES (${runId}, (SELECT COALESCE(MAX(seq),0)+1 FROM run_events WHERE run_id = ${runId}), ${this.sql.json(event as any)})
      RETURNING seq`;
    return r ? Number(r.seq) : 0;
  }
  async listRunEvents(runId: string, afterSeq = 0) {
    return await this.sql<RunEventRow[]>`SELECT run_id, seq, ts, event FROM run_events
      WHERE run_id = ${runId} AND seq > ${afterSeq} ORDER BY seq ASC`;
  }

  async insertJob(job: JobRow) {
    await this.sql`INSERT INTO jobs (job_id, run_id, kind, payload, status, result, deadline)
      VALUES (${job.job_id}, ${job.run_id}, ${job.kind}, ${this.sql.json(job.payload as any)},
        ${job.status}, ${this.sql.json(job.result as any)}, ${job.deadline})
      ON CONFLICT (job_id) DO NOTHING`;
  }
  async updateJob(jobId: string, patch: Partial<JobRow>) {
    const fields: Record<string, unknown> = {};
    if (patch.status !== undefined) fields.status = patch.status;
    if (patch.result !== undefined) fields.result = this.sql.json(patch.result as any);
    if (Object.keys(fields).length === 0) return;
    await this.sql`UPDATE jobs SET ${this.sql(fields as any)} WHERE job_id = ${jobId}`;
  }
  async getJob(jobId: string) {
    const [r] = await this.sql<JobRow[]>`SELECT job_id, run_id, kind, payload, status, result, deadline FROM jobs WHERE job_id = ${jobId}`;
    return r ?? null;
  }

  async getCache(cacheKey: string) {
    const [r] = await this.sql<AppleCacheRow[]>`SELECT cache_key, url, storefront, status, body, fetched_at
      FROM apple_cache WHERE cache_key = ${cacheKey}`;
    return r ?? null;
  }
  async putCache(row: AppleCacheRow) {
    await this.sql`INSERT INTO apple_cache (cache_key, url, storefront, status, body, fetched_at)
      VALUES (${row.cache_key}, ${row.url}, ${row.storefront}, ${row.status}, ${this.sql.json(row.body as any)}, ${row.fetched_at})
      ON CONFLICT (cache_key) DO UPDATE SET body = EXCLUDED.body, fetched_at = EXCLUDED.fetched_at, status = EXCLUDED.status`;
  }

  async close() { await this.sql.end({ timeout: 5 }); }

  raw() { return this.sql; }
}
