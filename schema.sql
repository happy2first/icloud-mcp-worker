-- Current schema for a new iCloud Reminders deployment.
-- Reapplying this file preserves existing tables and session data.
CREATE TABLE IF NOT EXISTS apple_session_state (
  owner_id TEXT NOT NULL,
  account_id TEXT NOT NULL,
  generation INTEGER NOT NULL DEFAULT 0,
  version INTEGER NOT NULL DEFAULT 0,
  state TEXT NOT NULL DEFAULT 'DISCONNECTED',
  action TEXT,
  next_attempt_at INTEGER NOT NULL DEFAULT 0,
  envelope TEXT,
  transaction_id TEXT,
  transaction_expires_at INTEGER,
  resume_id TEXT,
  resume_expires_at INTEGER,
  updated_at INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (owner_id, account_id)
);
CREATE TABLE IF NOT EXISTS credentials (owner_id TEXT PRIMARY KEY, version INTEGER NOT NULL, envelope TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS service_config (owner_id TEXT NOT NULL, service TEXT NOT NULL, enabled INTEGER NOT NULL DEFAULT 0, writable INTEGER NOT NULL DEFAULT 0, PRIMARY KEY(owner_id,service));
CREATE TABLE IF NOT EXISTS request_limits (owner_id TEXT PRIMARY KEY, window INTEGER NOT NULL, count INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS download_tickets (id TEXT PRIMARY KEY, owner_id TEXT NOT NULL, expires_at INTEGER NOT NULL, envelope TEXT NOT NULL);

CREATE TABLE IF NOT EXISTS service_checks (owner_id TEXT NOT NULL, service TEXT NOT NULL, scope TEXT NOT NULL, checked_at INTEGER NOT NULL, result TEXT NOT NULL, PRIMARY KEY(owner_id,service));
