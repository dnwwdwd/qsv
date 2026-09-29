CREATE TABLE IF NOT EXISTS app_limits (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  limits_json TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);
