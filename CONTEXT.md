# CONTEXT.md — 開發交接文件

> 給下一個 AI Agent 的接手指南。架構與規範細節以 `CLAUDE.md` / `AGENTS.md` 為準，這裡只記「最近做了什麼、為什麼、還缺什麼」。

## 最近一次變更（2026-07-14，Phase 16e 機械判斷歸程式、語意判斷歸模型）

使用者：「修復導入內容的問題 / 維護鍵之前不是成功了嗎怎麼突然有問題 / 可以用腳本處理部分問題不一定要全用模型判斷」。查 production job 表後找到兩個真 bug，一個誤判：

1. **導入會靜默失敗（7/22）**——`ingest_jobs` 裡有一批 `status=done`、`touched_pages=[]`、只跑 5–12 秒的 job：模型只回了一段話、沒呼叫任何工具，`runIngestPipeline` 卻無條件把 job 標成 `done`。使用者看到「匯入完成」，wiki 完全沒變，整篇文章等於沒進來（受害來源：川普馬斯克大和解、中俄關係逆轉、央行經濟學人回應、老黃CSIS訪談、美國軍工生產危機、盧特尼克效應、賴清德紐時專訪——全在「地緣政治與全球貿易」）。修法：`touchedSlugs` 為空 → 同一段對話追加 `NUDGE_PROMPT` 再跑一輪（provider 錯誤等 5s）→ 兩輪都沒寫入就 **throw**，route 的 `after()` 把 job 標 `failed`。**寫沒寫進去是程式驗的，不是模型說了算。**
2. **「維護鍵之前成功」是我誤判**——Phase 16c 我拿「8 輪 / 94 個操作 / 工作區 10 → 6」當成功指標，但那個「收斂」本身就是同一個崩壞行為（把不相關工作區的頁面掃進一處再刪殼），只是當時我只看計數器沒看頁面去了哪。它從來沒有真的成功過。
3. **照使用者說的做：能用程式判斷的就不要問模型**（新檔 `apps/web/lib/ai/organize-mechanical.ts`）：
   - `sweepEmptyWorkspaces()`：刪掉「只剩 index.md/log.md」的工作區——純程式，在 LLM 迴圈**前後各掃一次**（跑完當場清掉這輪被搬空的殼，不必等下一輪接力）。跳過當前工作區、跳過 1 小時內建立的（自動路由剛建好、ingest 還在跑的不能被掃掉）、`created_at` 解析不出來就不刪。
   - 維護 pipeline 傳 `allowWorkspaceDelete: false` → **模型連 `deleteWorkspace` 工具都拿不到**，Phase 16d 的白名單 (`deletableWorkspaceIds`) 因此被移除（一個機制就好）。刪工作區沒有任何判斷成分，卻是唯一失手就毀掉整個書架的動作。
   - `findDuplicateClusters()`：用 `canonicalWikiAlias`（大小寫／資料夾前綴／`.md`）＋ 標題完全相同，跨工作區算出重複叢集，把答案直接寫進 prompt（`# Exact duplicates the system already found for you`）。模型只負責語意重複與分類。
   - 測試：`lib/ai/organize-mechanical.test.ts`（7 個）＋ `lib/ai/tools.test.ts`（維護拿不到刪工作區工具）。`bun test lib/ai/` → 8 pass。

4. **`/api/sources/[id]/reingest` 是第三個漏 profile fallback 的 route**（`/api/ingest`、`/api/query` 已於 16d 修）：工作區都沒綁 `*_profile_id` → 按「重新整合」一律 422，等於這顆按鈕從來沒能用過。fallback 抽成 `lib/ai/profile.ts` 的 `loadDefaultProfileId()`，三個 route 共用。

