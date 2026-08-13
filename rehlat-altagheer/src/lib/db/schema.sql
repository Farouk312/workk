-- Schema for the participant tracking system.
--
-- Design rules that the rest of the code depends on:
--   * Every timestamp column holds epoch milliseconds (UTC). Never a local string.
--   * day_key is a 'YYYY-MM-DD' calendar date in APP_TIMEZONE, computed in
--     src/lib/time.ts. It is duplicated onto rows deliberately so that all
--     day/week grouping is a plain indexed lookup and never re-derives a
--     timezone at query time.
--   * activity_log is append-only. Nothing in the app updates or deletes it.
--   * Elapsed time is never stored as a running total. It is always summed from
--     task_intervals, so a crash, refresh or closed browser cannot corrupt it.

PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS participants (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  name          TEXT    NOT NULL UNIQUE,
  pin_hash      TEXT,               -- NULL until the participant sets their first PIN
  pin_salt      TEXT,
  must_set_pin  INTEGER NOT NULL DEFAULT 1,  -- 1 after an admin reset, forces a new PIN
  is_admin      INTEGER NOT NULL DEFAULT 0,
  whatsapp      TEXT,
  locale        TEXT    NOT NULL DEFAULT 'ar',
  active        INTEGER NOT NULL DEFAULT 1,
  created_at    INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS tasks (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  name          TEXT    NOT NULL,
  position      INTEGER NOT NULL DEFAULT 0,
  -- Some tasks may be tracked but excluded from the daily percentage.
  -- Defaults to counting, which matches the spec's plain reading.
  counts_toward_percentage INTEGER NOT NULL DEFAULT 1,
  -- Archived tasks disappear from today's list but keep all historical rows,
  -- so past days keep the percentage they were actually earned with.
  archived      INTEGER NOT NULL DEFAULT 0,
  created_at    INTEGER NOT NULL
);

-- One row per participant per day. Created by the explicit "Start My Day"
-- action, never by simply logging in.
CREATE TABLE IF NOT EXISTS daily_sessions (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  participant_id INTEGER NOT NULL REFERENCES participants(id) ON DELETE CASCADE,
  day_key        TEXT    NOT NULL,
  started_at     INTEGER NOT NULL,
  ended_at       INTEGER,
  -- 'active' | 'ended'. Ending preserves every interval already recorded.
  state          TEXT    NOT NULL DEFAULT 'active',
  -- How the day ended: 'manual' | 'auto_all_complete' | NULL while active.
  end_reason     TEXT,
  UNIQUE (participant_id, day_key)
);

-- Current state of one task, for one participant, on one day.
CREATE TABLE IF NOT EXISTS task_days (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  participant_id INTEGER NOT NULL REFERENCES participants(id) ON DELETE CASCADE,
  task_id        INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  day_key        TEXT    NOT NULL,
  -- 'idle' | 'running' | 'paused' | 'completed' | 'attempted'
  -- 'attempted' means finished without completing: the time counts, the task does not.
  status         TEXT    NOT NULL DEFAULT 'idle',
  completed_at   INTEGER,
  pause_count    INTEGER NOT NULL DEFAULT 0,
  reopen_count   INTEGER NOT NULL DEFAULT 0,
  UNIQUE (participant_id, task_id, day_key)
);

-- Append-only work segments. An open segment has ended_at IS NULL.
-- Active time for a task = sum of (ended_at - started_at), plus (now - started_at)
-- for the single open segment if there is one. Paused time is simply the gap
-- between segments and is therefore never counted.
CREATE TABLE IF NOT EXISTS task_intervals (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  participant_id INTEGER NOT NULL REFERENCES participants(id) ON DELETE CASCADE,
  task_id        INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  day_key        TEXT    NOT NULL,
  started_at     INTEGER NOT NULL,
  ended_at       INTEGER
);

-- Full audit trail. Append-only: the app never updates or deletes these rows.
CREATE TABLE IF NOT EXISTS activity_log (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  participant_id INTEGER NOT NULL REFERENCES participants(id) ON DELETE CASCADE,
  task_id        INTEGER REFERENCES tasks(id) ON DELETE SET NULL,
  day_key        TEXT    NOT NULL,
  event          TEXT    NOT NULL,
  at             INTEGER NOT NULL,
  detail         TEXT
);

CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_daily_sessions_day    ON daily_sessions (day_key);
CREATE INDEX IF NOT EXISTS idx_task_days_lookup      ON task_days (participant_id, day_key);
CREATE INDEX IF NOT EXISTS idx_task_days_day         ON task_days (day_key);
CREATE INDEX IF NOT EXISTS idx_task_intervals_lookup ON task_intervals (participant_id, day_key);
CREATE INDEX IF NOT EXISTS idx_task_intervals_open   ON task_intervals (participant_id, task_id, day_key, ended_at);
CREATE INDEX IF NOT EXISTS idx_activity_log_lookup   ON activity_log (participant_id, day_key);
CREATE INDEX IF NOT EXISTS idx_activity_log_at       ON activity_log (at);
