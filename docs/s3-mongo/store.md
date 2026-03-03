# pingora-s3-mongo｜Mongo Store（資料模型）

對應檔案：`pingora-s3-mongo/src/store.rs`

## Bucket / Collection mapping
- `MongoS3Store::collection(bucket)` → `db.collection::<Document>(bucket)`
- bucket list：`list_bucket_names()` 會過濾：
  - `system.*`
  - credential collection（預設 `s3_credential`）

## Bucket existence cache
- `bucket_cache: HashMap<bucket, (exists: bool, ts: Instant)>`
- TTL：`BUCKET_CACHE_TTL = 60s`
- `bucket_exists()`：先查 cache（未過期直接回），否則 `list_collection_names({name: bucket})`

## Object document schema（put_object）
`put_object(bucket, key, body, content_type, tags)` 會 upsert：
- `_id` / `key`: key
- `body`: Mongo `Binary`
- `content_type`: string
- `content_length`: i64
- `etag`: md5(body)
- `last_modified`: DateTime
- `tags`: Document

## 常用 API（後續要 trace）
- `get_object()`：find_one by `_id`
- `get_object_metadata()`：projection 排除 `body`
- `delete_object()`
- `list_objects(prefix, continuation_token, max_keys)`：
  - prefix 用 regex (`mongo_prefix_regex(prefix)`) 
  - continuation_token 用 `_id > token`
  - sort `_id` asc；limit `max_keys + 1`（用來判斷 IsTruncated）

下一步：補上 `app.rs` 如何把 S3 的 list params（prefix/continuation-token/max-keys）映射到 `list_objects()`。