**production 復原（已完成）**：7 篇「以為匯入成功、其實 0 頁」的來源全部用 `reingest` 重跑，全數成功——川普馬斯克大和解 5 頁、中俄關係逆轉 8、央行經濟學人回應 6、老黃CSIS訪談 7、美國軍工生產危機 5、盧特尼克效應 6、賴清德紐時專訪 8（共 45 次頁面寫入）。「地緣政治與全球貿易」知識頁 53 → 61。全庫 142 個知識頁、**alias 重複叢集 0**（新版 ingest 的去重清單有效）。

**待辦**：剩一個空的「My Wiki」——下次按維護時會由 `sweepEmptyWorkspaces()` 自動掃掉（順便就是新防護的第一次實戰驗證）。

## 上一次變更（2026-07-14，Phase 16d 導入路由 + 去重 + provider 容錯）

使用者要求：修掉 `Failed after 3 attempts. Last error: Provider returned error`；並確認統一導入「能正確分類到對應工作區、完美整合避免重複、必要時自己建立新工作區」。四個修法：

1. **provider 暫時錯誤不再毀掉整趟維護**：`runOrganizePipeline` 的每一輪 `generateText` 都 catch → 等 8s 重跑同一輪；預算用完就以 `done + more_work` 收尾讓 client 接力。**只有整趟 0 變更才把錯誤 throw 給使用者**。以前最後一輪被限流就整個 job 標 failed，前面 90 幾個操作看起來像白做。
2. **導入去重靠 DB 頁面清單**：`runIngestPipeline` 之前只給模型 `index.md`＋來源，模型看不到實際有哪些頁 → 同一實體很容易再開一頁。現在把該工作區所有 wiki 頁（`pages` 表 slug/kind/title，上限 400）注入 prompt，並要求「同主題就 readPage 改寫既有頁，不要寫近似 slug」。
3. **路由可以自建工作區**：`routeToWorkspace()` 允許模型回 `NEW: <名稱>` → `createWorkspaceForUser()`。防護：上限 12 個工作區、`NEW:` 名稱與既有工作區不分大小寫比對命中就沿用（批次導入是逐檔序列送出，否則會生同名雙胞胎）、整庫還沒有知識頁時直接 fallback。回應多帶 `routed_workspace_created`，Web/Android 收到就刷新工作區選單。
4. **`/api/ingest` 補 profile fallback**：production 的工作區**全部**沒有 `default_profile_id`（profile 是工作區建立後才加的），client 只要沒帶 `profile_id` 就 422「No LLM profile configured」。改成跟 `/api/organize` 一樣退回 owner 的 `is_default` profile。

**⚠️ 同一次驗證中踩到的重大問題（已修＋已復原）**：為了驗 provider 容錯，我在 production 按了維護。gemini-3.5-flash 把「合併工作區」執行成「把所有頁面掃進被觸發的那個工作區，再刪掉空殼」——兩輪內把「個人理財與退休規劃」14 頁全倒進「地緣政治與全球貿易」並**刪掉整個工作區**（頁面沒丟，但少了一個書架，UI 只顯示「已變更 N 項」）。修法兩層：(1) 機械式防護 `deletableWorkspaceIds`——維護 job 只能刪「本輪開始時知識頁數＝0」的工作區，合法合併靠 `more_work` 接力在下一輪刪空殼（`apps/web/lib/ai/tools.test.ts` 有測試）；(2) prompt 補「每次搬移必須讓目標工作區更內聚／當前工作區不是垃圾桶／不同主題不可合併／不要為了刪而清空」。復原方式：`/api/workspaces` 重建工作區 + 用 chat 的 `movePageToWorkspace` 把 19 頁精確搬回（本機 Google client secret 已失效，無法跑本地腳本）。最終狀態＝原本的 AI 29 / 科技 33 / 地緣 53 / 理財 14（科技少 1 頁是正常的重複頁合併）。**下次要動維護按鈕前，先確認新防護在真實資料上跑過一次。**

