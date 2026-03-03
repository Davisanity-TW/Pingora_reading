# pingora-s3-mongo｜Auth（SigV4 + credential cache）

對應檔案：`pingora-s3-mongo/src/auth.rs`

## CredentialCache
- 結構：`HashMap<access_key, CredentialEntry>`
- `CredentialEntry`：
  - `secret_key: String`
  - `allowed_buckets: HashSet<String>`
- 實作：`tokio::sync::RwLock` + `Arc`，支援 `replace()` 直接整包換掉

## Credential refresh background job
- `CredentialCacheRefresher` 實作 `pingora::services::background::BackgroundService`
- 使用 `tokio::time::interval(refresh_seconds)` 定期：
  - `store.load_credentials()`
  - `cache.replace(next)`

## SigV4 驗證（Header Authorization）
主要入口：
- `authenticate_request(req, bucket, credential_cache)`
  1) `parse_sigv4_header_auth(req)`：解析 `Authorization: AWS4-HMAC-SHA256 ...`
  2) 取 `access_key` → cache 查 `secret_key`
  3) `verify_sigv4_header_auth(req, parsed, secret_key)`
  4) 若有 bucket：檢查 access_key 是否在 allowed_buckets

錯誤類型：
- `MissingAuthorization`
- `InvalidAccessKeyId`
- `SignatureDoesNotMatch`
- `AccessDenied`

## 另外：query auth
- `extract_credential(req)` 有支援從 query param 讀 `X-Amz-Credential`
- 但目前 `authenticate_request()` 走的是 header auth；後續要在 `app.rs` 確認 query auth 是否真的被支援（可能尚未完整接上）。

下一步：把 `app.rs` 裡「何時 call authenticate_request」與「bucket 是怎麼抽出」補到 request flow。
