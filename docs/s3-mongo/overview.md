# pingora-s3-mongo｜總覽

`pingora-s3-mongo` 是一個 **S3 API（部分相容）** 的服務，跑在 Cloudflare Pingora 框架上，後端把 object 存在 MongoDB。

## Repo 位置
- `pingora-s3-mongo/`（Cargo 專案）

## 主要模組（Rust）
- `pingora-s3-mongo/src/main.rs`：啟動流程（讀 config、init store、啟 http service、啟 credential refresh background job）
- `pingora-s3-mongo/src/config.rs`：讀 YAML/JSON config，並支援 env 覆蓋
- `pingora-s3-mongo/src/store.rs`：MongoDB 存取層（bucket=collection；object=_id=key）
- `pingora-s3-mongo/src/auth.rs`：SigV4 驗證 + credential cache（Mongo collection: `s3_credential`）
- `pingora-s3-mongo/src/app.rs`：Pingora HTTP handler（路由到 S3 API 行為）

## 核心設計（先記結論）
- Bucket mapping：MongoDB **每個 bucket 一個 collection**
- Object mapping：document `_id` = `key`，body 用 `Binary` 存
- Credential：從 `s3_credential` collection 拉取 access/secret + allowed_bucket[]，**常駐 in-memory cache**，並用 background service 定期 refresh

接下來要把「S3 request flow（GET/PUT/LIST/DELETE）」從 `app.rs` 追到 `store.rs`，並把錯誤回傳（403/404/500）整理成 troubleshooting。

## Request routing（app.rs）與 bucket/key 解析
> 檔案：`pingora-s3-mongo/src/app.rs`

### 入口：`dispatch()`
`S3MongoApp::dispatch(&mut ServerSession)` 是 Pingora 每個 HTTP request 的主要入口，做的事可以拆成四段：
1) **抽取 request 基本資訊**：`method / path / query / host`
2) **解析 bucket + key**：`parse_bucket_and_key(path, host)`
3) **bucket name 檢查**：若解析出 bucket，會先跑 `is_valid_bucket_name()`；不合法直接回 `InvalidBucketName (400)`
4) **SigV4 驗證與授權**：`authenticate(req, bucket)`
   - 驗證失敗會被映射成對應的 S3 error XML（例如 `AccessDenied` / `InvalidAccessKeyId` / `SignatureDoesNotMatch`）
5) **依 method + query 分派到 handler**：用 `match method` 進行路由；其中 `?tagging`、`POST ?delete` 等會優先分流到對應 API。

### 方法分派規則（高階）
- `GET`
  - `bucket == None` → `list_buckets()`（列出允許的 buckets）
  - `?tagging` → `get_object_tagging()`（要求必須有 key，否則 `InvalidRequest (400)`）
  - `key == None` → `list_objects()`
  - `key != None` → `get_object()`
- `HEAD`
  - `bucket == None` → `InvalidURI (400)`（必須提供 bucket）
  - `key == None` → `head_bucket()`
  - `key != None` → `head_object()`
- `PUT`
  - `bucket == None` → `InvalidURI (400)`
  - `key == None` → `create_bucket()`
  - `key != None` → `put_object()`
  - `?tagging` → `put_object_tagging()`（優先於 put_object）
- `DELETE`
  - `?tagging` → `delete_object_tagging()`（優先於 delete_object）
  - else → `delete_object()`
- `POST`
  - `?delete` → `delete_objects()`（bulk delete）
  - else → `MethodNotAllowed`

### bucket/key 解析：`parse_bucket_and_key(path, host)`
此函式同時支援兩種常見的 S3 存取風格：

1) **Virtual-host style（優先）**
- 判斷方式：`host` 去掉 port 後，若能 `split_once('.')` 取得第一段 `bucket`，且 bucket 不是空字串、不是 `localhost`，且 host 不是 IPv4（避免 `1.2.3.4` 被當 bucket）
- key 來源：來自 URL path 去掉開頭 `/` 後的剩餘字串（可能為空）
- 例：
  - `Host: my-bucket.example.com`, `GET /a/b.txt`
  - → bucket=`my-bucket`, key=`a/b.txt`

2) **Path style（備援）**
- 判斷方式：若 trimmed path 非空，會 `splitn(2, '/')` 取第一段作 bucket，第二段（若存在）作 key
- 例：
  - `Host: example.com`, `GET /my-bucket/a/b.txt`
  - → bucket=`my-bucket`, key=`a/b.txt`

3) **Percent-decoding**
- bucket 與 key 都會經 `decode_path_component()` 做 percent-decoding（`percent_decode_str(...).decode_utf8_lossy()`）
- 意味著 `%2F` 這類編碼會在此層被解碼後再進 store；後續追 `store.rs` 時要留意 key 的「字串正規化」是否會造成歧義。

---

## S3 request flow：從 `app.rs` 到 `store.rs`
> 目標：把「一個 HTTP request」如何變成 MongoDB 操作講清楚（成功路徑 + 常見錯誤分支）。

### 0) 共通前置：驗 bucket name + SigV4 auth
每個 request 在進 handler 前都會經過：
- bucket 若存在 → `is_valid_bucket_name()`（不合法直接 `InvalidBucketName (400)`）
- `authenticate(req, bucket)` → `auth.rs::authenticate_request()`
  - `MissingAuthorization` / `AccessDenied` / `InvalidAccessKeyId` / `SignatureDoesNotMatch` → 對應的 S3 error XML（多為 403）

