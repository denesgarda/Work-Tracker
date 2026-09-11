-- Migration 0001. The original schema, applied by `wrangler d1 migrations`
-- from here on, which records what has run so nothing runs twice.

-- Work Tracker schema.
-- Sync model: every row carries a monotonically increasing `rev`. Clients pull
-- `WHERE rev > lastRev` to catch up. Deletes are tombstones (deleted=1) so they
-- replicate like any other change. Money is always integer cents, never float.

CREATE TABLE IF NOT EXISTS counter (
  id  INTEGER PRIMARY KEY CHECK (id = 1),
  rev INTEGER NOT NULL
);
INSERT OR IGNORE INTO counter (id, rev) VALUES (1, 0);

CREATE TABLE IF NOT EXISTS jobs (
  id         TEXT    PRIMARY KEY,
  name       TEXT    NOT NULL,
  color      TEXT    NOT NULL DEFAULT '#6a9c5f',
  archived   INTEGER NOT NULL DEFAULT 0,
  created_ms INTEGER NOT NULL,
  rev        INTEGER NOT NULL,
  deleted    INTEGER NOT NULL DEFAULT 0
);

-- end_ms NULL means "currently clocked in".
-- breaks is a JSON array of {s, e}; a trailing entry with e === null means
-- "currently on break". Breaks live on the shift rather than in their own table
-- so that one shift is always one atomic row for sync purposes.
CREATE TABLE IF NOT EXISTS shifts (
  id       TEXT    PRIMARY KEY,
  job_id   TEXT    NOT NULL,
  start_ms INTEGER NOT NULL,
  end_ms   INTEGER,
  breaks   TEXT    NOT NULL DEFAULT '[]',
  note     TEXT    NOT NULL DEFAULT '',
  rev      INTEGER NOT NULL,
  deleted  INTEGER NOT NULL DEFAULT 0
);

-- A deposit that landed in the bank. No pay period, no project attribution:
-- money and hours are reconciled by summing both sides over a window.
CREATE TABLE IF NOT EXISTS payments (
  id              TEXT    PRIMARY KEY,
  job_id          TEXT    NOT NULL,
  paid_ms         INTEGER NOT NULL,
  amount_cents    INTEGER NOT NULL,
  set_aside_cents INTEGER NOT NULL DEFAULT 0,
  note            TEXT    NOT NULL DEFAULT '',
  rev             INTEGER NOT NULL,
  deleted         INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_jobs_rev     ON jobs (rev);
CREATE INDEX IF NOT EXISTS idx_shifts_rev   ON shifts (rev);
CREATE INDEX IF NOT EXISTS idx_payments_rev ON payments (rev);
CREATE INDEX IF NOT EXISTS idx_shifts_open  ON shifts (end_ms) WHERE end_ms IS NULL AND deleted = 0;

-- ── Expenses ─────────────────────────────────────────────────────
-- Additive only: re-running this file against an existing database creates
-- these tables and leaves everything above untouched.

-- Categories are shared across jobs — "Software" means the same thing in
-- every business. Expenses themselves each belong to exactly one job.
CREATE TABLE IF NOT EXISTS categories (
  id         TEXT    PRIMARY KEY,
  name       TEXT    NOT NULL,
  created_ms INTEGER NOT NULL,
  rev        INTEGER NOT NULL,
  deleted    INTEGER NOT NULL DEFAULT 0
);

-- business_cents NULL means the whole amount was for business. When set, it is
-- the business-use portion of total_cents, for mixed personal/business buys.
-- attachments is JSON [{key, thumb, name, type, size}]; the files themselves
-- live in R2, never in this database.
CREATE TABLE IF NOT EXISTS expenses (
  id             TEXT    PRIMARY KEY,
  job_id         TEXT    NOT NULL,
  category_id    TEXT,
  spent_ms       INTEGER NOT NULL,
  vendor         TEXT    NOT NULL DEFAULT '',
  total_cents    INTEGER NOT NULL,
  business_cents INTEGER,
  note           TEXT    NOT NULL DEFAULT '',
  attachments    TEXT    NOT NULL DEFAULT '[]',
  rev            INTEGER NOT NULL,
  deleted        INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_categories_rev ON categories (rev);
CREATE INDEX IF NOT EXISTS idx_expenses_rev   ON expenses (rev);
