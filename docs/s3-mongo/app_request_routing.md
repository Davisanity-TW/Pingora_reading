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

## 5) 後續可追的點（下次讀碼方向）

- `list_objects(bucket, query)` 內對 S3 ListObjectsV2 參數的支援度（`prefix`, `continuation-token`, `max-keys` 等）怎麼映射到 Mongo 查詢（見 `store.rs::list_objects`）。
- `put_object()` 對 content-type / content-length / streaming 行為：目前是 `read_full_body()` 一次讀完（大物件可能需要注意）。
- path decode 對 `%2F` 的影響：S3 key 本質上允許任意字元（包含 `/` 作為名稱的一部分），但 HTTP path 分段會造成語意差異；目前設計偏向「先以 `/` 決定 bucket/key 的邊界」。
