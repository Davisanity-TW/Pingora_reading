# pingora-s3-mongo：app.rs request routing / bucket+key 解析 / store API 對應

本篇聚焦 `pingora-s3-mongo/src/app.rs` 的「入口 dispatch → 解析 bucket/key → 依 method/query 分流 → 呼叫 MongoS3Store」整體路徑。

> 目標：快速定位「一個 HTTP request 進來後，到底會走到哪個 handler、怎麼判斷 bucket/key、最後呼叫到 store 的哪個 API」。

---

## 0) 最外層入口：Pingora listener → `ServeHttp::response()` → `dispatch()`

在 pingora-s3-mongo 這個 binary 裡，HTTP request 進來後會由 Pingora 的 HTTP server 驅動，最後呼叫到 `S3MongoApp` 對 `pingora::apps::http_app::ServeHttp` 的實作。

### 0.1 listener / route 入口：`src/main.rs` 如何把連線導到 app

整體 wiring 在 `pingora-s3-mongo/src/main.rs`：

- 建立 app：`let app = app::S3MongoApp::new(store.clone(), credential_cache.clone());`
- 交給 Pingora 的 HTTP app wrapper：`let http_server = HttpServer::new_app(app);`
- 掛到 listening service：`let mut service = Service::new("pingora-s3-mongo".to_string(), http_server);`
- 綁定監聽位址（HTTP）：
  - `LISTEN_ADDR` env 有值就用它
  - 否則用 config 的 `config.http.port` 組 `0.0.0.0:{port}`
  - 最後：`service.add_tcp(&listen_addr)`
- 若設定了 https（`config.https` 存在）：
  - `TLS_LISTEN_ADDR` env 有值就用它，否則用 `https.port`
  - `service.add_tls(&tls_listen_addr, &https.tls_cert, &https.tls_key)`
- 服務加入 server：`server.add_service(service);`

補充：`main.rs` 也會加一個 background service 定期 refresh credentials：

- service name：`s3-credential-refresh`
- worker：`auth::CredentialCacheRefresher::new(store, credential_cache, config.auth.refresh_seconds)`

這代表 request path 上的 `authenticate_request()` 除了即時驗證簽章，也依賴背景 refresh 的 in-memory cache（避免每次打 Mongo）。

---

入口函式與最外層處理在 `app.rs`：

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

### 1.1 request flow 一頁速記（從 listener 到 store）

```
Pingora listener (main.rs)
  -> HttpServer::new_app(S3MongoApp)
  -> ServeHttp::response(http_stream)
      1) AccessLogCtx::from_request()   # 先抽 log context（含 bucket 推測）
      2) dispatch(http_stream)
          a) parse_bucket_and_key(path, host)
          b) is_valid_bucket_name(bucket?)  # bucket 不合法：直接 400 InvalidBucketName
          c) authenticate_request(req, bucket?)
          d) method/query 分流到 handler
          e) handler 內呼叫 MongoS3Store::*（mongo）
      3) log_access(status, size, latency)
      4) return Response

※ 任何「非預期 Err(String)」會在 response() 外層統一轉成 500 InternalError(S3 XML)
```

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

### 2.0 演算法精簡版（照原始碼順序）

> 這段是把 `parse_bucket_and_key()` 的 if/return 依序壓縮成可讀的流程，方便你 debug bucket 解析到底是走 vhost 還是 path style。

```text
trimmed = path 去掉前導 '/'
host_without_port = host 去掉 ':port'

# 1) 先嘗試 virtual-host style（只看 host 的第一段 label）
if host_without_port 能 split_once('.') -> bucket_label
  且 bucket_label != ''
  且 bucket_label != 'localhost'
  且 host_without_port 不是 IPv4 literal
then
  bucket = bucket_label
  key = (trimmed 為空 ? None : percent-decode(trimmed))
  return

# 2) 再嘗試 path style
if trimmed != ''
  bucket_raw, rest = trimmed splitn(2, '/')
  bucket = percent-decode(bucket_raw)
  key = (rest 存在 ? percent-decode(rest) : None)
  key == '' 時視為 None
  return

# 3) 都沒有就回 (None, None)
```

#### 幾個「肉眼不容易注意」的行為

- **virtual-host style 只要 host 有「一個點」就會啟用**（除非被 localhost/IPv4 排除）
  - 例如 `example.com` 會被視為 bucket=`example`（這不一定符合你期望的 S3 行為）
  - `a.b.c` 只取第一段 `a` 當 bucket，其餘 `b.c` 完全不參與判斷
- **vhost style 的 bucket 不做 URL decode**：bucket 直接用 host label 字串；只有 key（path）會 decode。
- **path style 的 bucket/key 都會 URL decode**：bucket_raw 與剩餘 key 分別 decode（先 split 再 decode）。

