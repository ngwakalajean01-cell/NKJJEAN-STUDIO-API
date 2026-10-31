-- Messagerie bidirectionnelle entre NKJJEAN-STUDIO et NKJ-SURV-PLAT.
-- Migration additive : ne supprime aucune table ni donnée existante.
CREATE TABLE IF NOT EXISTS platform_messages (
  id TEXT PRIMARY KEY,
  sender_user_id TEXT NOT NULL,
  recipient_user_id TEXT NOT NULL,
  message TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  expires_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now','+1 year')),
  read_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_platform_messages_sender_date
  ON platform_messages(sender_user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_platform_messages_recipient_date
  ON platform_messages(recipient_user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_platform_messages_expiry
  ON platform_messages(expires_at);
