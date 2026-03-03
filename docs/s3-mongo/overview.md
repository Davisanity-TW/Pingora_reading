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
