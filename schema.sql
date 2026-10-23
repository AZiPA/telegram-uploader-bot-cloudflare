CREATE TABLE IF NOT EXISTS bundles (
  code TEXT PRIMARY KEY,
  title TEXT DEFAULT NULL,
  items TEXT NOT NULL DEFAULT '[]',
  created_by INTEGER NOT NULL,
  protect_content INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  owner_locked INTEGER NOT NULL DEFAULT 0,
  expires_at INTEGER NOT NULL DEFAULT 0,
  is_one_time INTEGER NOT NULL DEFAULT 0,
  consumed_by INTEGER NOT NULL DEFAULT 0,
  passcode_hash TEXT DEFAULT NULL,
  post_channel_id TEXT DEFAULT NULL,
  post_message_id INTEGER NOT NULL DEFAULT 0,
  rotate_interval_sec INTEGER NOT NULL DEFAULT 0,
  last_rotated_at INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_bundles_search ON bundles(title) WHERE title IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_bundles_rotation ON bundles(last_rotated_at) WHERE rotate_interval_sec > 0 AND post_channel_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_bundles_creator ON bundles(created_by);

CREATE TABLE IF NOT EXISTS admin_sessions (
  admin_id INTEGER PRIMARY KEY,
  code TEXT NOT NULL,
  mode TEXT CHECK(mode IN ('upload', 'batch', 'edit')),
  items TEXT NOT NULL DEFAULT '[]',
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS bundle_votes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  code TEXT NOT NULL,
  user_id INTEGER NOT NULL,
  vote_type TEXT CHECK(vote_type IN ('like', 'dislike')),
  created_at INTEGER NOT NULL,
  UNIQUE(code, user_id)
);

CREATE TABLE IF NOT EXISTS deletion_queue (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  chat_id INTEGER NOT NULL,
  message_ids TEXT NOT NULL,
  delete_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS admins (
  user_id INTEGER PRIMARY KEY,
  added_by INTEGER NOT NULL,
  role TEXT NOT NULL DEFAULT 'admin' CHECK(role IN ('admin', 'superadmin', 'owner')),
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS vips (
  user_id INTEGER PRIMARY KEY,
  added_by INTEGER NOT NULL,
  expires_at INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS user_quotas (
  user_id INTEGER PRIMARY KEY,
  downloads_today INTEGER DEFAULT 0,
  last_download_date TEXT NOT NULL,
  last_request_at INTEGER NOT NULL DEFAULT 0,
  strikes INTEGER DEFAULT 0,
  banned_until INTEGER DEFAULT 0
);

CREATE TABLE IF NOT EXISTS user_downloads (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  code TEXT NOT NULL,
  access_date TEXT NOT NULL,
  download_count INTEGER DEFAULT 1,
  UNIQUE(user_id, code, access_date)
);

CREATE TABLE IF NOT EXISTS system_config (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS force_channels (
  channel_id TEXT PRIMARY KEY,
  channel_name TEXT NOT NULL,
  button_text TEXT DEFAULT '',
  invite_link TEXT NOT NULL,
  target_limit INTEGER DEFAULT 0,
  is_active INTEGER DEFAULT 1,
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_deletion_delete_at ON deletion_queue(delete_at);
CREATE INDEX IF NOT EXISTS idx_user_downloads_date_code ON user_downloads(access_date, code);
CREATE INDEX IF NOT EXISTS idx_user_downloads_user_date ON user_downloads(user_id, access_date);
CREATE INDEX IF NOT EXISTS idx_user_downloads_code ON user_downloads(code, download_count);
CREATE INDEX IF NOT EXISTS idx_vips_expires ON vips(expires_at);

DROP TRIGGER IF EXISTS trg_user_downloads_limit_insert;
DROP TRIGGER IF EXISTS trg_user_downloads_limit_update;

CREATE TRIGGER trg_user_downloads_limit_insert
BEFORE INSERT ON user_downloads
BEGIN
  SELECT RAISE(ABORT, 'daily_download_limit')
  WHERE NOT EXISTS (SELECT 1 FROM admins WHERE user_id = NEW.user_id)
    AND NOT EXISTS (SELECT 1 FROM vips WHERE user_id = NEW.user_id AND (expires_at = 0 OR expires_at > CAST(strftime('%s', 'now') AS INTEGER)))
    AND (
      SELECT COALESCE(SUM(download_count), 0)
      FROM user_downloads
      WHERE user_id = NEW.user_id
        AND access_date = NEW.access_date
    ) + NEW.download_count >
      COALESCE(
        (SELECT CAST(value AS INTEGER)
         FROM system_config
         WHERE key = 'daily_download_limit'),
        10
      );
END;

CREATE TRIGGER trg_user_downloads_limit_update
BEFORE UPDATE OF download_count ON user_downloads
BEGIN
  SELECT RAISE(ABORT, 'daily_download_limit')
  WHERE NOT EXISTS (SELECT 1 FROM admins WHERE user_id = NEW.user_id)
    AND NOT EXISTS (SELECT 1 FROM vips WHERE user_id = NEW.user_id AND (expires_at = 0 OR expires_at > CAST(strftime('%s', 'now') AS INTEGER)))
    AND (
      SELECT COALESCE(SUM(download_count), 0)
      FROM user_downloads
      WHERE user_id = NEW.user_id
        AND access_date = NEW.access_date
        AND id <> OLD.id
    ) + NEW.download_count >
      COALESCE(
        (SELECT CAST(value AS INTEGER)
         FROM system_config
         WHERE key = 'daily_download_limit'),
        10
      );
END;

-- System Defaults
INSERT OR IGNORE INTO system_config (key, value) VALUES
  ('maintenance_mode', '0'),
  ('daily_download_limit', '10'),
  ('file_daily_limit', '3'),
  ('auto_delete_seconds', '0'),
  ('default_language', 'en'),
  ('global_protect_content', '0'),
  ('default_bundle_ttl_seconds', '0'),
  ('publish_channel_id', '');