> 注意：`list_buckets()` 也會走 auth（因為 bucket 可能是 `None`，但仍需要拿到 allowed buckets 才能回應）。

### 1) PUT object：`PUT /{bucket}/{key}`
> 對應：`S3MongoApp::put_object()` → `MongoS3Store::put_object()`

**app.rs（HTTP handler）**
1) `read_full_body(http_stream)`：一次把 request body 讀入 memory（目前沒有 streaming / multipart）
2) content-type：從 header `content-type` 取；缺省 `application/octet-stream`
3) tagging：
   - 若 header 有 `x-amz-tagging`，用 `parse_tagging_query()` 解析成 `Document`
4) 呼叫 store：`store.put_object(bucket, key, body, content_type, tags)`
5) 回應：
   - `200 OK`，並在 response header 塞 `ETag: "{etag}"`

**store.rs（MongoDB）**
- `etag = md5(body)`
- 組合 object document（bucket = collection）：
  - `_id` / `key`：都是 `key`
  - `body`：Mongo `Binary`
  - `content_type`、`content_length`、`etag`、`last_modified`、`tags`
- `replace_one({_id:key}, doc, upsert=true)`：同 key 視為覆寫（upsert）

### 2) GET object：`GET /{bucket}/{key}`
> 對應：`S3MongoApp::get_object()` → `MongoS3Store::get_object()`

流程：
1) 先 `store.get_object(bucket, key)`
   - 找到 → `object_response(obj, false)`
2) 找不到：
   - 若 bucket 不存在 → `NoSuchBucket (404)`
   - 否則 → `NoSuchKey (404)`

回應重點（object_response）：
- body 會直接回傳（GET）
- header 會帶：
  - `Content-Type`
  - `Content-Length`
  - `ETag`
  - `Last-Modified`

### 3) HEAD object：`HEAD /{bucket}/{key}`
> 對應：`S3MongoApp::head_object()` → `MongoS3Store::get_object_metadata()`

- `get_object_metadata()` 會用 projection 排除 `body`（`{"body": 0}`）
- 找到 → `object_response(obj, true)`（只回 headers，不帶 body）
- 找不到 → `404`（目前是空 body 的 `NOT_FOUND`，未包 S3 XML error）

### 4) LIST objects：`GET /{bucket}?prefix=...&max-keys=...&continuation-token=...`
> 對應：`S3MongoApp::list_objects()` → `MongoS3Store::list_objects()`

**Query 參數**
- `prefix`：字首篩選
- `max-keys`：上限（>0 才算；最大被 cap 在 `DEFAULT_MAX_KEYS=1000`）
- `continuation-token`：分頁 token（用 `_id > token` 實作）

**Mongo filter 邏輯（store.rs）**
- prefix：用 `_id` 的 regex（`mongo_prefix_regex(prefix)`）
- continuation：用 `_id: { $gt: token }`
- sort：`_id` 升冪
- limit：`max_keys + 1`（多抓一筆判斷是否 truncated）

**bucket 不存在的判斷**
- `list_objects()` 若回來 objects 為空，會再 `bucket_exists()`
  - 不存在 → `NoSuchBucket (404)`
  - 存在但就是空 bucket → 正常回 `200 OK`（空清單）

### 5) DELETE object：`DELETE /{bucket}/{key}`
> 對應：`S3MongoApp::delete_object()` → `MongoS3Store::delete_object()`

- `store.delete_object()` 回傳 `deleted: bool`
- 若 `deleted=false` 且 bucket 不存在 → `NoSuchBucket (404)`
- 其他情況（包含 key 不存在）→ `204 NO_CONTENT`

> 這裡的語意接近 S3：刪除不存在的 key 也視為成功（idempotent）。

### 6) Bucket ops（補充）
- `PUT /{bucket}`（key == None）→ `create_bucket()`
  - bucket 已存在 → `BucketAlreadyOwnedByYou (409)`
  - 否則 → `200 OK`
- `HEAD /{bucket}` → `head_bucket()`
  - 存在 → `200 OK`
  - 不存在 → `404`（空 body）
- `DELETE /{bucket}` → `delete_bucket()`
  - bucket 不存在 → `NoSuchBucket (404)`
  - bucket 有物件 → `BucketNotEmpty (409)`
  - drop collection → `204 NO_CONTENT`

### 7) Tagging ops（補充）
- `PUT ...?tagging`：`handle_put_tagging()` → `store.update_tags()`
  - 找不到 key：會再判 bucket 是否存在，映射成 `NoSuchBucket/NoSuchKey`
- `GET ...?tagging`：`get_object_tagging()` → `store.get_tags()`
- `DELETE ...?tagging`：`handle_delete_tagging()` → `store.clear_tags()`

---

## 小結：一張心智模型（最常用路徑）
- **PUT object**：HTTP body → `replace_one(upsert)` → 回 `ETag`
- **GET/HEAD object**：`find_one({_id:key})`（HEAD 用 projection 不取 body）→ 回 headers/body
- **LIST**：`_id` regex prefix + `_id > token` → sort + limit → XML list response
- **DELETE**：`delete_one({_id:key})` → 不管 key 是否存在，基本都 `204`（除非 bucket 不存在）