**production 實測**（用瀏覽器直接打 API）：
- 路由：把一段已存在於「科技產業動態」的 Cloudflare 財報內容，從「地緣政治與全球貿易」用自動判斷導入 → `routed_workspace_name: 科技產業動態`（不是 fallback）。
- 去重：該次 ingest 觸及 5 個知識頁，**全部是既有 slug**（`entities/cloudflare.md`、`summaries/cloudflare_2026_q1.md`、`concepts/workers_platform.md`…），工作區知識頁數 34 → 34，**零新增重複頁**。
- 自建工作區：導入一段手沖咖啡筆記（與四個工作區都無關）→ `routed_workspace_created: true`，新工作區「咖啡與生活品味」+ 5 頁。測完已用 `DELETE /api/workspaces/{id}` 刪除（順帶再驗一次 0018 的刪除路徑：回 `{ok:true}`），測試用的 source row 也已清掉。

## 上一次變更（2026-07-13，Phase 16c 真正的跨工作區深度重整）

使用者要的不只是刪重複頁，而是「跨全部工作區一起看：去重、重新分類、工作區改名／建立／刪除，非常深入的分類」。修完逾時後第一次實測只跑了 60 秒 / 5 個操作就自己收工——太淺。挖出四個獨立的原因，全部修掉：

1. **inventory 沒有內容**（只有 slug/kind/title）→ 模型只認得出 slug 完全相同的重複頁，看不出「這頁該搬去哪個工作區」。改成帶入每頁的 `search_text` 摘要（DB 已存前 2000 字，不用額外讀 Drive）。
2. **prompt 叫它別深入**：修 timeout 時我加的「do not read every page just to look」直接讓它變淺。改寫成明確的深度重整任務書。
3. **單次 generateText 講完就結束**，沒有任何機制逼它用完預算 → 改成 **loop-until-dry**（每輪把「還沒處理的事」丟回去，直到回 `ORGANISE_COMPLETE`／連兩輪零變更／預算用盡）。
4. **一次 invocation 做不完**：實測 214s 預算用盡時才剛把「科技研究」9 頁中的 6 頁搬走，空掉的工作區沒刪。→ migration `0017` 加 `agent_jobs.more_work`，Web/Android 收到 `done && more_work` 自動接下一輪（上限 6 輪），pill 顯示累計變更數。

**最大的坑（migration 0018）**：AI 一直不肯刪空工作區，只把它們改名成「【準備刪除】…」「【已空】…」。以為是 prompt 保守，實際上是 **DB bug——任何工作區都刪不掉**：`bump_workspace_sync_revision()`（pages 的 AFTER DELETE trigger）會對已被 CASCADE 刪掉的 workspace_id 做 INSERT → FK 違規 → 交易回滾。`DELETE /api/workspaces/{id}` 直接 500，Web/Android 的刪除鍵一樣壞，AI 是被工具反覆拒絕才繞路的。trigger 改成 workspace 不存在時 `RETURN NULL`；`deleteWorkspaceForUser` 也補上「DB 刪除失敗時把已 trash 的 Drive 資料夾還原」。

**實測結果**（在 production 按下按鈕全程監控）：一次按鈕 → 自動接力 8 輪 → **94 個操作**。工作區 10 → 6：合併「理財＋總體經濟＋各種個股研究」成「個人理財與退休規劃」、「科技研究」併入「科技產業動態」、「訪談」拆散歸位後刪除、「國際政治」改名「地緣政治與全球貿易」，4 個空工作區真的被 `deleteWorkspace` 刪掉。

> 未做：最後兩輪撞到 OpenRouter `Provider returned error`（連跑 7 輪重負載後的限流），還剩兩個空的「My Wiki」沒刪掉——再按一次按鈕即可清掉。provider 暫時性失敗會讓該輪 job 標成 failed 並中斷接力鏈（changes 已落地），目前沒有自動重試，先觀察是否需要。

## 上一次變更（2026-07-13，Phase 16b 自動整理逾時修復）

使用者回報：按「自動分類」跑出 `Organize timed out`，而且**看不到任何變化**。查 production `agent_jobs` 發現 job 其實有做 14 個操作、卻在 532 秒被判逾時。兩個獨立的 bug 疊在一起：

