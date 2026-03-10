# pingora-s3-mongo：app.rs request routing / bucket+key 解析 / store API 對應

本篇聚焦 `pingora-s3-mongo/src/app.rs` 的「入口 dispatch → 解析 bucket/key → 依 method/query 分流 → 呼叫 MongoS3Store」整體路徑。

> 目標：快速定位「一個 HTTP request 進來後，到底會走到哪個 handler、怎麼判斷 bucket/key、最後呼叫到 store 的哪個 API」。

---

## 0) 最外層入口：Pingora listener → `ServeHttp::response()` → `dispatch()`

在 pingora-s3-mongo 這個 binary 裡，HTTP request 進來後會由 Pingora 的 HTTP server 驅動，最後呼叫到 `S3MongoApp` 對 `pingora::apps::http_app::ServeHttp` 的實作：

- 入口函式：`impl ServeHttp for S3MongoApp { async fn response(&self, http_stream: &mut ServerSession) -> Response<Vec<u8>> }`
- 這裡做了兩件事：
  1) 建立 request context（for access log）：`AccessLogCtx::from_request(http_stream)`
  2) 呼叫真正的路由/處理邏輯：`self.dispatch(http_stream).await`

### 入口到 access log：一個 request 的 end-to-end 時序（精簡版）

用 `ServeHttp::response()` 看整體：

1. **建立 log context（不會 fail request）**：`AccessLogCtx::from_request(http_stream)`
2. **開始計時**：`let req_start = Instant::now()`
3. **進入主要處理**：`self.dispatch(http_stream).await`
   - 多數「預期的 S3 錯誤」是 handler 直接 `Ok(s3_error(...))` 回來（例如 NoSuchBucket/InvalidBucketName）。
   - 只有「非預期錯誤」才用 `Err(String)` 往上冒，最後被包成 `InternalError(500)`。
4. **統一寫 access log**：計算 `status/response_size/latency` → `log_access(&req_ctx, rp_status, rp_sz, response_time)`
5. **回應 client**：把 `Response<Vec<u8>>` 交回 Pingora。

> 這也意味著：就算某個 request 最後被拒絕（403）或打成 S3 error（4xx/5xx），**只要成功產生 Response**，都會有一筆 `info!` access log；只有程式 panic 或更底層連線問題才可能沒有。

### request context（AccessLogCtx）是怎麼建立的？

`AccessLogCtx::from_request()` 會從 `ServerSession`/`RequestHeader` 抽出：

- client 來源 IP：`http_stream.client_addr()`（Inet/Unix）
- method + path/query：`req_header.method` + `req_header.uri.path_and_query()`
- user-agent：只取空白前第一段（`split(' ').next()`）
- request size：取 `content-length` header（沒有就 0）
- user（access key）：`extract_credential()` → `short_credential()`（取縮短版，避免 log 太長）
- bucket：再次呼叫 `parse_bucket_and_key(path, host)` 取 bucket（取不到就 `-`）
- act_grp：用 `classify_act_grp(method, query, bucket.is_none())` 粗分 GET/PUT/DELETE 等類別（給 access log 用）

### `dispatch()` 失敗時的最外層錯誤路徑

`dispatch()` 回傳型別是 `Result<Response<Vec<u8>>, String>`。

- `Ok(resp)`：原樣回應給 client
- `Err(err_string)`：
  - log：`error!("s3-mongo request failed: {err}")`
  - 回應：`500 InternalServerError` + S3 XML error：
    - Code：`InternalError`
    - Message：`We encountered an internal error. Please try again.`

> 也就是說：只要 handler/store 任何地方回 `Err(String)` 冒出來，最後都會被統一包成 `InternalError(500)`；而「有意識的 S3 錯誤碼」通常都是 handler 直接 `Ok(s3_error(...))` 回來的。

補充：在 `app.rs` 這個層級，多數「會變成 `Err(String)`」的來源是：

- `read_full_body(http_stream).await?`（讀 body 失敗/超時等）
- `self.store.*(...).await?`（MongoS3Store 任一操作回 Err）

相對地，XML parse（tagging / multi-delete）是用 `match` 包住，parse 失敗會走 `Ok(s3_error(400 MalformedXML ...))`，不會冒 `Err(String)`。

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

#### 分流優先序的小提醒（對 debug/相容性很重要）

- **bucket/key 解析與 bucket 名稱合法性檢查在 auth 之前**：
  - `parse_bucket_and_key()` → `is_valid_bucket_name()` 先跑
  - bucket 不合法會直接回 `400 InvalidBucketName`，甚至不會進 `authenticate_request()`
  - 代表你用沒帶憑證的 request 也能觀察到「bucket 名稱格式」是否會被 accept（這是行為特徵，不一定是你想要的安全性）。

