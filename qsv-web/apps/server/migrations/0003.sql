CREATE TABLE compare_annotations (
  owner_key TEXT NOT NULL,
  result_id TEXT NOT NULL,
  detail_row INTEGER NOT NULL CHECK(detail_row > 0),
  status TEXT NOT NULL CHECK(status IN ('pending','verified','ignored')),
  note TEXT NOT NULL DEFAULT '',
  updated_at INTEGER NOT NULL,
  PRIMARY KEY(owner_key, result_id, detail_row)
) WITHOUT ROWID;
CREATE INDEX compare_annotations_status ON compare_annotations(owner_key, result_id, status, detail_row);
