-- NKJJEAN STUDIO — migration additive 0003
-- Catalogue de cours/autres contenus et fichiers de publication.
-- Cette migration ajoute des tables ; elle ne supprime ni ne réinitialise aucune donnée existante.

PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS published_resources (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  resource_type TEXT NOT NULL CHECK (resource_type IN ('course','content')),
  title TEXT NOT NULL,
  slug TEXT NOT NULL UNIQUE,
  description TEXT NOT NULL DEFAULT '',
  category TEXT NOT NULL DEFAULT 'Autres',
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','pending_review','published','rejected','suspended')),
  rejection_reason TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  published_at TEXT,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_published_resources_public
  ON published_resources(status,resource_type,published_at);
CREATE INDEX IF NOT EXISTS idx_published_resources_owner
  ON published_resources(user_id,status,created_at);

CREATE TABLE IF NOT EXISTS resource_files (
  id TEXT PRIMARY KEY,
  resource_id TEXT NOT NULL,
  file_name TEXT NOT NULL,
  mime_type TEXT NOT NULL,
  file_size INTEGER NOT NULL CHECK (file_size > 0),
  object_key TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL DEFAULT 'pending_review' CHECK (status IN ('pending_review','approved','rejected')),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  FOREIGN KEY (resource_id) REFERENCES published_resources(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_resource_files_resource ON resource_files(resource_id,status);

CREATE TABLE IF NOT EXISTS app_release_files (
  id TEXT PRIMARY KEY,
  app_id TEXT NOT NULL,
  version_name TEXT NOT NULL,
  version_code INTEGER NOT NULL CHECK (version_code > 0),
  file_name TEXT NOT NULL,
  mime_type TEXT NOT NULL DEFAULT 'application/vnd.android.package-archive',
  file_size INTEGER NOT NULL CHECK (file_size > 0),
  changelog TEXT NOT NULL DEFAULT '',
  object_key TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL DEFAULT 'pending_review' CHECK (status IN ('pending_review','approved','rejected')),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  approved_at TEXT,
  FOREIGN KEY (app_id) REFERENCES published_apps(id) ON DELETE CASCADE,
  UNIQUE(app_id,version_code)
);

CREATE INDEX IF NOT EXISTS idx_app_release_files_public ON app_release_files(app_id,status,version_code);
CREATE TABLE IF NOT EXISTS resource_reviews (
  id TEXT PRIMARY KEY,
  resource_id TEXT NOT NULL,
  reviewed_by TEXT NOT NULL,
  decision TEXT NOT NULL CHECK (decision IN ('approved','rejected','suspended')),
  comment TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  FOREIGN KEY (resource_id) REFERENCES published_resources(id) ON DELETE CASCADE,
  FOREIGN KEY (reviewed_by) REFERENCES users(id)
);
CREATE INDEX IF NOT EXISTS idx_resource_reviews_resource ON resource_reviews(resource_id,created_at);
