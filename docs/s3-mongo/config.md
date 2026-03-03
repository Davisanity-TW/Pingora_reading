# pingora-s3-mongo｜Config（env 覆蓋）

對應檔案：`pingora-s3-mongo/src/config.rs`

## Config 結構
- `http.port: u16`
- `https: { port, tls_cert, tls_key }`（optional）
- `mongo: { uri, database }`
- `auth: { credential_collection, refresh_seconds }`（optional，有預設值）

## 預設值
- credential collection 預設：`s3_credential`（`DEFAULT_CREDENTIAL_COLLECTION`）
- refresh seconds 預設：`30`（`DEFAULT_CREDENTIAL_REFRESH_SECONDS`）

## Env 覆蓋（重點）
- `MONGO_URI` → 覆蓋 `mongo.uri`
- `MONGO_DATABASE` → 覆蓋 `mongo.database`
- `MONGO_CREDENTIAL_COLLECTION` → 覆蓋 auth.credential_collection
- `MONGO_CREDENTIAL_REFRESH_SECONDS` → 覆蓋 auth.refresh_seconds（需 >0）

實作在：`load_config()` 裡先 parse YAML/JSON，再套 env。

> 這種設計很適合 k8s：ConfigMap 給預設，Secret/Env 注入敏感 uri。
