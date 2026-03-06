# pingora-s3-mongo：app.rs request routing / bucket+key 解析 / store API 對應

本篇聚焦 `pingora-s3-mongo/src/app.rs` 的「入口 dispatch → 解析 bucket/key → 依 method/query 分流 → 呼叫 MongoS3Store」整體路徑。

> 目標：快速定位「一個 HTTP request 進來後，到底會走到哪個 handler、怎麼判斷 bucket/key、最後呼叫到 store 的哪個 API」。

---

## 1) 入口：`S3MongoApp::dispatch()`

核心流程（簡化）：

1. 讀取 request 基本欄位：
   - `method`：轉大寫後比對（`GET/HEAD/PUT/DELETE/POST`）
   - `path`：`req.uri.path()`
   - `query`：`req.uri.query().unwrap_or("")`
   - `host` header：用於 virtual-host style bucket
2. `parse_bucket_and_key(path, host)` 解析出：
   - `bucket: Option<String>`
   - `key: Option<String>`
3. bucket 名稱合法性檢查：`is_valid_bucket_name()`（不合法回 `InvalidBucketName`）
4. 認證：`self.authenticate(req, bucket.as_deref())`
   - 對應 `auth.rs` 的 SigV4 驗證與 `CredentialCache`
5. 依 `method + query` 分流到各 handler。

### method/query 分流規則

`dispatch()` 的 match 邏輯（抓大方向）：

- `GET`
  - `bucket=None` → `list_buckets()`（列出 buckets）
  - `?tagging` → `get_object_tagging(bucket, key)`（需要 key）
  - `key=None` → `list_objects(bucket, query)`
  - `key=Some` → `get_object(bucket, key)`

- `HEAD`
  - `key=None` → `head_bucket(bucket)`
  - `key=Some` → `head_object(bucket, key)`

- `PUT`
  - `?tagging` → `handle_put_tagging(bucket, key, http_stream)`
  - `key=None` → `create_bucket(bucket)`
  - `key=Some` → `put_object(bucket, key, http_stream)`

- `DELETE`
  - `?tagging` → `handle_delete_tagging(bucket, key)`
  - `key=None` → `delete_bucket(bucket)`
  - `key=Some` → `delete_object(bucket, key)`

- `POST`
  - `?delete` → `handle_delete_objects(bucket, http_stream)`（S3 multi-delete）
  - else → `MethodNotAllowed`

`query_has_key(query, "tagging"|"delete")` 使用 `url::form_urlencoded::parse` 去掃參數 key 是否存在（不看 value）。

---

## 2) bucket/key 解析：`parse_bucket_and_key(path, host)`

回傳 `(Option<bucket>, Option<key>)`。

### (A) 優先：Virtual-host style

以 `bucket.example.com` 這種格式為主：

- 先去掉 host 可能的 port：`host.split(':').next()`
- 如果 `host_without_port.split_once('.')` 能切出第一段 `bucket`
- 且 bucket 非空、不是 `localhost`、且 host 不是 IPv4 literal（`is_ipv4_host()`）

則：
- `bucket = Some(bucket)`
- `key` 取 path 去掉前導 `/` 後的剩餘字串（若空則 None）

### (B) 其次：Path style

例如：`/mybucket/a/b/c`：

- 去掉前導 `/` 得 `trimmed`
- `trimmed.splitn(2, '/')`
  - 第一段當 bucket
  - 剩下當 key（可能含 `/`）

### (C) URL decode：`decode_path_component()`

bucket 與 key 都會透過：

- `percent_encoding::percent_decode_str(raw).decode_utf8_lossy()`

做 percent-decoding。

> 這代表路徑中 `%2F` 之類的編碼會被解出來；但注意這種 decode 可能會讓「原本以 `/` 分段的語意」變得微妙（例如 `%2F` 變成 `/`）。目前程式邏輯是：先 split bucket/key，再對 bucket_raw 與 key raw 各自 decode。

---

## 3) 解析結果如何影響後續行為

- `bucket=None`
  - `GET`：列 buckets（類似 `GET /`）
  - 其他 method：多數會回 `InvalidURI`（要求 bucket 必須存在）

- `bucket=Some, key=None`
  - `GET`：list objects（bucket root）
  - `HEAD`：head bucket
  - `PUT`：create bucket
  - `DELETE`：delete bucket

- `bucket=Some, key=Some`
  - `GET/HEAD/PUT/DELETE`：object 級操作
  - `?tagging`：object tagging（PUT/GET/DELETE tagging）

---

## 4) 與 `MongoS3Store` 的對應（store API mapping）

