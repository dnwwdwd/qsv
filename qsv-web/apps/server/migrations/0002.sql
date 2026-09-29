CREATE UNIQUE INDEX resources_upload_key
ON resources(owner_key, json_extract(metadata_json, '$.uploadKey'))
WHERE kind = 'raw' AND json_extract(metadata_json, '$.uploadKey') IS NOT NULL;
