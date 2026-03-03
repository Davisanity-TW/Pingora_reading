# 讀碼計畫

## 優先順序
1. `pingora-s3-mongo`（你指定）
2. `pingora-s3-proxy`（Gateway/Routing/Rate-limit/動態配置）
3. `admin_console`（配置來源、資料模型、API）

## 每日產出規格（固定）
- 更新 1~3 個 markdown（聚焦一條主線）
- 更新 `docs/changelog.md`
- commit message 包含日期（Asia/Taipei）

## pingora-s3-mongo 的目標問題
- 啟動後有哪些 service/background job？
- S3 request（path-style / virtual-host style）怎麼解析 bucket/key？
- SigV4 驗證怎麼做？支援 query auth 嗎？
- Mongo 的資料模型（bucket/obj/doc）與 list/prefix/continuation 如何實作？
- 什麼情境會回 403/404/500？