- **root cause 1：工具層 slug 盲目補 `.md`（真正讓它「沒有變化」的原因）**。舊資料留著一批**沒有副檔名**的 slug（`concepts/HBM`、`concepts/Advanced_Packaging`、`concepts/Data_Center_Infrastructure`、`synthesis/Crypto_Fintech_2026_Q2`）。inventory 把原始 slug 餵給模型，但 `readPage`/`deletePage`/`movePage` 都先 `normalizeSlug()` 補成 `X.md` 再查 → **永遠查無此頁**。模型的因應是：`writePage` 一個新的 `X.md`（等於製造第三個重複頁），再 `deletePage` 同一個 `X.md` —— **刪掉自己剛寫的頁**，原本的舊頁分毫未動，然後不斷重試直到被砍。失敗 job 的 progress 完全對得上：`writePage:concepts/HBM.md` 緊接 `deletePage:concepts/HBM.md`，四頁皆然。修法：`resolveExistingSlug()` 問 DB 實際存在的 slug（優先 `.md`、退回字面 legacy row），`readPage`/`writePage`/`deletePage`/`movePage`/`movePageToWorkspace` 全部改走它；`writePage` 命中 legacy row 時順手把 slug 收斂成 `.md`（`page_links.from_slug` 一併搬移），資料會自然收斂，不需要 migration。
- **root cause 2：pipeline 沒有 wall-clock 預算**。Vercel `maxDuration = 300s` 一到直接殺掉整個 invocation（含 `after()`），被殺的 run 來不及寫 job row → 停在 `running` → 8 分鐘後才被 GET 的 stale sweep 掃成 `Organize timed out`。加 `TOOL_LOOP_BUDGET_MS = 210_000` 到 `stopWhen`，自己先優雅停下並標記 `done`（每個工具呼叫各自 commit，中途停下 wiki 仍一致，使用者再按一次即可續做）。stale sweep 8 分鐘 → 6 分鐘，避免死掉的 job 用 one-at-a-time 鎖把下一次按鈕 409 擋住。

驗證方式：以 production 實際資料模擬新舊解析器，「舊版查無此頁」的 slug 恰好就是失敗 job 裡 churn 的那 4 頁，1:1 對上。`bun run typecheck` / `bun run build` / `assembleDebug` 皆通過。

> 未做：沒有替那 4 個 legacy row 寫 migration——工具修好後維護 job 本來就該把它們合併掉，這正是它的工作。若之後發現它仍合不掉，再考慮資料面處理。

## 上一次變更（2026-07-13，Phase 16 維護合一 + AI 真權限）

使用者三點回報，全部完成（Web + Android）：兩顆維護按鈕合成一顆、整理去重要真的會動、不要報告頁。

- **一顆按鈕 = 一個 pipeline**：健康檢查（lint）與整理去重（organize）不再是兩支 job。Web 頂列 `Wrench`、Android drawer `Build` 各一顆 → confirm → `POST /api/organize`。`runOrganizePipeline`（`lib/ai/organize-pipeline.ts`）一次做完：修失效連結／矛盾／孤兒／stub → 合併重複 → 跨工作區歸位 → 調整工作區 → 更新 index.md / log.md。
- **「整理去重沒作用」的 root cause**：`ai_confirm_destructive` 預設 true → 背景 job 沒有 `onProposal` → `gateDestructive` **直接拒絕所有刪除**，模型只能寫「建議刪除」在報告裡；加上 pipeline 當時還手動 strip 掉 create/rename/deleteWorkspace 工具。修法：維護 job 傳 `confirmDestructive: false`（按鈕上的 confirm dialog 就是授權），且不再 strip workspace 工具。現在它真的能刪重複頁、改名／建立／刪除（僅限已清空的）工作區、重排順序。對話流程的確認卡片機制**不受影響**（照舊預設需確認）。
- **不再產生報告頁**：prompt 硬性禁止 `_lint/*`、`_organize/*`；`report_slug` 永遠 null，pill 改顯示「已變更 N 項」（來自 `agent_jobs.progress` 的工具呼叫紀錄）。
- **新 AI 工具 `reorderWorkspaces`**（寫 `workspaces.sort_order`）：補齊使用者要求的「AI 可重新排序工作區」。漏傳的 workspace 自動補在尾端，不會從清單消失。
- **刪除 `/api/lint` route + `vercel.json` cron + `CRON_SECRET`**：週期性、無人看管地跑一個有刪除權的 pipeline 太危險，而且 cron 會持續生報告頁。要恢復排程請先設計破壞性動作的授權模型。⚠️ 舊 Android APK 打 `/api/lint` 會 404，需更新。
- **`_schema/lint.md` 語意翻轉**：從「只寫報告、不要自動修」改成「檢查並直接修正」的清單，並以參考身分注入維護 pipeline（舊 workspace 的 Drive 內還是舊文案，prompt 已明講忽略其中的「寫報告／不要修」字眼）。

