-- @aso/server/db — Postgres schema for all tables (BUILD-PLAN §5). Idempotent (IF NOT EXISTS).
-- Applied via src/db/migrate.ts. Billing invariant: UNIQUE(run_id, step_seq) on ledger
-- and llm_steps rules out double debit/double COGS on replay (D4/D7).

-- Migration guard (Stripe → Paddle, 2026-07-19): a database created under the pre-Paddle
-- schema keeps stripe_* columns, and CREATE TABLE IF NOT EXISTS below would no-op past them.
-- Rename in place when the legacy columns exist; fresh databases skip this block.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='users' AND column_name='stripe_customer_id') THEN
    ALTER TABLE users RENAME COLUMN stripe_customer_id TO paddle_customer_id;
  END IF;
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='ledger' AND column_name='stripe_event_id') THEN
    ALTER TABLE ledger RENAME COLUMN stripe_event_id TO paddle_event_id;
    ALTER INDEX IF EXISTS ledger_stripe_event_uq RENAME TO ledger_paddle_event_uq;
  END IF;
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='processed_events' AND column_name='stripe_event_id') THEN
    ALTER TABLE processed_events RENAME COLUMN stripe_event_id TO paddle_event_id;
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS users (
  id                  TEXT PRIMARY KEY,
  email               TEXT UNIQUE NOT NULL,
  paddle_customer_id  TEXT,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Beta waitlist (admin-managed): pending → invited (email sent) → signed_up.
CREATE TABLE IF NOT EXISTS waitlist (
  email         TEXT PRIMARY KEY,
  added_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  invited_at    TIMESTAMPTZ,
  signed_up_at  TIMESTAMPTZ,
  note          TEXT
);

-- Free-form note on ledger rows (admin grants, beta welcome grants).
ALTER TABLE IF EXISTS ledger ADD COLUMN IF NOT EXISTS note TEXT;

-- Sessions are PERSISTED (not in-memory): a server restart/deploy must never log every
-- client out. Raw tokens are never stored — only sha256(token).
CREATE TABLE IF NOT EXISTS sessions (
  token_hash   TEXT PRIMARY KEY,
  user_id      TEXT NOT NULL,
  device_fp    TEXT NOT NULL,
  hmac_secret  TEXT NOT NULL,
  expires_at   TIMESTAMPTZ NOT NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS sessions_user_idx ON sessions (user_id);
CREATE INDEX IF NOT EXISTS sessions_expires_idx ON sessions (expires_at);

CREATE TABLE IF NOT EXISTS licenses (
  key_hash    TEXT PRIMARY KEY,           -- sha256(key); the key itself is not stored
  user_id     TEXT NOT NULL REFERENCES users(id),
  device_fp   TEXT,                        -- device-binding (first successful hello)
  status      TEXT NOT NULL DEFAULT 'active',  -- active | revoked
  revoked_at  TIMESTAMPTZ,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Balance is the source of truth (D4 v4). Credits are fractional (1 credit = $1; a keyphrase
-- costs a fraction of a credit). Per-keyphrase debit under FOR UPDATE (wallet serialization, never negative).
CREATE TABLE IF NOT EXISTS wallet (
  user_id         TEXT PRIMARY KEY REFERENCES users(id),
  balance_credits NUMERIC(14,4) NOT NULL DEFAULT 0
);
ALTER TABLE wallet ALTER COLUMN balance_credits TYPE NUMERIC(14,4);

-- Immutable log. D4 v4: one debit row per checked keyphrase —
-- UNIQUE(run_id, keyword) makes debits idempotent. paddle_event_id UNIQUE — grants.
CREATE TABLE IF NOT EXISTS ledger (
  id               BIGSERIAL PRIMARY KEY,
  user_id          TEXT NOT NULL REFERENCES users(id),
  delta            NUMERIC(14,4) NOT NULL, -- +grant / -debit (in fractional credits)
  type             TEXT NOT NULL,          -- grant | debit | settle | refund | chargeback
  run_id           TEXT,
  keyword          TEXT,                   -- keyphrase (for UNIQUE(run_id, keyword), D4 v4)
  step_seq         INTEGER,                -- (legacy; unused in v4)
  paddle_event_id  TEXT,
  note             TEXT,                   -- free-form (admin grants, beta welcome grants)
  ts               TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE ledger ADD COLUMN IF NOT EXISTS keyword TEXT;
ALTER TABLE ledger ALTER COLUMN delta TYPE NUMERIC(14,4);
CREATE UNIQUE INDEX IF NOT EXISTS ledger_run_keyword_uq ON ledger (run_id, keyword)
  WHERE run_id IS NOT NULL AND keyword IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS ledger_paddle_event_uq ON ledger (paddle_event_id)
  WHERE paddle_event_id IS NOT NULL;

-- Every billable attempt = a row (including invalid ones). advance/replay uses the last
-- valid row of the logical step; Anthropic is not called again (D7).
CREATE TABLE IF NOT EXISTS llm_steps (
  run_id        TEXT NOT NULL,
  logical_step  TEXT NOT NULL,             -- context | seeds | rate | hypothesize | phrase (+#)
  step_seq      INTEGER NOT NULL,          -- server-side monotonic counter per attempt
  request_hash  TEXT NOT NULL,
  result_json   JSONB,                     -- null for an invalid attempt
  valid         BOOLEAN NOT NULL DEFAULT false,
  usage         JSONB NOT NULL,
  cost_usd      DOUBLE PRECISION,
  model         TEXT,                      -- model of the attempt (D9 log)
  duration_ms   INTEGER,                   -- provider latency (D9 log)
  ts            TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (run_id, step_seq)
);
CREATE INDEX IF NOT EXISTS llm_steps_logical ON llm_steps (run_id, logical_step);
ALTER TABLE llm_steps ADD COLUMN IF NOT EXISTS model TEXT;
ALTER TABLE llm_steps ADD COLUMN IF NOT EXISTS duration_ms INTEGER;

CREATE TABLE IF NOT EXISTS processed_events (
  paddle_event_id TEXT PRIMARY KEY,
  ts              TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS runs (
  id             TEXT PRIMARY KEY,
  user_id        TEXT NOT NULL REFERENCES users(id),
  phase          TEXT NOT NULL,
  config          JSONB NOT NULL,
  brief           TEXT NOT NULL DEFAULT '',   -- product brief (needed by event-replay)
  estimate_credits NUMERIC(14,4) NOT NULL DEFAULT 0, -- estimated ceiling (D4 v4; NOT a reserve)
  context         JSONB,
  final           JSONB,                      -- AssemblyResult
  usage           JSONB,
  state           JSONB,                      -- read projection of state (resume authority — event-replay)
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE runs ADD COLUMN IF NOT EXISTS brief TEXT NOT NULL DEFAULT '';
ALTER TABLE runs ADD COLUMN IF NOT EXISTS estimate_credits NUMERIC(14,4) NOT NULL DEFAULT 0;

-- Event-sourced log: replay, SSE, Last-Event-ID (D7).
CREATE TABLE IF NOT EXISTS run_events (
  run_id  TEXT NOT NULL,
  seq     BIGINT NOT NULL,
  ts      TIMESTAMPTZ NOT NULL DEFAULT now(),
  event   JSONB NOT NULL,
  PRIMARY KEY (run_id, seq)
);

-- Apple job queue, idempotent by job_id (D7). FOR UPDATE SKIP LOCKED at scale.
CREATE TABLE IF NOT EXISTS jobs (
  job_id    TEXT PRIMARY KEY,
  run_id    TEXT NOT NULL,
  kind      TEXT NOT NULL,                 -- probe | serp | hints
  payload   JSONB NOT NULL,
  status    TEXT NOT NULL DEFAULT 'pending', -- pending | dispatched | done | error
  result    JSONB,
  deadline  TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Network-wide cache of raw Apple data (D3), TTL by fetched_at.
CREATE TABLE IF NOT EXISTS apple_cache (
  cache_key   TEXT PRIMARY KEY,            -- sha1(method+url+storefront)
  url         TEXT NOT NULL,
  storefront  INTEGER NOT NULL,
  status      INTEGER NOT NULL,
  body        JSONB NOT NULL,              -- RawHints | RawSerp
  fetched_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