> 如果你前面有 Ingress/LB 會改 Host header，這裡的 vhost 優先序會讓 bucket 解析「跟著 Host 走」，而不是跟 path 走；這會連帶影響 auth（SigV4 canonical request）與 store 查詢。

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
>
> 補充兩個容易忽略的細節（從 `parse_bucket_and_key()` 原始碼直接讀出來）：
> - **Path style 會把空字串 key 過濾成 None**：`parts.next().map(decode).filter(|v| !v.is_empty())`。因此 `/bucket/`（最後一段為空）會被視為 `key=None`。
> - **URL decode 在 split 後才做**：`/bucket/%2F` 會先 split 出 raw key=`%2F`，再 decode 成 key=`"/"`（此時 key 非空），所以會走 object-level handler，而不是 bucket-level。

### (E) 範例（對照 app.rs 內建測試）

`app.rs` 檔尾有對 `parse_bucket_and_key()` 的 unit tests，可用來快速理解 precedence：

- Path style（一般）
  - `("/demo-bucket/path/to/file.txt", "localhost:8080")` → bucket=`demo-bucket`, key=`path/to/file.txt`
  - `("/demo-bucket", "localhost:8080")` → bucket=`demo-bucket`, key=None
  - `("/", "localhost:8080")` → bucket=None, key=None

- Virtual-host style（優先於 path style）
  - `("/logs/2026-01-01.txt", "my-bucket.s3.local:8080")` → bucket=`my-bucket`, key=`logs/2026-01-01.txt`

- host 為 IPv4 literal 時會**禁用** virtual-host style
  - `("/demo-bucket/path/to/file.txt", "127.0.0.1:8080")` → bucket=`demo-bucket`, key=`path/to/file.txt`

> 這些行為會直接影響你在本機/測試環境怎麼組 request：
> - 用 `localhost` 或 `127.0.0.1` 打 API 時，多半走 **path style**。
> - 用 `my-bucket.s3.local` 這類 host 才會走 **virtual-host style**。

### Virtual-host style 的判斷坑點（容易踩）

`parse_bucket_and_key()` 對 virtual-host style 的判斷偏『寬鬆』：

- 只要 `host_without_port` 能 `split_once('.')`，就把 **第一段 label** 當 bucket
- 這一步**不會**在這裡做 bucket 名稱合法性檢查（合法性是在 `dispatch()` 內 `is_valid_bucket_name()` 才檢查）
- 只做少數排除：
  - bucket 不能是空字串
  - bucket 不能是 `localhost`
  - host 不能是 IPv4 literal（例如 `127.0.0.1`），否則強制走 path style

> 實務上，如果你用 `bucket.s3.local` / `bucket.example.com` 做 virtual-host style 測試，要留意 DNS/hosts 解析與反向代理的 host header 是否被改寫；只要 host 的第一段 label 變了，bucket 就會跟著變。
- 例外只有三個：bucket 不能是空字串、不能是 `localhost`、host 不能是 IPv4 literal

因此在某些測試/反向代理環境，如果你的 Host 是一般網域（例如 `example.com`），它會被視為 bucket=`example`（即使你的 path 其實是 `/real-bucket/real-key`）。

實務上通常會用 `bucket.s3.local` / `bucket.s3.internal` 這種固定 pattern 才合理；如果未來要支援更嚴謹的 S3 virtual-host（或避免誤判），可以考慮：

- 明確判斷 host 是否落在預期的 base domain（例如必須是 `*.s3.local`）
- 或加入 config：允許/禁用 virtual-host style，或指定 base domain

> 這個點對「前面還有 LB/Ingress 會改 Host」的部署特別重要：Host 一旦被改掉，bucket 解析可能會錯位，進而導致 auth 與 store 查詢落到錯 bucket。

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
  - get tagging：`MongoS3Store::get_tags(bucket, key)`
  - put tagging：`MongoS3Store::update_tags(bucket, key, tags)`
  - delete tagging：`MongoS3Store::clear_tags(bucket, key)`

- multi-delete
  - delete objects：`MongoS3Store::delete_objects(bucket, keys)`

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

### 5.12 Request body 讀取與 `Expect: 100-continue`：`read_full_body()` / `maybe_send_continue()`

`PUT Object`、`PUT ?tagging`、`POST ?delete` 這三條路徑都會讀 request body；在 `app.rs` 內統一走：

- `read_full_body(http_stream).await?`
  - 先呼叫 `maybe_send_continue()`（處理 `Expect: 100-continue`）
  - 之後 loop 讀 `http_stream.read_request_body().await` 直到回 `None`
  - 把所有 chunk `extend_from_slice()` 到同一個 `Vec<u8>`

`maybe_send_continue()` 行為：

- 若 header `Expect: 100-continue`（大小寫不敏感）
  - 先回 `http_stream.write_continue_response().await`
- 否則不做事

幾個實務含意（從程式碼直讀）：

- **沒有 streaming / 沒有 size cap**：body 會一次讀滿並存在記憶體 `Vec<u8>`；大物件上傳在這層沒有做上限保護。
- **讀 body 失敗會變成 `InternalError(500)`**：
  - 因為 `read_full_body()` 用 `?` 往上丟 `Err(String)`
  - 最終會被 `ServeHttp::response()` 外層兜底包成 `500 InternalError`（S3 XML）。

（對照原始碼：`pingora-s3-mongo/src/app.rs::read_full_body()` / `maybe_send_continue()`）