## 上一次變更（2026-07-13，Phase 15 連結修復 + 維護整合 + 來源重跑）

使用者連續回報 5 項，全部完成（Web + Android）。

- **藍色 wiki 連結 `[PAGE_NOT_FOUND]`**：root cause 是 `page_links` 有 225/600 dangling（37.5%）——連結 slug 缺 `concepts/` 前綴、大小寫、`.md` 有無不一致（126 條頁面其實存在，99 條真失連）。正解放在**伺服器咽喉點**：`GET /api/pages/[...slug]` exact miss 時用 `canonicalWikiAlias`（新 `apps/web/lib/wiki/slug.ts`）做**唯一匹配**才 resolve（ambiguity 僅 1 筆，安全）。一次修好所有 client（Web/Android/直接分享 URL）。真失連改顯示友善訊息（`wiki.linkedPageMissing`），不再噴原始 error code。
- **知識圖譜亂**：同一 root cause。`graph-view.tsx` 過去把 dangling 邊直接餵 force-graph → 生一堆幽靈節點。現在 client 端把邊端點經 alias 解析成真實節點 id，解不到就濾掉（+ 去重）。不動資料，survives writePage 重寫。
- **健康檢查 + 自動分類兩顆按鈕整合**：lint 從**同步** `await generateText` 改成 **job 化**（migration `0016` 讓 `agent_jobs.kind` 收 `lint`；POST `after()` 背景跑 + GET `?job_id=` 輪詢 + stale sweep；cron GET 保留 Bearer 驗證路徑）。與 organize **共用 agent_jobs 的 one-at-a-time 鎖** → 自然變「一次一個維護任務」。Web 頂列改一顆 `Wrench` 維護選單（健康檢查／自動整理＋去重）+ 統一進度 pill（進行中含「可關頁面背景續跑」提示／完成含「查看報告」／失敗）+ localStorage 記 jobId 讓重載/關頁面回來續 poll。Android drawer 改 `Build` 選單，`runMaintenance(kind)` 泛化 lint/organize。
- **已匯入來源修復**：2 筆 ingest 失敗（LLM provider 暫時性錯誤，text 來源，內容已在 Drive）。新 route `POST /api/sources/[id]/reingest`：讀 Drive 既有內容 → 建新 ingest_job → 重跑 `runIngestPipeline`，沿用 `/api/ingest?job_id=` 輪詢。Web `SourcesDialog` + Android `SourcesListDialog` 每列加「重新整合」按鈕。

⚠️ **協定破壞性變更**：`POST /api/lint` 不再回 `{ ok, reportSlug }`，改回 `202 { jobId }`。所有 client caller 已同步改（舊 Android APK 需更新）。cron `GET /api/lint`（Bearer CRON_SECRET）不變。

