# Lessons

## 2026-07-13 Phase 14 對話中心化 + 跨工作區 AI

- **AI proposal 的 params 來自 client，執行端不可信任**：破壞性操作確認流程是「工具回 proposal → client 顯示卡片 → client 帶 params 回 execute route」。execute route 必須用 zod 白名單只收允許欄位、重新做 owner 檢查、並呼叫**與工具同一份 core 函式**（zone/lock/protected guard 才會全部再跑一次）。若信任回傳 params 或另寫一份執行邏輯，就能繞過所有防護。
- **背景 job 的破壞性 gate 要 fail-closed**：`gateDestructive` 一開始無條件回「已顯示確認卡片」，但 organize 這種背景 job 沒有 `onProposal` channel。無 channel 時必須「拒絕動作 + 要求模型改列報告」，不能對模型謊稱卡片已顯示（否則模型以為在等確認，實際沒人會確認，動作永遠不執行且使用者不知情）。
- **為了 A 功能調整順序，別順手引入 B 漏洞**：ingest 為了 auto-route 需要來源內容，把「抓 URL」提到「workspace ownership 檢查」之前——瞬間變成未授權 fetch proxy。**任何外部 fetch 一律排在 ownership/authz 之後**。改動既有 route 的執行順序時，回頭檢查原本靠順序保證的安全性質有沒有被破壞。
- **async job 的並發鎖要能自癒**：`.eq('status','running')` 當並發鎖，但 `after()` 被 Vercel kill 會留下永遠 running 的殭屍 row → 之後每次都 409。鎖要帶 staleness 窗口（POST 前先把過期 running 掃成 failed），且 `.maybeSingle()` 遇到 2+ row 會 error→null→放行，要改 `.order().limit(1).maybeSingle()`。
- **job 回報的 report_slug 要驗證真的存在**：pipeline 事先算好 slug 就無條件寫回 `report_slug: done`，但模型可能沒真的寫那頁（step budget 用完）。client 導航過去就 page-not-found，成功的 run 看起來像壞了。回報前先查頁面存在。
- **cross-workspace 讀取不要污染當前工作區的 citations**：`readPage` 加了 `workspace_id` 後，`onPageRead` 仍記 bare slug，導致 @ 其他工作區的頁面被當成當前工作區 citation chip（點了 dead link、file-back 寫出 dangling link）。callback 要 `if (scope.workspaceId === ctx.workspaceId)` 才記。
- **workspace-scoped 的 cache key 要帶 workspace id**：Drive folder cache 從單一工作區改跨工作區時，key 從 `path` 改成 `${workspaceId}:${path}`，否則不同工作區同名資料夾會撞。
- **workflow 審查中斷也有價值**：review workflow 因 session 額度中斷（21 agents 只跑完 2），但那 2 個 reviewer 提出的 findings 讀 `journal.jsonl` 撈得回來，主 agent 逐條人工對照程式碼確認即可（verifier 沒跑完不代表 findings 無效）。撈 findings：`grep type=result` + 過濾有 `findings` 欄位的 result 行。
- **"重複顯示" 類 bug 先分清 render vs 版面**：使用者說「輸入框重複顯示兩次」，實際不是 React 把 user message render 兩次，而是頂部導入 textarea + 底部對話 input 兩套介面樣式相近堆在一起。動手查 render 邏輯前先確認是不是版面觀感。

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
