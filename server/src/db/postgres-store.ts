// @aso/server/db — Postgres Store implementation via the `postgres` package. SQL per schema.sql.
// Wallet atomicity (D4 v4): debit/grant in a transaction with FOR UPDATE (wallet serialization,
// including across instances) + UNIQUE indexes (ledger_run_keyword_uq, ledger_paddle_event_uq,
// ON CONFLICT DO NOTHING) — idempotent debits/grants. NB: not exercised against a live DB in the
// offline build environment (no network) — exercised by `bun run migrate` + happy-path on deploy.

import postgres from "postgres";
import type {
  Store, UserRow, LicenseRow, SessionRow, WaitlistRow, AdminUserRow, AdminRunRow,
  LedgerRowDb, LlmStepRow, RunRow, RunEventRow, JobRow, AppleCacheRow,
} from "./types.ts";

export class PostgresStore implements Store {
  private sql: postgres.Sql;
  constructor(connectionString: string) {
    this.sql = postgres(connectionString, { transform: { undefined: null } });
  }

  async createUser(u: UserRow) {
    await this.sql`INSERT INTO users (id, email, paddle_customer_id)
      VALUES (${u.id}, ${u.email}, ${u.paddle_customer_id})
      ON CONFLICT (email) DO NOTHING`;
  }
  async getUserByEmail(email: string) {
    const [r] = await this.sql<UserRow[]>`SELECT id, email, paddle_customer_id FROM users WHERE email = ${email}`;
    return r ?? null;
  }
  async getUserById(id: string) {
    const [r] = await this.sql<UserRow[]>`SELECT id, email, paddle_customer_id FROM users WHERE id = ${id}`;
    return r ?? null;
  }
  async getUserByPaddleCustomer(customerId: string) {
    const [r] = await this.sql<UserRow[]>`SELECT id, email, paddle_customer_id FROM users WHERE paddle_customer_id = ${customerId}`;
    return r ?? null;
  }
  async setPaddleCustomer(userId: string, customerId: string) {
    await this.sql`UPDATE users SET paddle_customer_id = ${customerId} WHERE id = ${userId}`;
  }