以「handler 會呼叫到 store 的哪個方法」來記：

- buckets
  - list buckets：`MongoS3Store::list_bucket_names()`
  - bucket exists：`MongoS3Store::bucket_exists(bucket)`（也用在錯誤路徑判斷）
  - create bucket：`MongoS3Store::create_bucket(bucket)`
  - delete bucket：`MongoS3Store::drop_bucket(bucket)`
  - bucket object count：`MongoS3Store::bucket_object_count(bucket)`（常用於刪 bucket 前判斷是否為空）

- objects
  - put object：`MongoS3Store::put_object(bucket, key, body, content_type, tags)`
  - get object（含 body）：`MongoS3Store::get_object(bucket, key)`
  - head object（只 metadata）：`MongoS3Store::get_object_metadata(bucket, key)`
  - delete object：`MongoS3Store::delete_object(bucket, key)`
  - list objects：`MongoS3Store::list_objects(bucket, prefix, continuation_token, max_keys)`

- tagging
  - put tagging：`MongoS3Store::update_tags(bucket, key, tags)`
  - delete tagging：`MongoS3Store::clear_tags(bucket, key)`

> tagging 的存在讓 `PUT/DELETE` 在 `?tagging` 時走到完全不同的 handler；而這些 handler 會先更新/清除 tags，若更新失敗還會再去 `bucket_exists()` 區分是 NoSuchBucket 或 NoSuchKey。

---

## 5) request flow（以 handler 為單位，從 request → store → response）

這段把 `app.rs` 各 handler 的「判斷條件、store 呼叫、常見錯誤分支、回應格式」補齊，讓你能快速追一個 API 在 code 裡到底怎麼走。

### 5.1 ListBuckets：`GET /`（bucket=None）

入口：`handle_get(bucket=None)` → `list_buckets(allowed_buckets)`

- store：
  - `MongoS3Store::list_bucket_names()`
  - 然後 `retain()` 只保留 `auth.allowed_buckets` 內的 bucket（ACL 粗粒度：bucket 名稱白名單）
- response：
  - `200 OK` + XML（`render_list_buckets_result()`）

### 5.2 CreateBucket：`PUT /{bucket}`（key=None）

入口：`handle_put(bucket=Some, key=None)` → `create_bucket(bucket)`

- 如果已存在：
  - `bucket_exists(bucket)=true` → `409 Conflict`：`BucketAlreadyOwnedByYou`
- 否則：
  - `create_bucket(bucket)`
  - response：`200 OK`（empty body）

### 5.3 HeadBucket：`HEAD /{bucket}`（key=None）

入口：`handle_head(bucket=Some, key=None)` → `head_bucket(bucket)`

- `bucket_exists(bucket)=true` → `200 OK`（empty）
- 否則 → `404 Not Found`（empty；此處沒有回 S3 XML error）

### 5.4 DeleteBucket：`DELETE /{bucket}`（key=None）

入口：`handle_delete(bucket=Some, key=None)` → `delete_bucket(bucket)`

- bucket 不存在：`bucket_exists=false` → `404`：`NoSuchBucket`
- bucket 非空：`bucket_object_count(bucket)>0` → `409`：`BucketNotEmpty`
- 否則：`drop_bucket(bucket)` → `204 No Content`

### 5.5 PutObject：`PUT /{bucket}/{key...}`（含 optional `x-amz-tagging` header）

入口：`handle_put(bucket=Some, key=Some)` → `put_object(bucket, key, http_stream)`

- request body：`read_full_body()`（一次讀滿；不是 streaming upload）
- content-type：
  - 讀 header `content-type`；缺省 `application/octet-stream`
- tags（header 版）：
  - 若有 `x-amz-tagging: k1=v1&k2=v2` → `parse_tagging_query()` 轉 `Document`
- store：
  - `put_object(bucket, key, body, content_type, tags)` → 回 `etag`
- response：
  - `200 OK` + header `ETag: "{etag}"`

### 5.6 GetObject：`GET /{bucket}/{key...}`

入口：`handle_get(bucket=Some, key=Some, query 無 tagging)` → `get_object(bucket, key)`

- store：`get_object(bucket, key)`
  - Some(obj) → `object_response(obj, head_only=false)`
  - None → 進一步用 `bucket_exists(bucket)` 區分錯誤
- error：
  - bucket 不存在 → `404`：`NoSuchBucket`
  - bucket 存在但 key 不存在 → `404`：`NoSuchKey`

### 5.7 HeadObject：`HEAD /{bucket}/{key...}`

