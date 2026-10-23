-- Usage Metering and Quota Service: initial schema.
-- All quantities are integer "units" of a single resource type.

CREATE TABLE plans (
  id                     UUID PRIMARY KEY,
  -- NULL owner = predefined (global, read-only) plan; otherwise a custom plan owned by one account.
  owner_account_id       UUID NULL,
  -- Stable slug for predefined plans ('starter', 'pro', 'basic', 'premium'); NULL for custom plans.
  code                   TEXT NULL,
  scope                  TEXT NOT NULL CHECK (scope IN ('account', 'user')),
  name                   TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 100),
  monthly_allowance      BIGINT NOT NULL CHECK (monthly_allowance >= 0),
  max_units_per_request  BIGINT NOT NULL CHECK (max_units_per_request >= 1),
  version                INTEGER NOT NULL DEFAULT 1,
  created_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK ((owner_account_id IS NULL) = (code IS NOT NULL))
);
CREATE UNIQUE INDEX plans_code_uq ON plans (code) WHERE code IS NOT NULL;
CREATE UNIQUE INDEX plans_owner_scope_name_uq ON plans (owner_account_id, scope, name) WHERE owner_account_id IS NOT NULL;

CREATE TABLE accounts (
  id               UUID PRIMARY KEY,
  name             TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 200),
  account_plan_id  UUID NOT NULL REFERENCES plans (id),
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE plans
  ADD CONSTRAINT plans_owner_fk FOREIGN KEY (owner_account_id) REFERENCES accounts (id) ON DELETE CASCADE;

CREATE TABLE api_keys (
  id           UUID PRIMARY KEY,
  account_id   UUID NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
  -- First characters of the key, safe to display for identification. Never the full key.
  key_prefix   TEXT NOT NULL,
  -- SHA-256 hex digest of the full key. The plaintext key is shown once at creation and never stored.
  key_hash     TEXT NOT NULL UNIQUE,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  revoked_at   TIMESTAMPTZ NULL
);
CREATE INDEX api_keys_account_idx ON api_keys (account_id);

CREATE TABLE users (
  id            UUID PRIMARY KEY,
  account_id    UUID NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
  -- Client-chosen identifier, unique within an account (e.g. 'alice' or the client's own user id).
  external_id   TEXT NOT NULL CHECK (length(external_id) BETWEEN 1 AND 200),
  user_plan_id  UUID NOT NULL REFERENCES plans (id),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (account_id, external_id)
);

-- Monthly counters. period is the first day of the UTC calendar month.
CREATE TABLE account_monthly_usage (
  account_id  UUID NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
  period      DATE NOT NULL CHECK (extract(day FROM period) = 1),
  used        BIGINT NOT NULL DEFAULT 0 CHECK (used >= 0),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (account_id, period)
);

CREATE TABLE user_monthly_usage (
  user_id     UUID NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  account_id  UUID NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
  period      DATE NOT NULL CHECK (extract(day FROM period) = 1),
  used        BIGINT NOT NULL DEFAULT 0 CHECK (used >= 0),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, period)
);
CREATE INDEX user_monthly_usage_account_period_idx ON user_monthly_usage (account_id, period);

-- Every decision (accepted or rejected) is stored once, keyed by the account-scoped request id.
CREATE TABLE consumption_requests (
  seq             BIGSERIAL PRIMARY KEY,
  account_id      UUID NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
  request_id      TEXT NOT NULL,
  user_id         UUID NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  units           BIGINT NOT NULL CHECK (units > 0),
  accepted        BOOLEAN NOT NULL,
  blocking_scope  TEXT NULL CHECK (blocking_scope IN ('account', 'user')),
  blocking_rule   TEXT NULL CHECK (blocking_rule IN ('max_units_per_request', 'monthly_allowance')),
  period          DATE NOT NULL,
  -- Immutable snapshot of the full decision (limits, usage after, reason) returned verbatim on retries.
  outcome         JSONB NOT NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (account_id, request_id),
  CHECK (accepted = (blocking_rule IS NULL)),
  CHECK ((blocking_rule IS NULL) = (blocking_scope IS NULL))
);
CREATE INDEX consumption_requests_account_seq_idx ON consumption_requests (account_id, seq DESC);
CREATE INDEX consumption_requests_user_seq_idx ON consumption_requests (user_id, seq DESC);
