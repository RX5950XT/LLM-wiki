# Lessons

## 2026-07-12 Phase 13 漏洞續掃

- **trigger function 的 EXECUTE 與 RLS 內函數的 EXECUTE 是兩回事**：trigger fire 時不檢查呼叫者對 trigger function 的 EXECUTE（可安全 revoke 擋 RPC）；RLS policy 內呼叫的函數則以查詢角色檢查 EXECUTE（revoke 即全掛）。判斷方式：函數被「系統」呼叫還是被「查詢」呼叫。
- **connect-time lookup 是 SSRF rebinding 的正解**：`undici Agent({ connect: { lookup } })` 讓驗證過的 DNS 結果就是連線目標；pre-check 只當 fast-fail 用。IP literal 不會觸發 lookup，必須另外前置擋。
- **fetch spec 有 bad-port 清單**：port 9/22/25 等會在連線前被 fetch 本身擋掉（error: bad port），寫 SSRF 測試時別用這些 port 當目標，會誤判防護來源。
- **加密遷移先查存量**：production `extra_headers` 帶值筆數為 0，直接「新寫入走加密、舊列 fallback」即可，不用寫資料遷移工具。

## 2026-07-12 全專案健檢

- **長時間 API 不可同步等待**：任何「完成前零輸出」的 route（LLM pipeline、匯出）都會被 client socket read timeout 殺掉，且行動端跳背景即斷線。模式：立即回 jobId + `after()` 背景執行 + 輪詢/Realtime 回報。設計新長操作時先問「client 端最短 timeout 是多少」。
- **原則要在程式層 enforce，不能只靠 prompt**：`locked_by_human` 與 notes/ 唯讀寫在 prompt 裡三個月，工具層卻完全沒擋——LLM 一直有能力覆寫鎖定頁。凡是「LLM 不可以做 X」的規則，一律在 tool execute 裡加 guard。
- **代理 route 是驗證繞過的溫床**：`/api/lint/cron` 自己沒驗證還替呼叫者補上正確 secret。任何轉發 route 都要先驗證入站身份，或直接刪掉讓 cron 打真正的端點。
- **正則式 SSRF 防護必繞過**：hostname 前綴 regex 擋不住 `[::1]`、`169.254.169.254`、DNS rebinding。標準修法：IP 正規化 + dns.lookup 全 IP 比對 + redirect manual 逐跳驗證。
- **revoke/grant migration 要看函數在 RLS 裡的角色**：`owns_workspace` 被 0009 revoke 後 client 直查全掛，0011 的 re-grant 是必要修復不是漏洞。RLS policy 內呼叫的函數，querying role 必須有 EXECUTE。
- **setError 型全頁錯誤會吃掉使用者狀態**：page-viewer 的 save 失敗原本把整個編輯器換成錯誤畫面（草稿看不到了）。動作型失敗用內嵌 banner，資料載入失敗才用全頁錯誤。
- **workflow 審計的發現要先驗證再修**：6 個 security 發現中 2 個被對抗性驗證駁回（synthesis「注入」其實無能力提升、0011「回退」其實是必要 grant）。直接照單全收會把必要的 GRANT revoke 掉、直接把 prod 打掛。
- **Compose `remember` = 旋轉即丟**：任何使用者輸入（編輯器、對話框草稿）一律 `rememberSaveable`（TextFieldValue 要帶 `stateSaver`）。
- **同一事件重複觸發要靠 token key**：`LaunchedEffect(value)` 對相同 value 不會重跑；外部 intent 事件要帶遞增 token 一起當 key。