  async putSession(s: SessionRow) {
    await this.sql`INSERT INTO sessions (token_hash, user_id, device_fp, hmac_secret, expires_at)
      VALUES (${s.token_hash}, ${s.user_id}, ${s.device_fp}, ${s.hmac_secret}, ${s.expires_at as string})
      ON CONFLICT (token_hash) DO NOTHING`;
  }
  async getSession(tokenHash: string) {
    const [r] = await this.sql<SessionRow[]>`SELECT token_hash, user_id, device_fp, hmac_secret, expires_at
      FROM sessions WHERE token_hash = ${tokenHash}`;
    return r ?? null;
  }
  async deleteSession(tokenHash: string) {
    await this.sql`DELETE FROM sessions WHERE token_hash = ${tokenHash}`;
  }
  async deleteSessionsForUser(userId: string) {
    await this.sql`DELETE FROM sessions WHERE user_id = ${userId}`;
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
  async grantCredits(userId: string, credits: number, paddleEventId: string | null, note: string | null = null) {
    return this.sql.begin(async (sql) => {
      const inserted = await sql`INSERT INTO ledger (user_id, delta, type, paddle_event_id, note)
        VALUES (${userId}, ${credits}, 'grant', ${paddleEventId}, ${note}) ON CONFLICT DO NOTHING RETURNING id`;
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
    return await this.sql<LedgerRowDb[]>`SELECT id, user_id, delta, type, run_id, keyword, step_seq, paddle_event_id, note, ts
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
    const rows = await this.sql`INSERT INTO processed_events (paddle_event_id) VALUES (${eventId})
      ON CONFLICT DO NOTHING RETURNING paddle_event_id`;
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
    // seq is MAX+1 per run, which races under concurrent appends (the probe pool emits from
    // several workers): two inserts can read the same MAX and collide on the (run_id, seq) PK.
    // The orchestrator serializes its own events, but retry on the unique violation as defense
    // (also covers any other concurrent emitter, e.g. the manager's own run-lifecycle events).
    for (let attempt = 0; ; attempt++) {
      try {
        const [r] = await this.sql<{ seq: number }[]>`
          INSERT INTO run_events (run_id, seq, event)
          VALUES (${runId}, (SELECT COALESCE(MAX(seq),0)+1 FROM run_events WHERE run_id = ${runId}), ${this.sql.json(event as any)})
          RETURNING seq`;
        return r ? Number(r.seq) : 0;
      } catch (e: any) {
        if (e?.code === "23505" && attempt < 12) continue; // seq taken by a concurrent append — recompute
        throw e;
      }
    }
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

  // ── waitlist ─────────────────────────────────────────────────────────────
  async waitlistImport(emails: string[], note: string | null) {
    let added = 0;
    for (const email of emails) {
      const rows = await this.sql`INSERT INTO waitlist (email, note) VALUES (${email}, ${note})
        ON CONFLICT (email) DO NOTHING RETURNING email`;
      if (rows.length) added++;
    }
    return { added, duplicates: emails.length - added };
  }
  async listWaitlist(status: "all" | "pending" | "invited" | "signed_up", page: number, pageSize: number) {
    const cond = status === "pending" ? this.sql`WHERE invited_at IS NULL`
      : status === "invited" ? this.sql`WHERE invited_at IS NOT NULL AND signed_up_at IS NULL`
      : status === "signed_up" ? this.sql`WHERE signed_up_at IS NOT NULL`
      : this.sql``;
    const [c] = await this.sql<{ pending: string; invited: string; signed_up: string }[]>`
      SELECT COUNT(*) FILTER (WHERE invited_at IS NULL) AS pending,
             COUNT(*) FILTER (WHERE invited_at IS NOT NULL AND signed_up_at IS NULL) AS invited,
             COUNT(*) FILTER (WHERE signed_up_at IS NOT NULL) AS signed_up
      FROM waitlist`;
    const [t] = await this.sql<{ n: string }[]>`SELECT COUNT(*) AS n FROM waitlist ${cond}`;
    const items = await this.sql<WaitlistRow[]>`SELECT email, added_at, invited_at, signed_up_at, note
      FROM waitlist ${cond} ORDER BY added_at ASC LIMIT ${pageSize} OFFSET ${page * pageSize}`;
    return {
      total: Number(t?.n ?? 0),
      counts: { pending: Number(c?.pending ?? 0), invited: Number(c?.invited ?? 0), signedUp: Number(c?.signed_up ?? 0) },
      items,
    };
  }
  async getWaitlistEntry(email: string) {
    const [r] = await this.sql<WaitlistRow[]>`SELECT email, added_at, invited_at, signed_up_at, note
      FROM waitlist WHERE email = ${email}`;
    return r ?? null;
  }
  async markWaitlistInvited(email: string) {
    await this.sql`UPDATE waitlist SET invited_at = now() WHERE email = ${email} AND invited_at IS NULL`;
  }
  async markWaitlistSignedUp(email: string) {
    await this.sql`UPDATE waitlist SET signed_up_at = now() WHERE email = ${email} AND signed_up_at IS NULL`;
  }
  async deleteWaitlistEntry(email: string) {
    await this.sql`DELETE FROM waitlist WHERE email = ${email}`;
  }

  // ── admin projections ────────────────────────────────────────────────────
  async adminUsers(): Promise<AdminUserRow[]> {
    return await this.sql<AdminUserRow[]>`
      SELECT u.id, u.email, u.created_at, u.paddle_customer_id,
        COALESCE(w.balance_credits, 0)::float AS balance,
        COALESCE(lg.granted, 0)::float AS granted,
        COALESCE(lg.spent, 0)::float AS spent,
        COALESCE(r.n, 0)::int AS runs,
        r.last_run_at,
        COALESCE(lic.n, 0)::int AS licenses,
        COALESCE(s.n, 0)::int AS active_sessions
      FROM users u
      LEFT JOIN wallet w ON w.user_id = u.id
      LEFT JOIN (SELECT user_id,
                   SUM(delta) FILTER (WHERE type = 'grant') AS granted,
                   SUM(ABS(delta)) FILTER (WHERE type = 'debit') AS spent
                 FROM ledger GROUP BY user_id) lg ON lg.user_id = u.id
      LEFT JOIN (SELECT user_id, COUNT(*) AS n, MAX(updated_at) AS last_run_at
                 FROM runs GROUP BY user_id) r ON r.user_id = u.id
      LEFT JOIN (SELECT user_id, COUNT(*) AS n FROM licenses GROUP BY user_id) lic ON lic.user_id = u.id
      LEFT JOIN (SELECT user_id, COUNT(*) AS n FROM sessions WHERE expires_at > now()
                 GROUP BY user_id) s ON s.user_id = u.id
      ORDER BY u.created_at DESC NULLS LAST`;
  }
  async adminRuns(): Promise<AdminRunRow[]> {
    return await this.sql<AdminRunRow[]>`
      SELECT r.id, r.user_id,
        COALESCE(r.config->>'brand', '') AS brand,
        COALESCE(r.config->>'country', '') AS country,
        r.phase,
        COALESCE((r.state->>'paused')::boolean, false) AS paused,
        COALESCE(d.n, 0)::int AS sample_count,
        COALESCE((r.config->>'sampleSize')::int, 0) AS sample_size,
        COALESCE(d.spent, 0)::float AS credits_spent,
        COALESCE(c.usd, 0)::float AS cogs_usd,
        r.state->>'createdAt' AS created_at,
        r.updated_at
      FROM runs r
      LEFT JOIN (SELECT run_id, COUNT(*) AS n, SUM(ABS(delta)) AS spent
                 FROM ledger WHERE type = 'debit' GROUP BY run_id) d ON d.run_id = r.id
      LEFT JOIN (SELECT run_id, SUM(cost_usd) AS usd FROM llm_steps GROUP BY run_id) c ON c.run_id = r.id
      ORDER BY r.updated_at DESC NULLS LAST`;
  }
  async adminLedgerTotals() {
    const [r] = await this.sql<{ granted: string | null; granted_paid: string | null; spent: string | null }[]>`
      SELECT SUM(delta) FILTER (WHERE type = 'grant') AS granted,
             SUM(delta) FILTER (WHERE type = 'grant' AND paddle_event_id LIKE 'txn_%') AS granted_paid,
             SUM(ABS(delta)) FILTER (WHERE type = 'debit') AS spent
      FROM ledger`;
    return { granted: Number(r?.granted ?? 0), grantedPaid: Number(r?.granted_paid ?? 0), spent: Number(r?.spent ?? 0) };
  }
  async adminLedgerSince(sinceIso: string) {
    return await this.sql<LedgerRowDb[]>`SELECT id, user_id, delta, type, run_id, keyword, step_seq, paddle_event_id, note, ts
      FROM ledger WHERE ts >= ${sinceIso} ORDER BY ts ASC`;
  }
  async adminCogsTotals(since30dIso: string) {
    const [r] = await this.sql<{ total: string | null; last30: string | null }[]>`
      SELECT SUM(cost_usd) AS total, SUM(cost_usd) FILTER (WHERE ts >= ${since30dIso}) AS last30 FROM llm_steps`;
    return { totalUsd: Number(r?.total ?? 0), last30dUsd: Number(r?.last30 ?? 0) };
  }
  async adminCogsSince(sinceIso: string) {
    const rows = await this.sql<{ ts: string | Date; cost_usd: number | null }[]>`
      SELECT ts, cost_usd FROM llm_steps WHERE ts >= ${sinceIso} ORDER BY ts ASC`;
    return rows.map((r) => ({ ts: r.ts, costUsd: Number(r.cost_usd ?? 0) }));
  }
  async listLicensesForUser(userId: string) {
    return await this.sql<LicenseRow[]>`SELECT key_hash, user_id, device_fp, status, revoked_at
      FROM licenses WHERE user_id = ${userId}`;
  }
  async countSessionsForUser(userId: string) {
    const [r] = await this.sql<{ n: string }[]>`SELECT COUNT(*) AS n FROM sessions
      WHERE user_id = ${userId} AND expires_at > now()`;
    return Number(r?.n ?? 0);
  }

  async close() { await this.sql.end({ timeout: 5 }); }

  raw() { return this.sql; }
}
