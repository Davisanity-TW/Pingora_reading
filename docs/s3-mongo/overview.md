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
