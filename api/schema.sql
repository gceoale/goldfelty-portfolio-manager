-- Accounts for api.goldfelty.com.
--
-- The two unique indexes are load-bearing: they are what stops two people
-- claiming one username in the same instant, which no amount of checking
-- beforehand can guarantee on its own.

CREATE TABLE IF NOT EXISTS accounts (
  id         TEXT PRIMARY KEY,
  username   TEXT NOT NULL,
  email      TEXT NOT NULL,
  address    TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS accounts_username ON accounts (username);
CREATE UNIQUE INDEX IF NOT EXISTS accounts_address  ON accounts (address);

-- Fixed-window request counts per hashed IP, for rate limiting. Rows from
-- old windows are swept by the Worker.
CREATE TABLE IF NOT EXISTS rate_limits (
  key    TEXT    NOT NULL,
  bucket INTEGER NOT NULL,
  count  INTEGER NOT NULL,
  PRIMARY KEY (key, bucket)
);

-- One reporting token per account, stored as a SHA-256 hash. Reissued each
-- time the account signs in again from the app.
CREATE TABLE IF NOT EXISTS api_tokens (
  account_id TEXT PRIMARY KEY REFERENCES accounts (id),
  token_hash TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL
);

-- Portfolio totals, only from users who turned on sharing in the app. One
-- row per account, replaced on each report and deleted when sharing stops.
CREATE TABLE IF NOT EXISTS reports (
  account_id  TEXT PRIMARY KEY REFERENCES accounts (id),
  value       REAL    NOT NULL,
  currency    TEXT    NOT NULL,
  wallets     INTEGER NOT NULL,
  reported_at TEXT    NOT NULL
);

-- Goldfelty's social autopilot (goldfelty.com/admin/social/): settings,
-- account sign-ins, the post queue and run history, as JSON. Settings,
-- sign-ins and pending OAuth states are encrypted by the Worker before they
-- get here.
CREATE TABLE IF NOT EXISTS social_kv (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