> Phase 15 的「維護按鈕整合」只是把兩個動作收進同一個選單；Phase 16 才真正合成單一動作與單一 pipeline。以下段落中關於 `/api/lint`、報告頁、`Wand2`/`FlaskConical` 的描述皆已作廢。

## 上一次變更（2026-07-13，Phase 14 對話中心化 + 跨工作區 AI）

**產品方向轉變**：從「筆記 + 導入框」轉為「對話驅動」。使用者在對話講想法，AI 判斷有價值的內容 → 直接整理進知識頁；破壞性操作走確認卡片。

### 主要改動
- **筆記 UI 全移除（資料保留）**：Web `page-tree.tsx`/`workspace-shell.tsx`、Android `WikiScreen`/`WikiViewModel` 的筆記新增/改名/刪除全砍。**Drive `notes/` 資料夾、`/api/pages/[workspaceId]` 的 notes CRUD route 都還在**，只是沒入口。`guardWikiSlug` 照舊擋 `notes/`。
- **跨工作區 AI 工具**（`lib/ai/tools.ts`）：`ToolContext` 加 `userId`/`crossWorkspace`/`confirmDestructive`/`onProposal`/`locale`；頁面工具吃可選 `workspace_id`（`resolveScope` 必帶 owner 檢查）；新增 `listWorkspaces`/`createWorkspace`/`renameWorkspace`/`deleteWorkspace`/`movePageToWorkspace`。page write/delete core 抽成 module-level `writePageForWorkspace`/`deletePageForWorkspace`，與 `/api/agent/execute` 共用。
- **破壞性操作確認**：偏好存 auth `user_metadata.ai_confirm_destructive`（預設 true）。需確認時工具不執行 → 串流尾端 `\x00ACTIONS\x00[...]` → 前端確認卡片 → `POST /api/agent/execute` 用同一份 core 重跑（guard 全部再驗，client 無法竄改）。背景 job（organize）沒 UI 確認，`gateDestructive` 在無 `onProposal` 時直接拒絕動作。
- **對話 context**：`/api/query` 加 `current_slug`（當前頁自動當上下文）+ `context_workspace_ids`（`@` 標記工作區，逐一驗 owner）。
- **統一導入**：`import-dialog.tsx` 取代舊的頂部導入框。`/api/ingest` 的 `workspace_id` 改 optional，加 `auto_route`+`fallback_workspace_id`，`routeToWorkspace()` 用一次 LLM 選目標工作區（**失敗一律 fallback**）。
- **自動分類＋去重複**：`/api/organize` + `agent_jobs`（migration `0015`，**已套用 production**）。跨全部工作區去重/歸位，報告頁 `_organize/YYYYMMDD.md`。
- **其他**：profile PATCH 編輯（api_key 留空保留）、切工作區/設定頁效能修復（`ensureWorkspaceSystemPages` 移進 `after()` + 併 Promise.all）、工作區拖曳 FLIP 動畫、Graph Obsidian 化（degree sizing/canvas 標籤/hover 高亮/孤兒淡化）。

### 對抗性審查修復（同輪，review workflow 提出）
9 條 confirmed findings 全修：organize stale job 卡死（POST 前先 sweep + `.limit(1)`）、ingest 抓 URL 前先驗 workspace ownership（防 fetch proxy）、deletePage 確認卡片前先查 lock/existence、cross-workspace readPage 不污染當前工作區 citations、organize 不給 workspace 生命週期工具、organize 只在報告頁真的存在時才回 `report_slug`、profiles PATCH 先驗 id owner 再清 is_default、`\x00ACTIONS\x00` parser 要求 `params` 物件、`movePageToWorkspace` 來源刪除失敗時 rollback 目標寫入、migration 0015 檔案改 idempotent、AI 建/改工作區後刷新選單（`onWorkspacesChanged` / Android `refreshWorkspaces`）。
> ⚠️ 審查 workflow 因 session 額度中斷（21 agents / 2 完成），findings 由 correctness + karpathy-ux 兩個 reviewer 提出、主 agent 逐條人工對照程式碼確認為真後修復；security + client-parity reviewer 未跑完，**下輪可補跑那兩維度**（scriptPath 見 workflows 目錄）。

