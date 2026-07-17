-- @aso/server/db — Postgres-схема всех таблиц (BUILD-PLAN §5). Идемпотентна (IF NOT EXISTS).
-- Применяется через src/db/migrate.ts. Инвариант биллинга: UNIQUE(run_id, step_seq) на ledger
-- и llm_steps закрывает двойное списание/двойной COGS при реплее (D4/D7).

CREATE TABLE IF NOT EXISTS users (
  id                  TEXT PRIMARY KEY,
  email               TEXT UNIQUE NOT NULL,
  stripe_customer_id  TEXT,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS licenses (
  key_hash    TEXT PRIMARY KEY,           -- sha256(ключ); сам ключ не храним
  user_id     TEXT NOT NULL REFERENCES users(id),
  device_fp   TEXT,                        -- device-binding (первый успешный hello)
  status      TEXT NOT NULL DEFAULT 'active',  -- active | revoked
  revoked_at  TIMESTAMPTZ,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Баланс — источник истины (D4 v4). Кредиты фракционные (1 кредит = $1, кейфраза стоит доли
-- кредита). Списание за кейфразу под FOR UPDATE (сериализация кошелька, в минус не уходит).
CREATE TABLE IF NOT EXISTS wallet (
  user_id         TEXT PRIMARY KEY REFERENCES users(id),
  balance_credits NUMERIC(14,4) NOT NULL DEFAULT 0
);
ALTER TABLE wallet ALTER COLUMN balance_credits TYPE NUMERIC(14,4);

-- Иммутабельный журнал. D4 v4: по строке debit на каждую проверенную кейфразу —
-- UNIQUE(run_id, keyword) даёт идемпотентность списания. stripe_event_id UNIQUE — гранты.
CREATE TABLE IF NOT EXISTS ledger (
  id               BIGSERIAL PRIMARY KEY,
  user_id          TEXT NOT NULL REFERENCES users(id),
  delta            NUMERIC(14,4) NOT NULL, -- +grant / -debit (в кредитах, фракционных)
  type             TEXT NOT NULL,          -- grant | debit | settle | refund | chargeback
  run_id           TEXT,
  keyword          TEXT,                   -- кейфраза (для UNIQUE(run_id, keyword), D4 v4)
  step_seq         INTEGER,                -- (legacy; не используется в v4)
  stripe_event_id  TEXT,
  ts               TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE ledger ADD COLUMN IF NOT EXISTS keyword TEXT;
ALTER TABLE ledger ALTER COLUMN delta TYPE NUMERIC(14,4);
CREATE UNIQUE INDEX IF NOT EXISTS ledger_run_keyword_uq ON ledger (run_id, keyword)
  WHERE run_id IS NOT NULL AND keyword IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS ledger_stripe_event_uq ON ledger (stripe_event_id)
  WHERE stripe_event_id IS NOT NULL;

-- Каждая billable-попытка = строка (в т.ч. невалидные). advance/реплей по последней
-- valid строке логического шага; Anthropic не зовётся заново (D7).
CREATE TABLE IF NOT EXISTS llm_steps (
  run_id        TEXT NOT NULL,
  logical_step  TEXT NOT NULL,             -- context | seeds | rate | hypothesize | phrase (+#)
  step_seq      INTEGER NOT NULL,          -- серверный монотонный счётчик на попытку
  request_hash  TEXT NOT NULL,
  result_json   JSONB,                     -- null для невалидной попытки
  valid         BOOLEAN NOT NULL DEFAULT false,
  usage         JSONB NOT NULL,
  cost_usd      DOUBLE PRECISION,
  model         TEXT,                      -- модель попытки (D9-журнал)
  duration_ms   INTEGER,                   -- латентность провайдера (D9-журнал)
  ts            TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (run_id, step_seq)
);
CREATE INDEX IF NOT EXISTS llm_steps_logical ON llm_steps (run_id, logical_step);
ALTER TABLE llm_steps ADD COLUMN IF NOT EXISTS model TEXT;
ALTER TABLE llm_steps ADD COLUMN IF NOT EXISTS duration_ms INTEGER;

CREATE TABLE IF NOT EXISTS processed_events (
  stripe_event_id TEXT PRIMARY KEY,
  ts              TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS runs (
  id             TEXT PRIMARY KEY,
  user_id        TEXT NOT NULL REFERENCES users(id),
  phase          TEXT NOT NULL,
  config          JSONB NOT NULL,
  brief           TEXT NOT NULL DEFAULT '',   -- бриф продукта (нужен event-replay)
  estimate_credits NUMERIC(14,4) NOT NULL DEFAULT 0, -- оценочный потолок (D4 v4; НЕ резерв)
  context         JSONB,
  final           JSONB,                      -- AssemblyResult
  usage           JSONB,
  state           JSONB,                      -- read-проекция состояния (авторитет resume — event-replay)
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE runs ADD COLUMN IF NOT EXISTS brief TEXT NOT NULL DEFAULT '';
ALTER TABLE runs ADD COLUMN IF NOT EXISTS estimate_credits NUMERIC(14,4) NOT NULL DEFAULT 0;

-- Event-sourced лог: реплей, SSE, Last-Event-ID (D7).
CREATE TABLE IF NOT EXISTS run_events (
  run_id  TEXT NOT NULL,
  seq     BIGINT NOT NULL,
  ts      TIMESTAMPTZ NOT NULL DEFAULT now(),
  event   JSONB NOT NULL,
  PRIMARY KEY (run_id, seq)
);

-- Очередь Apple-джоб, идемпотентность по job_id (D7). FOR UPDATE SKIP LOCKED при масштабе.
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

-- Общесетевой кэш сырья Apple (D3), TTL по fetched_at.
CREATE TABLE IF NOT EXISTS apple_cache (
  cache_key   TEXT PRIMARY KEY,            -- sha1(method+url+storefront)
  url         TEXT NOT NULL,
  storefront  INTEGER NOT NULL,
  status      INTEGER NOT NULL,
  body        JSONB NOT NULL,              -- RawHints | RawSerp
  fetched_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