入口：`handle_head(bucket=Some, key=Some)` → `head_object(bucket, key)`

- store：`get_object_metadata(bucket, key)`
  - Some(obj) → `object_response(obj, head_only=true)`（只回 metadata headers，不回 body）
  - None → `404 Not Found`（empty；同 head_bucket，這裡也沒有回 S3 XML error）

### 5.8 DeleteObject：`DELETE /{bucket}/{key...}`

入口：`handle_delete(bucket=Some, key=Some)` → `delete_object(bucket, key)`

- store：`delete_object(bucket, key)` → 回 bool deleted
- error 分支（只在「未刪到」時額外檢查 bucket 是否存在）：
  - `!deleted && !bucket_exists(bucket)` → `404`：`NoSuchBucket`
- response：
  - 其餘情況（包含 key 本來就不存在）→ `204 No Content`

> 註：這個行為偏向「DELETE idempotent」：key 不存在也回 204（但 bucket 不存在會回錯）。

### 5.9 ListObjects（ListObjectsV2-like）：`GET /{bucket}?prefix=&continuation-token=&max-keys=`

入口：`handle_get(bucket=Some, key=None)` → `list_objects(bucket, query)`

- query params：
  - `prefix`（default ""）
  - `continuation-token`（Option）
  - `max-keys`：parse usize；<=0 視為 default；並 cap 到 `DEFAULT_MAX_KEYS=1000`
- store：`list_objects(bucket, prefix, continuation, max_keys)` → `ListPage`
- bucket 不存在的判斷：
  - 只有在 `page.objects.is_empty()` 時才會再去 `bucket_exists()`
  - 若 objects 空且 bucket 不存在 → `404`：`NoSuchBucket`
- response：`200 OK` + XML（`render_list_objects_result()`）

### 5.10 Object Tagging（XML body 版）：`?tagging`

#### a) PutObjectTagging：`PUT /{bucket}/{key}?tagging`

入口：`dispatch(PUT + tagging)` → `handle_put_tagging(bucket, key, http_stream)`

- request body：`read_full_body()`
- parse：`parse_tagging_xml()`（失敗 → `400 MalformedXML`）
- store：`update_tags(bucket, key, tags)` → bool updated
- updated=false 時的區分：
  - `!bucket_exists(bucket)` → `404 NoSuchBucket`
  - 否則 → `404 NoSuchKey`
- response：`200 OK`（empty）

#### b) GetObjectTagging：`GET /{bucket}/{key}?tagging`

入口：`handle_get(query has tagging)` → `get_object_tagging(bucket, key)`

- store：`get_tags(bucket, key)`
  - Some(tags) → `200 OK` + XML（`render_get_tagging_result()`）
  - None → 用 `bucket_exists()` 區分 `NoSuchBucket` vs `NoSuchKey`

#### c) DeleteObjectTagging：`DELETE /{bucket}/{key}?tagging`

入口：`dispatch(DELETE + tagging)` → `handle_delete_tagging(bucket, key)`

- store：`clear_tags(bucket, key)` → bool updated
- updated=false：同上，用 `bucket_exists()` 區分 bucket/key
- response：`204 No Content`

### 5.11 Multi-Delete：`POST /{bucket}?delete`（XML body）

入口：`dispatch(POST + delete)` → `handle_delete_objects(bucket, http_stream)`

- 前置檢查：`bucket_exists(bucket)`；不存在 → `404 NoSuchBucket`
- request body：`read_full_body()`
- parse：`parse_delete_objects_xml()`（失敗 → `400 MalformedXML`）
- store：`delete_objects(bucket, keys)`
- response：`200 OK` + XML（`render_delete_objects_result()`）

---

## 6) 後續可追的點（下次讀碼方向）

- `object_response()` 實際會塞哪些 headers（`ETag`、`Last-Modified`、`Content-Type`、`Content-Length`）以及 `StoredObject` 欄位如何映射。
- `read_full_body()` 對大物件/長連線的風險：是否有 size cap、timeout、背壓（目前看起來是一次讀滿）。
- ListObjects 的 bucket existence check 條件：目前只有在「回來空頁」才檢查 bucket 存不存在；若 bucket 存在但 prefix 下沒有物件 vs bucket 不存在，兩者都可能回 empty page，但 code 用 `bucket_exists()` 區分（要看 store.list_objects 的回傳特性）。
- path decode 對 `%2F` 的影響：S3 key 本質上允許任意字元（包含 `/`），但 HTTP path 的 split 會先決定 bucket/key 邊界；目前設計偏向「先 split 再 decode」。