---

## 5.x) 主要 error path / HTTP status mapping（從 app.rs 直接整理）

> 目的：用「看到某個 status 或 S3 Code」就能快速回推是哪個分支打出來的。

### 速查表（先看這張）

| HTTP | S3 Code | 典型觸發點（app.rs） | 備註 |
|---:|---|---|---|
| 400 | InvalidBucketName | `dispatch()` → `is_valid_bucket_name()` | auth 之前就擋掉 |
| 400 | InvalidURI | `handle_*`：bucket=None 但 API 需要 bucket | HEAD/PUT/DELETE 常見 |
| 400 | InvalidRequest | `?tagging` 但 key=None | tagging 一定要 key |
| 400 | MalformedXML | `PUT ?tagging` / `POST ?delete` XML parse 失敗 | parse 失敗不會變 500 |
| 403 | AccessDenied / InvalidAccessKeyId / SignatureDoesNotMatch | `authenticate()` | 全部都是 403（只有 Code 不同） |
| 404 | NoSuchBucket | 多數 handler：`bucket_exists()` 判斷 | `GET Object`/tagging 等 |
| 404 | NoSuchKey | `GET Object`/tagging：bucket 存在但 key 不存在 | |
| 404 | (empty body) | `head_bucket()` / `head_object()` | **不是** S3 XML error |
| 405 | MethodNotAllowed | `dispatch()` default 分支 / `POST` 無 `?delete` | empty body |
| 409 | BucketAlreadyOwnedByYou | `create_bucket()` | |
| 409 | BucketNotEmpty | `delete_bucket()` | |
| 500 | InternalError | `ServeHttp::response()` 外層兜底 | 任何 `Err(String)` |

補充兩個回應格式的小細節（從 `app.rs` 直接觀察）：

- `s3_error()` 產生的錯誤回應一定是 **XML body**，並用 `xml_response()` 設定 `Content-Type: application/xml`；`build_response()` 會**強制塞 `Content-Length`**（就算 body 是空的也會是 `0`）。
- `method_not_allowed()`（405）與部分 `HEAD` error path 走的是 `empty_response()` / `build_response()`：**body 是空的**，因此跟一般 S3 的 XML error 不同，debug 時要留意「同樣是 4xx，但有沒有 XML」。


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

---

## 8) handler → `MongoS3Store` API 對應（速查）

從 `app.rs` 這層看，`S3MongoApp` 幾乎只負責：

- routing（method/query/bucket/key）
- 讀取 request body（PUT object / tagging / multi-delete）
- 把「S3 API 的語意」轉成對 store 的呼叫

下面整理幾個最常用的對應（只列本篇範圍內，細節請搭配 `docs/s3-mongo/store.md`）：

### Bucket 層級

- `GET /`（bucket=None）
  - `list_buckets()` → `store.list_bucket_names()`（再用 `allowed_buckets` filter）
- `PUT /{bucket}`
  - `create_bucket()` → `store.bucket_exists()` → `store.create_bucket()`
- `HEAD /{bucket}`
  - `head_bucket()` → `store.bucket_exists()`
- `DELETE /{bucket}`
  - `delete_bucket()` → `store.bucket_exists()` → `store.bucket_object_count()` → `store.drop_bucket()`

### Object 層級

- `GET /{bucket}/{key}`
  - `get_object()` → `store.get_object()`（找不到再用 `store.bucket_exists()` 決定回 NoSuchBucket/NoSuchKey）
- `HEAD /{bucket}/{key}`
  - `head_object()` → `store.get_object_metadata()`
- `PUT /{bucket}/{key}`
  - `put_object()` → `read_full_body()` + 取 `content-type` + `x-amz-tagging`（querystring format）
  - → `store.put_object(bucket, key, body, content_type, tags)`
- `DELETE /{bucket}/{key}`
  - `delete_object()` → `store.delete_object()`（若刪不到再用 `store.bucket_exists()` 判斷是否 NoSuchBucket）

### List / Tagging / Multi-delete（query 影響 routing）

- `GET /{bucket}?prefix=...&continuation-token=...&max-keys=...`
  - `list_objects()` → `store.list_objects(bucket, prefix, continuation, max_keys)`
- `GET /{bucket}/{key}?tagging`
  - `get_object_tagging()` → `store.get_tags()`（找不到再用 `store.bucket_exists()` 判斷 NoSuchBucket/NoSuchKey）
- `PUT /{bucket}/{key}?tagging`
  - `handle_put_tagging()` → `read_full_body()` + XML decode → `store.update_tags()`
- `DELETE /{bucket}/{key}?tagging`
  - `handle_delete_tagging()` → `store.clear_tags()`
- `POST /{bucket}?delete`（multi-delete）
  - `handle_delete_objects()` → `read_full_body()` + XML decode → `store.delete_objects(bucket, keys)`

> 小提醒：這個實作下，`?tagging` 與 `?delete` 的 routing 完全是靠 `query_has_key()` 掃 key 是否存在；client 即使送 `?tagging=`（空值）仍會進 tagging handler。
