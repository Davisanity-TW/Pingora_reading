# 更新日誌

- 2026-03-03
  - 初始化 VitePress 架構與 sidebar（先聚焦 pingora-s3-mongo）
  - 新增 pingora-s3-mongo：總覽/啟動流程/Config/Auth/Store 初稿

- 2026-03-04
  - 補上 pingora-s3-mongo `app.rs`：`dispatch()` 路由規則與 `parse_bucket_and_key()`（virtual-host/path-style、percent-decoding）筆記
  - 補齊 pingora-s3-mongo request flow：常用 S3 API（PUT/GET/HEAD/LIST/DELETE）從 `app.rs` 對應到 `store.rs` 的 MongoDB 行為 + 錯誤分支

- 2026-03-05
  - 新增 pingora-s3-mongo `app.rs`：access log（`AccessLogCtx`）欄位來源、`act_grp` 分類規則與 log format 筆記

- 2026-03-06
  - 補強 pingora-s3-mongo `app.rs`：request routing + bucket/key 解析（virtual-host/path-style）+ store API 對應整理（新增 `docs/s3-mongo/app_request_routing.md`）
  - 補齊 pingora-s3-mongo request flow（以 handler 為單位）：ListBuckets/CreateBucket/HeadBucket/DeleteBucket/PutObject/GetObject/HeadObject/DeleteObject/ListObjects/Tagging/Multi-Delete 的 store 呼叫、錯誤分支與回應型態

- 2026-03-07
  - 補強 pingora-s3-mongo `parse_bucket_and_key()`：virtual-host style 的實作細節/邊界案例（localhost、IPv4、只取第一段 label、key 空字串→None、decode 時機）

- 2026-03-08
  - 補強 pingora-s3-mongo `app.rs`：bucket 名稱合法性檢查 `is_valid_bucket_name()` 規則與被擋下時的回應（`InvalidBucketName`）
  - 補齊 pingora-s3-mongo `app.rs` request flow：最外層入口 `ServeHttp::response()`（request context `AccessLogCtx` 建立）→ `dispatch()`，以及 dispatch 失敗時統一包 `InternalError(500)` 的兜底路徑
  - 彙整 pingora-s3-mongo `app.rs` 主要錯誤分支與 HTTP status/S3 Code mapping（InvalidURI/InvalidRequest/MalformedXML/NoSuchBucket/NoSuchKey/409/405/500；以及 HEAD 404 empty body 特例）

- 2026-03-09
  - 補強 pingora-s3-mongo `app.rs`：把 `parse_bucket_and_key()` / `query_has_key()` 的內建單元測試整理成「可執行規格」筆記，方便修改 routing 時快速對照（新增於 `docs/s3-mongo/app_request_routing.md`）