- **`PUT`/`DELETE` 的 `?tagging` 會先被吃掉**：
  - `PUT`：先判斷 `?tagging` → `handle_put_tagging()`，否則才看 `key` 是不是 None（create bucket）
  - `DELETE`：同理先判斷 `?tagging` → `handle_delete_tagging()`
  - 所以 `PUT /bucket?tagging` 會走 tagging 邏輯並回 `InvalidRequest`（缺 key），不會走 create bucket。

- **`POST` 目前只支援 `?delete`（multi-delete）**：
  - 其他 `POST` 一律 `405 MethodNotAllowed`（empty body）


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

### (D) bucket 名稱檢查：`is_valid_bucket_name()`

`dispatch()` 在成功解析到 `bucket=Some(name)` 後，會先做 bucket 名稱合法性檢查，不合法直接回：

- `400 BadRequest` / `InvalidBucketName`

實作規則（偏 S3 bucket naming 風格，但有一些自訂限制）：

- 長度：`3..=63`
- **只允許小寫**字母、數字、`-`、`.`
- 首尾必須是英數（不能以 `-` 或 `.` 開頭/結尾）
- 不允許 `..`
- 額外保留／禁止：
  - bucket 不能以 `system.` 開頭
  - bucket 不能包含 `$`

> 這個檢查對 debug 很重要：如果你在本機測 `Bucket-A`（含大寫）或 `aa`（太短），你會在 dispatch 的很早期就被擋下來，甚至不會進到 auth / store。

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

## 5.x) 主要 error path / HTTP status mapping（從 app.rs 直接整理）

> 目的：用「看到某個 status 或 S3 Code」就能快速回推是哪個分支打出來的。

### A) `dispatch()` 前段就會擋掉的錯

- bucket 名稱不合法（`is_valid_bucket_name()`）
  - `400 BadRequest`
  - Code：`InvalidBucketName`
  - Message：`The specified bucket is not valid.`

### B) auth 錯誤（`authenticate_request()` → `S3MongoApp::authenticate()`）

全部都是 `403 Forbidden`，差別在 S3 Code：

- `MissingAuthorization` → `AccessDenied`（`Access Denied.`）
- `InvalidAccessKeyId` → `InvalidAccessKeyId`
- `AccessDenied` → `AccessDenied`
- `SignatureDoesNotMatch` → `SignatureDoesNotMatch`

> 注意：在 `dispatch()` 一開始就會先把 bucket（若有）傳進 auth；因此「bucket 白名單」這種 bucket-level ACL 很可能在 auth 層就已經做掉（要看 `auth.rs`）。

### C) bucket/key 缺失造成的 `InvalidURI` / `InvalidRequest`

- bucket 必須存在（但 client 沒帶 bucket）：
  - `HEAD/PUT/DELETE` 若 `bucket=None`：`400 InvalidURI`（`Bucket must be provided.`）
- tagging 需要 key：
  - `GET ?tagging` 但 `key=None`：`400 InvalidRequest`（`Object tagging requires a key.`）
  - `PUT/DELETE ?tagging` 但 `key=None`：同上

### D) 常見的 NoSuchBucket / NoSuchKey

- `GET Object`：
  - 找不到物件時會再查 bucket 是否存在，回：
    - `404 NoSuchBucket` 或 `404 NoSuchKey`
- `GET Tagging`：同上（用 `bucket_exists()` 區分）
- `PUT Tagging` / `DELETE Tagging`：
  - store 回 updated=false 時，用 `bucket_exists()` 區分回 `NoSuchBucket` / `NoSuchKey`
- `POST ?delete`（Multi-Delete）：
  - 一開始就先 `bucket_exists()`，不存在直接 `404 NoSuchBucket`

### E) 409 類（Conflict）

- CreateBucket：
  - bucket 已存在 → `409 BucketAlreadyOwnedByYou`
- DeleteBucket：
  - bucket 裡還有 object（`bucket_object_count>0`）→ `409 BucketNotEmpty`

### F) `HEAD` 系列的 404 特例（不是 S3 XML error）

- `HEAD /{bucket}`：bucket 不存在 → `404` empty body（`head_bucket()` 直接 `empty_response(404)`）
- `HEAD /{bucket}/{key}`：metadata 不存在 → `404` empty body（`head_object()` 直接 `empty_response(404)`）

> 這點跟其他 API「盡量回 S3 XML error」不一致，實務上 debug 時要特別小心。