## 上一次變更（2026-07-12，Phase 13 漏洞續掃 + 對齊）

- **`extra_headers` 加密（P3 清償）**：migration `0013` 新增 `extra_headers_encrypted bytea`；POST `/api/settings/profiles` 以 AES-256-GCM 加密（重用 `encryptApiKey`）、GET 完全不回傳 headers（無 UI 消費它）、`createLLMClient` 解密（`extra_headers_encrypted` 優先，legacy 明文 jsonb fallback）。production 當時 0 筆帶 headers 的 profile，無需資料遷移。
- **SSRF TOCTOU 關窗**：`url-to-markdown.ts` 改用 `undici` 的 `Agent({ connect: { lookup: guardedLookup } })` + `undiciFetch`——連線當下驗證的 DNS 結果就是實際連上的 IP，rebinding 無窗口。已用 node 腳本實測（public host 過、localhost 擋、lookup 確實被呼叫）。注意 fetch spec 的 bad-port 清單（port 9 等）會先於 lookup 擋掉。
- **migration `0014`**：revoke `broadcast_page_metadata_change()` 的 anon/authenticated EXECUTE（advisor 0029）。先在 production 以 rollback transaction 實測 trigger 不受影響才套用。`owns_workspace` 的 WARN 是接受的設計（RLS 依賴），不可 revoke。
- **Sources 管理列表**（Karpathy 缺口 #2）：Web `components/wiki/sources-dialog.tsx`（頂列 `Library` icon）+ Android `SourcesListDialog`（drawer 底列 `LibraryBooks` icon）。都直查 Supabase `sources` + `ingest_jobs`（RLS），各 source 配最新 job 的 status/touched 數。純檢視——來源不可編輯。
- **Ingest 即時進度**（Karpathy 缺口 #3）：pipeline `onStepFinish` 逐步把 touched slugs 寫回 `ingest_jobs.touched_pages`（status 仍 running）；Web/Android 輪詢時顯示「整合中…已更新 N 頁」。
- **Android backlinks 面板**（對齊 Web）：`loadBacklinks()` 直查 `page_links`，MarkdownViewer 下方 AssistChip 列。
- **Android 離線冷啟**：最後使用的 workspace（JSON snapshot）存 DataStore；`refreshWorkspaces()` 失敗時還原，Room 快取可瀏覽。
- **Android chat 草稿**：hoist 至 `WikiUiState.chatDraft`，sheet 關閉不再丟失。
- 新增依賴：`undici@8.7.0`（apps/web）。

## 上一次大型變更（2026-07-12，Phase 12 全專案健檢）

### 核心：Ingest 改為非同步 job（手機匯入逾時的根因修復）

舊行為：`POST /api/ingest` 同步跑完整 LLM pipeline（最長 300s），完成前零輸出 → Android Ktor socket timeout 必炸、App 跳背景斷線、Web fetch 長時間懸掛。

新架構：
- `POST /api/ingest` → 驗證/抓取來源/建 job 後立即回 `202 { jobId, status: 'running' }`，pipeline 用 `after()`（next/server）在回應後執行
- `GET /api/ingest?job_id=` → `{ jobId, status, error, touched_pages }`；`running` 超過 8 分鐘自動掃成 `failed`
- Web `conversation-panel.tsx` 的 `pollIngestJob()` 與 Android `WikiViewModel.pollIngestJob()` 每 3s 輪詢；完成顯示「已更新 N 頁」
- job 一開始就以 `status='running'` + `started_at` 插入（不經 `pending`），避免 crash 留下無法清掃的殭屍 row

### 安全修復（已驗證）

