# 更新日誌

- 2026-03-15
  - 補強 pingora-s3-mongo `parse_bucket_and_key()`：新增「演算法精簡版」與 vhost/path style 的關鍵邏輯/邊界行為速記，方便快速 debug（更新 `docs/s3-mongo/app_request_routing.md`）

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
  - 補強 pingora-s3-mongo `ServeHttp::response()` 的 end-to-end request 時序：`AccessLogCtx` 建立 → `dispatch()` → 統一寫 access log → 回應 client（新增於 `docs/s3-mongo/app_request_routing.md`）

- 2026-03-10
  - 補強 pingora-s3-mongo `app.rs` request routing 筆記：補上「bucket/key 解析與 bucket 名稱檢查在 auth 之前」以及 `?tagging`/`POST ?delete` 的分流優先序提醒（更新 `docs/s3-mongo/app_request_routing.md`）
  - 補上 `dispatch()` 冒出 `Err(String)` 時常見來源（`read_full_body()` / `MongoS3Store::*` 的 `?` 傳播），方便對照為何被統一包成 `InternalError(500)`（更新 `docs/s3-mongo/app_request_routing.md`）

- 2026-03-11
  - 補強 pingora-s3-mongo request flow：補上 `main.rs` 的 listener/service wiring（`HttpServer::new_app` → `Service::add_tcp/add_tls`）與 credential refresh background service，讓「listener/route 入口 → request context 建立」更完整（更新 `docs/s3-mongo/app_request_routing.md`）

- 2026-03-12
  - 補強 pingora-s3-mongo `parse_bucket_and_key()`：補充 virtual-host style 判斷可能誤判一般網域（如 `example.com`）為 bucket 的風險，以及在 LB/Ingress 會改 Host 時的注意事項（更新 `docs/s3-mongo/app_request_routing.md`）
  - 補齊 `MongoS3Store` API mapping：補上 `get_tags()` 與 `delete_objects()`（更新 `docs/s3-mongo/app_request_routing.md`）

- 2026-03-13
  - 補強 pingora-s3-mongo `parse_bucket_and_key()` 的 decode/split 細節：path-style 會把空字串 key 過濾成 None，以及 `/bucket/%2F` 這種 case 會在 split 後 decode 成 key="/"（更新 `docs/s3-mongo/app_request_routing.md`）
  - 補齊 pingora-s3-mongo `app.rs` request flow：整理 `read_full_body()` / `maybe_send_continue()`（`Expect: 100-continue`）行為，以及「讀 body 失敗 → `InternalError(500)`」的錯誤傳播路徑（更新 `docs/s3-mongo/app_request_routing.md`）


- 2026-03-14
  - 補強 pingora-s3-mongo `app.rs` routing 筆記：補上 virtual-host style 寬鬆判斷的排除條件（localhost/IPv4）與「host 第一段 label 變動會直接改 bucket」的實務提醒（更新 `docs/s3-mongo/app_request_routing.md`）
  - 新增 handler → `MongoS3Store` API 對應速查表（bucket/object/tagging/multi-delete），方便從 S3 API 直接定位 store 呼叫（更新 `docs/s3-mongo/app_request_routing.md`）
  - 補上一頁式 request flow 速記（listener → `ServeHttp::response()` → `dispatch()` → store）與 `dispatch()` 兜底 `InternalError(500)` 的定位提示（更新 `docs/s3-mongo/app_request_routing.md`）
  - 新增「HTTP status / S3 Code」速查表，方便從回應快速回推 app.rs 分支（更新 `docs/s3-mongo/app_request_routing.md`）
