CREATE TABLE resources (
  id TEXT PRIMARY KEY,
  owner_key TEXT NOT NULL,
  kind TEXT NOT NULL CHECK(kind IN ('raw','dataset','report','export','view')),
  status TEXT NOT NULL CHECK(status IN ('staging','building','ready','failed','trashed')),
  name TEXT NOT NULL,
  format TEXT NOT NULL,
  group_id TEXT NOT NULL,
  version INTEGER NOT NULL CHECK(version > 0),
  source_ids_json TEXT NOT NULL DEFAULT '[]' CHECK(json_valid(source_ids_json)),
  producer_job_id TEXT,
  storage_relpath TEXT,
  content_hash TEXT,
  byte_size INTEGER CHECK(byte_size IS NULL OR byte_size >= 0),
  row_count INTEGER CHECK(row_count IS NULL OR row_count >= 0),
  column_count INTEGER CHECK(column_count IS NULL OR column_count >= 0),
  metadata_json TEXT NOT NULL DEFAULT '{}' CHECK(json_valid(metadata_json)),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  deleted_at INTEGER,
  UNIQUE(owner_key, group_id, version)
);
CREATE INDEX resources_owner_list ON resources(owner_key, kind, status, updated_at DESC);
CREATE INDEX resources_producer ON resources(owner_key, producer_job_id);

CREATE TABLE jobs (
  id TEXT PRIMARY KEY,
  owner_key TEXT NOT NULL,
  kind TEXT NOT NULL,
  name TEXT NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('draft','queued','running','cancel_requested','cancelled','succeeded','failed','interrupted')),
  priority INTEGER NOT NULL DEFAULT 0,
  parent_job_id TEXT,
  retry_of TEXT,
  input_ids_json TEXT NOT NULL DEFAULT '[]' CHECK(json_valid(input_ids_json)),
  spec_json TEXT NOT NULL CHECK(json_valid(spec_json)),
  spec_hash TEXT NOT NULL,
  engine_version TEXT NOT NULL,
  idempotency_key TEXT,
  progress_json TEXT NOT NULL DEFAULT '{}' CHECK(json_valid(progress_json)),
  summary_json TEXT NOT NULL DEFAULT '{}' CHECK(json_valid(summary_json)),
  error_json TEXT CHECK(error_json IS NULL OR json_valid(error_json)),
  work_relpath TEXT NOT NULL,
  event_seq INTEGER NOT NULL DEFAULT 0,
  heartbeat_at INTEGER,
  created_at INTEGER NOT NULL,
  started_at INTEGER,
  finished_at INTEGER,
  updated_at INTEGER NOT NULL,
  UNIQUE(owner_key, idempotency_key)
);
CREATE INDEX jobs_owner_list ON jobs(owner_key, created_at DESC);
CREATE INDEX jobs_queue ON jobs(state, priority DESC, created_at) WHERE state IN ('queued','running','cancel_requested');
CREATE INDEX jobs_parent ON jobs(owner_key, parent_job_id);

CREATE TABLE recipes (
  id TEXT PRIMARY KEY,
  owner_key TEXT NOT NULL,
  family_id TEXT NOT NULL,
  version INTEGER NOT NULL CHECK(version > 0),
  kind TEXT NOT NULL CHECK(kind IN ('pipeline','compare','validate','sql','transform')),
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  spec_json TEXT NOT NULL CHECK(json_valid(spec_json)),
  parameter_schema TEXT NOT NULL DEFAULT '{}' CHECK(json_valid(parameter_schema)),
  compatibility_json TEXT NOT NULL DEFAULT '{}' CHECK(json_valid(compatibility_json)),
  is_current INTEGER NOT NULL DEFAULT 1 CHECK(is_current IN (0,1)),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  deleted_at INTEGER,
  UNIQUE(owner_key, family_id, version)
);
CREATE UNIQUE INDEX recipes_current ON recipes(owner_key, family_id) WHERE is_current = 1 AND deleted_at IS NULL;
CREATE INDEX recipes_owner_list ON recipes(owner_key, kind, updated_at DESC);
