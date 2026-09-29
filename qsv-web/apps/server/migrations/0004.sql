CREATE TABLE user_settings (
  owner_key TEXT PRIMARY KEY,
  settings_json TEXT NOT NULL CHECK(json_valid(settings_json) AND length(settings_json) <= 4096),
  updated_at INTEGER NOT NULL
) WITHOUT ROWID;
