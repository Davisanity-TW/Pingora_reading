# pingora-s3-mongo｜啟動流程（main）

對應檔案：`pingora-s3-mongo/src/main.rs`

## 啟動順序（依程式碼）
1. 初始化 logger（`env_logger::Builder`）
2. 決定 config 路徑：
   - env `PINGORA_CONFIG`，預設 `config/pingora-s3-mongo.yaml`
   - `config::load_config()`
3. 決定 listen addr：
   - env `LISTEN_ADDR`，預設 `0.0.0.0:<config.http.port>`
4. 建 tokio runtime，初始化 Mongo store：
   - `store::MongoS3Store::new(uri, database, credential_collection)`
5. 建立 `CredentialCache` 並先 refresh 一次（確保服務啟動前就有 credential）：
   - `auth::refresh_credential_cache_once(&store, &credential_cache)`
6. 啟 Pingora server：
   - `Server::new(Some(opt))` + `server.bootstrap()`
7. 註冊 HTTP service：
   - `app::S3MongoApp::new(store.clone(), credential_cache.clone())`
   - `HttpServer::new_app(app)`
   - `service.add_tcp(listen_addr)`
8. 若有 HTTPS 設定：
   - `service.add_tls(tls_listen_addr, tls_cert, tls_key)`
9. 註冊 background service（credential refresh）：
   - `background_service("s3-credential-refresh", CredentialCacheRefresher::new(...))`
10. `server.run_forever()`

## 觀察點
- 這裡的 credential cache 是「啟動前先讀一次 + background 定期更新」，所以 Mongo credential 變更不需重啟。
- next：要確認 `app.rs` 在處理每個 request 時是否都會查 cache + 驗 SigV4。
