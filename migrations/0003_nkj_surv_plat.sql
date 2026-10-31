-- NKJ-SURV-PLAT : journal d'activite et messages administratifs.
-- Migration additive : aucune table ni donnee existante n'est supprimee.
CREATE TABLE IF NOT EXISTS surveillance_events (
  id TEXT PRIMARY KEY,
  user_id TEXT,
  event_type TEXT NOT NULL,
  country_code TEXT,
  region_name TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_surveillance_events_user_date
  ON surveillance_events(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_surveillance_events_date
  ON surveillance_events(created_at DESC);

CREATE TABLE IF NOT EXISTS admin_user_messages (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  admin_user_id TEXT NOT NULL,
  message TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  read_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_admin_user_messages_user_date
  ON admin_user_messages(user_id, created_at DESC);

CREATE TABLE IF NOT EXISTS surveillance_audit_log (
  id TEXT PRIMARY KEY,
  admin_user_id TEXT NOT NULL,
  target_user_id TEXT,
  action TEXT NOT NULL,
  details_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_surveillance_audit_date
  ON surveillance_audit_log(created_at DESC);