### G) 400 MalformedXML

- `PUT ?tagging`：tagging XML parse 失敗 → `400 MalformedXML`
- `POST ?delete`：multi-delete XML parse 失敗 → `400 MalformedXML`

### H) 405 MethodNotAllowed

- `POST` 但 query 沒 `delete`（以及其他不支援 method）→ `405` empty body

### I) 500 InternalError（最外層兜底）

- 只要 `dispatch()` 回 `Err(String)`，最外層 `ServeHttp::response()` 會統一回：
  - `500 InternalError`（S3 XML error）

---

## 6) 後續可追的點（下次讀碼方向）

- `object_response()` 實際會塞哪些 headers（`ETag`、`Last-Modified`、`Content-Type`、`Content-Length`）以及 `StoredObject` 欄位如何映射。
- `read_full_body()` 對大物件/長連線的風險：是否有 size cap、timeout、背壓（目前看起來是一次讀滿）。
- ListObjects 的 bucket existence check 條件：目前只有在「回來空頁」才檢查 bucket 存不存在；若 bucket 存在但 prefix 下沒有物件 vs bucket 不存在，兩者都可能回 empty page，但 code 用 `bucket_exists()` 區分（要看 store.list_objects 的回傳特性）。
- path decode 對 `%2F` 的影響：S3 key 本質上允許任意字元（包含 `/`），但 HTTP path 的 split 會先決定 bucket/key 邊界；目前設計偏向「先 split 再 decode」。

### (A-1) Virtual-host style 的幾個實作細節／陷阱

補幾個從程式碼直接讀到的細節（對 debug 很有用）：

- **只取第一個 label 當 bucket**：`host_without_port.split_once('.')` 只切一次，所以 `a.b.example.com` 會把 bucket 當成 `a`（不是 `a.b`）。
- **`localhost` 直接排除**：`bucket != "localhost"`，因此本機測試若用 `localhost:9000` 不會走 virtual-host style。
- **IPv4 literal 也排除**：例如 `127.0.0.1`（或任何 `x.x.x.x` 且每段可 parse u8）會被 `is_ipv4_host()` 視為 IP → 不採 virtual-host style。
- **key 的空字串會變 None**：
  - virtual-host style：`GET /`（path 只有 `/`）→ `trimmed.is_empty()` → `key=None`
  - path style：`/bucket/` → split 後 `key_raw=""`，decode 後仍空 → `.filter(|v| !v.is_empty())` → `key=None`
- **decode 的時機**：
  - virtual-host style：只 decode path（`trimmed`），host label（bucket）不 decode。
  - path style：先 split bucket/key，再分別 decode；因此 `%2F` 若出現在 key 內會 decode 成 `/`，但 **不會影響 split bucket/key 的邊界**（因為 split 在 decode 前就做了）。

（對照原始碼：`pingora-s3-mongo/src/app.rs::parse_bucket_and_key()`）

---

## 7) 內建單元測試：把 routing/bucket-key 解析當成「可執行規格」

`app.rs` 末尾有一組 `#[cfg(test)]` 測試，等於把幾個核心判斷寫成「輸入 → 輸出」的規格；在你修改 routing 或 bucket/key 解析時，這些是最先會爆的保護網。

### 7.1 `parse_bucket_and_key()` 測試案例（節錄）

- **Path style**
  - `path="/demo-bucket/path/to/file.txt", host="localhost:8080"`
    - bucket → `demo-bucket`
    - key → `path/to/file.txt`

- **Bucket root（沒有 key）**
  - `path="/demo-bucket"` → bucket 有值、key = `None`

- **空路徑**
  - `path="/"` → bucket/key 都是 `None`（對應 `GET /` 的 list-buckets 路徑）

- **Virtual-host style**
  - `path="/logs/2026-01-01.txt", host="my-bucket.s3.local:8080"`
    - bucket → `my-bucket`
    - key → `logs/2026-01-01.txt`

- **IPv4 host 強制走 path style**
  - `host="127.0.0.1:8080"` 會被視為 IP → 不啟用 virtual-host style

### 7.2 `query_has_key()`：只看「key 存不存在」

測試也明確表達：

- `query_has_key("tagging&x=1", "tagging") == true`
- `query_has_key("list-type=2&prefix=abc", "prefix") == true`
- `query_has_key("x=1", "tagging") == false`

> 這代表 routing 只在乎 `?tagging` / `?delete` / `?prefix` 等 key 是否出現，不在乎 value 是什麼；對 debug 很實用（例如 client 傳 `tagging=` 仍會被視為 tagging 路徑）。