見 CLAUDE.md「安全注意事項（Phase 12）」表。重點：
- **P0**：`/api/lint/cron` 無驗證代理已刪除，vercel.json cron 直指 `/api/lint`
- **P1**：`url-to-markdown.ts` SSRF 全面重寫（IP 正規化 + DNS 檢查 + 逐跳 redirect）
- **P2**：`lib/ai/tools.ts` 加了 lock/zone/protected-slug 硬性防護——這是 Karpathy 原則 3/5 第一次在程式層 enforce，之前只靠 prompt
- migration `0012_tighten_oauth_token_grants.sql` **已套用至 production**（mjuciqffwayydobpxzcz）
- ⚠️ production migration history 只記到 0010；0011 是先前手動套用（不在 history），0004/0005 同理——不要用整批 `db push`

### 已知未修（接手者注意）

1. **Lint 仍是同步呼叫**（Android socket timeout 已拉到 310s 覆蓋），流量大時可比照 ingest 改 job 化。
2. **Leaked Password Protection**（Supabase advisor）：需在 Dashboard Auth 設定手動開啟；本專案只用 Google OAuth，不影響現有流程。
3. legacy `extra_headers` 明文列（Phase 13 之前建立且帶 headers 的 profile）仍以明文供 `createLLMClient` fallback；production 確認為 0 筆，自架者如有既有資料可重建 profile 即完成加密。

（Phase 12 清單中的 extra_headers 明文、SSRF TOCTOU、Android 離線冷啟、chat 草稿四項已於 Phase 13 修復。）

### Karpathy 精神現況評估

**已到位**：ingest=編譯（prompt 要求 5-15 頁 cascade）、sources immutable、query file-back、分離原則（程式層硬防護）、lock 機制（同上）、schema 共同演化、Realtime live wiki、lint 迴圈、graph view、backlinks 面板（Web + Android）、Sources 管理列表（Phase 13）、Ingest 逐頁即時進度（Phase 13）。

**剩餘缺口**：
1. **矛盾呈現**：prompt 要求記錄 contradiction，但只進 log.md，無專門 UI。
2. **來源重新編譯**：Sources 列表目前純檢視；「re-ingest 這個來源」入口尚未做（需考慮 sources immutable 語意——重新編譯應建新 job 而非改來源）。

### UX 大修摘要（细節見 git log）

Web：三欄 shell 手機自動收合＋觸控拖曳（pointer events）、瀏覽器返回鍵走 wiki 足跡（pushState/popstate）、Ctrl+K 搜尋＋鍵盤導航、五個對話框 a11y（ModalShell：role/aria/Escape/取消鍵 autoFocus）、聊天串流可中止（保留部分回答）、lock/save 失敗改用內嵌錯誤條（不再吃掉整頁與編輯器）、未儲存草稿保護（confirm + beforeunload）、lint 失敗全域錯誤條＋reportSlug 正確導航（`/api/lint` 現在回 `reportSlug`，並把今天日期告訴模型）、profile 刪除確認、graph i18n/ResizeObserver/圖例/主題色。

Android：rememberSaveable 全面補齊（旋轉不丟草稿）、BackHandler（搜尋/編輯器）、chat sheet 內嵌錯誤（原本被全螢幕 sheet 蓋住）、syncError 可關閉、同步 spinner（syncLoading）、分享同一 URL 兩次可重觸發（ExternalEvent token 傳遞）、錯誤訊息全面本地化（error_op_* strings）、工具列改 FilledTonalButton（48dp 觸控目標）、surfaceContainer 色票、DayNight 主題（淺色冷啟不再黑閃）、FilterChip 選擇、launchSingleTop。

## 驗證指令

```bash
bun run typecheck            # 全綠
bun run build                # 全綠
cd apps/android && .\gradlew.bat :app:assembleDebug   # BUILD SUCCESSFUL
```

## 環境

- Supabase production：project `mjuciqffwayydobpxzcz`（llm-wiki, ap-southeast-1）
- Vercel：apps/web，Fluid Compute（無 cron；`vercel.json` 已於 Phase 16 刪除，`CRON_SECRET` 可從 Vercel 環境變數移除）
