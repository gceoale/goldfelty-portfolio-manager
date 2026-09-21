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
