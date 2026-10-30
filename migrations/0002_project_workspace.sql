-- NKJJEAN STUDIO
-- Migration 0002 : conversations et messages de travail par projet.
-- À exécuter une seule fois dans la console D1 : nkjjean-studio-db.
-- Cette migration ajoute des tables ; elle ne supprime aucune donnée existante.

CREATE TABLE IF NOT EXISTS project_conversations (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  title TEXT NOT NULL DEFAULT 'Nouvelle conversation',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS project_messages (
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('user','assistant','system')),
  content TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  FOREIGN KEY (conversation_id) REFERENCES project_conversations(id) ON DELETE CASCADE,
  FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_project_conversations_owner
  ON project_conversations(project_id,user_id,updated_at);

CREATE INDEX IF NOT EXISTS idx_project_messages_conversation
  ON project_messages(conversation_id,created_at);

CREATE INDEX IF NOT EXISTS idx_project_messages_project
  ON project_messages(project_id,user_id,created_at);
