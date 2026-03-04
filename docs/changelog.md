# 更新日誌

- 2026-03-03
  - 初始化 VitePress 架構與 sidebar（先聚焦 pingora-s3-mongo）
  - 新增 pingora-s3-mongo：總覽/啟動流程/Config/Auth/Store 初稿

- 2026-03-04
  - 補上 pingora-s3-mongo `app.rs`：`dispatch()` 路由規則與 `parse_bucket_and_key()`（virtual-host/path-style、percent-decoding）筆記
  - 補齊 pingora-s3-mongo request flow：常用 S3 API（PUT/GET/HEAD/LIST/DELETE）從 `app.rs` 對應到 `store.rs` 的 MongoDB 行為 + 錯誤分支
