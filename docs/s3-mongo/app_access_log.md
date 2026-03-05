# pingora-s3-mongo｜app.rs：Access log（AccessLogCtx）與 act_grp 分類

> 檔案：`pingora-s3-mongo/src/app.rs`

這份筆記聚焦在 `ServeHttp::response()` 的共通包裝：
- request 進來後如何計時 / 捕捉 context
- 出錯時如何統一轉成 S3 error
- access log 的欄位來源與 `act_grp`（行為分組）判斷規則

## 1) `ServeHttp::response()`：外層包裝

```rust
#[async_trait]
impl ServeHttp for S3MongoApp {
  async fn response(&self, http_stream: &mut ServerSession) -> Response<Vec<u8>> {
    let req_ctx = AccessLogCtx::from_request(http_stream);
    let req_start = Instant::now();

    let response = match self.dispatch(http_stream).await {
      Ok(resp) => resp,
      Err(err) => {
        error!("s3-mongo request failed: {err}");
        s3_error(500, "InternalError", ...)
      }
    };

    log_access(&req_ctx, status, body_len, req_start.elapsed());
    response
  }
}
```

重點：
- **`dispatch()` 任何 `Err(String)` 都會被吃掉**，統一回 `InternalError (500)` 的 S3 XML（避免把內部錯誤細節曝露給 client）。
- access log 只依賴 `AccessLogCtx` + response status/size + elapsed time。

## 2) `AccessLogCtx::from_request()`：log 欄位從哪來

`AccessLogCtx` 的欄位：
- `remote_host`
  - `http_stream.client_addr()`
  - Inet → `ip.to_string()`；Unix socket → `"unix"`；取不到 → `"-"`
- `rq_mtd`
  - `req_header.method.as_str()`
- `full_path`
  - 優先用 `path_and_query()`（保留 query string），否則退回 `path()`
- `user_agent`
  - header `user-agent` 的**第一段 token**（以空白切，取 `next()`）
  - 取不到 → `"-"`
- `request_size`
  - `Content-Length` header（解析失敗/缺失 → `0`）
- `user`
  - 從 Authorization 取出 credential：`extract_credential(req_header)`
  - 再縮短顯示：`short_credential(...)`
  - 空值/不存在 → `"-"`
- `bucket`
  - 直接重用 `parse_bucket_and_key(req_header.uri.path(), host)`
  - bucket 沒解析到 → 顯示 `"-"`
- `act_grp`
  - `classify_act_grp(method, query, bucket.is_none())`

> 小提醒：`bucket` 的判斷使用的是 request 的 path/host（不一定代表 bucket 真實存在），主要用於 log 分流。

## 3) `act_grp`：把流量依行為分組

`classify_act_grp(method, query, is_bucket_empty)` 的規則（依序比對）：

1) **DELETE 類**
- `DELETE ...`
- 或 `POST ...?delete`（bulk delete）
→ `"DELETE"`

2) **GET:LIST**
- `GET` 且 query 不是空
- query 含 `list-type` 或 `prefix`
→ `"GET:LIST"`

3) **GET:BUCKETS**
- `GET` 且 `is_bucket_empty == true`
  - 這裡的 `is_bucket_empty` 實際上是 `bucket.is_none()`（只表示「bucket 沒從 URL 解析出來」）
→ `"GET:BUCKETS"`

4) **一般 GET/HEAD**
→ `"GET"`

5) **PUT/POST**
→ `"PUT"`

6) fallback
→ `method.to_ascii_uppercase()`

這個分組對「看 log 快速知道壓力來源」很有用：
- LIST（尤其 prefix scan）與 GET object、PUT object 的壓力特徵不同
- `GET:BUCKETS` 可以用來觀察 client 是否頻繁打根路徑（`/`）

## 4) access log 的最終輸出格式

`log_access()` 的 info log：

```text
{remote} {method} {full_path} {ua} {status} qs:{req_bytes} ps:{resp_bytes} rt:{ms} {user} {bucket} {act_grp} MONGO
```

欄位意義：
- `qs`：request size（僅 Content-Length；不包含 header）
- `ps`：response body bytes（`response.body().len()`）
- `rt`：以毫秒顯示（3 位小數）
- 最後固定印 `MONGO`（可視為 backend tag）

## 5) 跟 `dispatch()` 的關係（為什麼這段值得記）

`dispatch()` 內部路由（GET/PUT/HEAD/DELETE/POST）與 S3 error mapping 很詳細，但在排查現場時：
- 先看 **act_grp / status / rt** 往往更快定位問題
- `InternalError (500)` 全都走同一個外層 mapping，因此要靠 server-side error log（`error!(...)`）+ access log 串起來
