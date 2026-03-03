# Pingora-s3-proxy 讀碼筆記

- 原始碼：<https://github.com/Davisanity-TW/pingora-s3-proxy>
- 研究記錄網站（本 repo）：<https://github.com/Davisanity-TW/Pingora_reading>

## 目標
模仿 MinIO source code 研究流程：
- 先把「能跑起來」與「架構/入口」寫清楚
- 再做 request flow trace（GET/PUT/LIST…）
- 最後補 troubleshooting（錯誤訊息 → 檔案/函式定位 → 最短下一步）

## 今日優先：pingora-s3-mongo
你指定先研究 `pingora-s3-mongo`：一個用 Pingora 實作的 S3 API 服務，後端把 object 存到 MongoDB。

- 下一步入口：[/s3-mongo/overview](/s3-mongo/overview)
