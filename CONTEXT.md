# CONTEXT.md — 開發交接文件

> 給下一個 AI Agent 的接手指南。架構與規範細節以 `CLAUDE.md` / `AGENTS.md` 為準，這裡只記「最近做了什麼、為什麼、還缺什麼」。

## 2026-11-08 抽屜工具直接列出（Android 0.8.8 / versionCode 20）

- **已發布**：GitHub Release `v0.8.8`（tag 指向 `7e33b39`），APK `llm-wiki-0.8.8.apk` SHA-256 `85fb7bbf…335f`，簽章與 0.8.6 相同（可覆蓋安裝）；`releases/latest/download/llm-wiki-0.8.8.apk` 實測 200。

- 使用者覺得「更多」選單難用：要多點一次，選單還會蓋住清單。抽屜底部改成直接列出來源清單、匯入佇列（有進行中的匯入時顯示數字）、知識圖譜、整理知識庫（執行中顯示轉圈並停用），最下面一排是設定、使用說明、登出。匯入佇列在對話「＋」與匯入橫幅的入口保留。
- Web／Android 對齊檢查：功能兩邊都有（來源清單＋重新整合、匯入佇列＋暫停／重試、圖譜＋洞察、整理知識庫、搜尋、工作區管理與排序、對話＋@、事實模式、存成綜合頁、確認卡片、反向連結）。使用說明兩邊都過時（「機器人按鈕」「魔杖」「燒杯＋_lint 報告」），已改成現況；Android 補上「搜尋、圖譜與整理」段。刻意不同的只有版面：網頁用「更多」選單，手機直接列在側邊欄。剩下的小差異沒改：網頁頁首有「AI／使用者」標記、網頁編輯器有格式工具列、網頁有「此頁面已更新」橫幅（手機改靠自動同步與開頁時的 ETag 檢查）。
- Pixel 6a 實測：版面完整，匯入佇列顯示 1，點下後開啟佇列對話框；使用說明顯示新內容。
- **側邊欄改成上下兩排捷徑（使用者覺得混了三種樣式很怪，從三個方案中選定）**：工作區名稱下方一排「來源／佇列／圖譜／整理」，最底一排「設定／說明／登出」，兩排共用 `DrawerShortcut`（圖示在上、短字在下，TalkBack 唸完整名稱與佇列數字）；頁面清單從 `NavigationDrawerItem`（56dp 大字）改成 44dp 一般字級，選中用 secondaryContainer 底色。Pixel 6a 截圖確認三段對齊、頁面清單可見列數變多。
- **文件**：README 重寫（功能現況、架構圖、專案結構、Vault worker 設定、Release 改連 latest，移除已不存在的燒杯／lint 報告／筆記管理／v0.7.0）；CONTRIBUTING 修正 `ENCRYPTION_KEY` 是 base64、刪掉已移除的 `CRON_SECRET`、補 `WEB_API_BASE_URL` 與 `packages/ui`；CLAUDE.md／AGENTS.md 的目錄速查依實際檔案重寫（「補充」段併入主表），並更新維護與來源清單的入口說明。只改了抽屜底部的按鈕，滑動手勢的程式沒動，所以沒有重跑滑動測試。

## 2026-11-07 手機抽屜與同步（Android 0.8.7 / versionCode 19）

- **改了什麼**：頂列拿掉「⋮」（同步移除，編輯改成鉛筆，只在可編輯頁出現）；不再有手動同步，改為前景每 30 秒＋回到前景＋對話結束時查 revision（`syncIfChanged`）；抽屜按鈕對齊網頁版（工作區名稱＋箭頭、可收合的「知識頁」、底部單一「更多」）；匯入佇列移到對話「＋」；抽屜改成自寫的 `SwipeDrawer`，可左右滑。規格見 `CLAUDE.md`。Web 不需改：這些都是讓手機對齊網頁版。
- **Pixel 6a 實測通過**：快速 13 種、慢速（1500ms）4 種滑動（水平、20°、左邊緣、直上直下、30°、45°、50°、斜率 1.2／1.4 的慢速斜滑都只捲頁面）；慢拖 30% 放開回到關閉、80% 保持開啟；抽屜清單斜拖不關閉；左邊緣排除區 `(0,938,105,1463)`；revision 變動在 30 秒內同步（log `revision 6527 → 6528`），App 在背景 40 秒不同步、回前景約 1 秒內同步；「更多」選單項目與網頁版相同。
- **對照組**：拿掉防護後，快速滑動仍全部通過（測試無效），慢速斜滑則抽屜會被拉出來。第一版做法（保留 Material 抽屜、consume 斜滑事件）讓慢速斜滑時頁面完全捲不動，已改掉。
- **返回鍵（2026-11-08 補測，最終版）**：按返回關抽屜、遮罩上拖 28% 保持開啟、點遮罩關閉、右邊緣返回手勢只關抽屜、從右邊緣拖過遮罩只關抽屜，各 3 次共 15 次全過，App 全程留在前景（修正前右邊緣拖遮罩會退到桌面）。快慢兩組滑動也在最終版重跑全過。「從 x=1000 慢拖 20%」會關閉抽屜，那是起點落在右邊緣返回手勢區（約 105px 內），屬系統行為。腳本在 scratchpad 的 `back_probe.py`（不在 repo），會在 USB 斷線時等待並重做該次。
- **測試事故**：一次背景測試在 App 被退出後仍繼續在桌面上滑動約 10 分鐘（腳本只在開頭檢查前景 App）。截圖桌面正常、沒有開啟其他 App。之後的腳本每一步都先確認 App 在前景。
- **既有、與本次無關**：`lintDebug` 有 3 個 Error（`DriveClient.kt:33`、`DriveReconnect.kt:20` 的 NewApi，`GraphView.kt:201` 的 produceState），本次未改這些檔案。

## 2026-11-07 匯入改為持久化（Android 0.8.6 / versionCode 18）

- **改了什麼**：POST 只存檔就回 202（`runIntake` 在背景讀來源）、pg_cron `ingest-worker` 每分鐘喚醒 worker、失敗分類與自動重試、Android `IngestUploadWorker`、佇列改看全帳號。規格見 `CLAUDE.md`「非同步 Ingest 協定」。migration `20261107090000_durable_ingest.sql` 已套用 production；Vault 的 `ingest_worker_url` 是手動寫入的，不在 migration 內。
- **production 實測通過**：POST 0.39 秒（舊版 21.4 秒）；同一個 `client_request_id` 重送回同一個 job；額度用完時進入等待並顯示重置時間；手機與瀏覽器都關閉時 cron 打 worker 回 `200 {"started":1}`；模擬 running 被砍，cron 於下一分鐘救回成 `continue`；手機點匯入後緊接 force-stop，請求已先送出，伺服器只有一筆 job，且 log 有 `WM-ForceStopRunnable: rescheduling`；Web 與手機都看得到別的工作區的等待任務。
- **真實模型實測**：OpenRouter `google/gemini-3.8-flash` 匯入一篇短文，送出後關閉分頁，9 頁全部寫入（job `0a6fc762`）。這證明流程能跑完，但**不代表 ChatGPT 的 strict 問題已解決**，那條路徑仍待額度重置後驗證。
- **尚未驗證**：
  - **`strict:false` 是否真的解決 0 頁**。帳號只有 ChatGPT 設定檔，週額度用完（約 11/8 12:53 Taiwan 重置），沒有任何實際寫入的測試。Nvidia 文章 job `a45d5c4f-b5f5-4ec0-86bc-52066137cf7a` 已重新排隊，重置後會自動跑，它就是驗證：看 `touched_pages`；若仍 0 頁，讀 `checkpoint.diagnostics`。
- **手機離線重送（0.8.5，使用者切飛航模式實測）**：離線送出網址後伺服器沒有收到（sources／jobs 數量不變），WorkManager 工作只差 `CONNECTIVITY`；接著殺掉 App 程序。關閉飛航模式後約 7 秒，App 沒開也自動送出，伺服器只有 1 筆 source、1 筆 job。測試內容在 intake 階段被暫停並刪除，沒有寫入知識頁，但 Drive 的 AI/sources 留下一個來源檔 `1c9vSDFgDVc5vzR3QY6ZpI9_26GD7OAgB`。
- **暫停 intake 擋不住 Drive 寫入**：`runIntake` 寫 Drive 來源檔前不檢查 job 狀態，暫停後它仍會寫檔，才在交棒時發現 lease 沒了。測試時要清資料，請用解析必敗的網址（如 `https://x.invalid/`），不會碰 Drive 也不花模型費用。
- **Android 橫幅（0.8.6）**：等額度的 job 曾蓋住剛送出的匯入，離線時看不出已排入。現在上傳未完成時優先顯示「匯入已排入，有網路就會自動送出」。線上實測顯示正確（Nvidia 那筆同時在等額度）；新文字沒有在真正離線時再測一次，但走的是同一個 `ingestLoading` 狀態。Web 沒有離線佇列，不適用。
- **手機接電腦一直響（未完全查明）**：響聲是 Windows 的裝置連線／中斷音效，手機確實一再斷線（Event 1010，今天 15:07–21:45 共 123 次）。「每小時固定斷線」已排除：預測 22:30 的斷線沒有發生（當時 94–95%）。靜置時（22:06–22:20、22:26 之後）沒有斷線；22:20 是使用者重插，22:24 那陣與切飛航模式同時（22:24:05），應是手拿手機時接頭晃動，22:25:47 那陣原因未確認。先前 15:29、16:29、17:29 那幾陣都在 100% 時，「充飽才斷」只測過一次反例，還不算證實。`+cellular_high_tx_power` 看似與斷線 47/47 重合，但使用者手動重插也在其中、該旗標 40% 時間都亮著，**不是證據，別再走這條**。
- **ChatGPT 暫緩（使用者決定）**：`strict:false` 驗證先不做，OpenRouter 設定不動。
- **真實注音實測（Pixel 6a，Gboard 注音，直接點螢幕按鍵）**：App 內選字中按鍵盤送出鍵只會確定選字，不會送出；確定後再按才送出；從候選列選字正常。手機 Chrome 上選字中的 Enter 是 `key=Unidentified`、`keyCode=229`，不會誤送。此時點畫面上的傳送鈕，會送出已確定的字，還在鍵盤上選字的部分（這次是「ㄇㄚ」）會消失；這段內容在 Gboard 裡，App 拿不到。**桌面版的真實輸入法沒測過**，只有手機 Chrome 的實測，桌面版是模擬事件。
- **實測找到並修掉的 bug**：
  - Android 傳檔一律失敗（`file is required`）：`Content-Disposition` 重複。舊版程式也是同樣寫法，應該早就壞了，但沒有舊版實測佐證。
  - 大檔競態：輪詢可能在內容存好前啟動 job，造成永久失敗（job `ea8a666e`）。**這是本輪改成先存檔後才出現的 bug**，已用 `next_attempt_at` 保留修正；1.95 MB 重測（job `5caccee6`）內容先存好、解析失敗訊息正確。不過那次測試期間只輪詢 2 次，不是高強度競爭測試。
  - 等待中的 job 會蓋掉失敗橫幅（Web／Android 都有）：Nvidia 那筆要等到 11/8，期間任何匯入失敗都看不到。
  - 批次匯入開出多個工作區：**也是本輪快速 POST 造成的回歸**。只把工作區清單重查一次仍失敗（3 個同名「攀岩」），改成依送出順序等前面的檔案（`52fe6b8`）後，4 篇養蜂文章間隔 2 秒送出，全進同一個新工作區，全部完成。**重測前要先確認工作區數量低於 12（`MAX_AUTO_WORKSPACES`），否則根本不會開新工作區，測試會假通過。**
  - **production 每個 PDF 都解析失敗（Web 和手機都是，自 Phase 17 起）**：打包後找不到 `pdf.worker.mjs`，修掉後線上又撞到 `DOMMatrix is not defined`（本機有 `@napi-rs/canvas` 所以測不到），兩個錯誤都被 `failureCode` 吞掉，現在會印 log。之前用假 PDF 測，失敗訊息剛好一樣，把這個 bug 蓋住了，要用真 PDF 才測到。修好後另外發現中文 PDF 缺 `cMapUrl` 會抽不到字，並且空內容會被當成成功。
- **手機匯入真 PDF（production 實測）**：內建字型的中文 PDF，OpenRouter Gemini，自動路由建了新工作區，寫入 6 篇知識頁加 index、log，內容確實來自 PDF（job `fa57f801`，已刪）。掃描檔與 Web 上傳 PDF 沒有在 production 實測（本機 `next start` 驗過空白 PDF 回傳空字串；Web 走同一支後端）。
- **其他格式（production 實測，手機上傳）**：DOCX、PPTX、EPUB、PNG 都寫出頁面且內容正確；只有圖片的掃描 PDF 正確失敗（`The document has no readable text.`）。網頁上傳 PDF 也通過。
- **費用走向（2026-11-07 查證）**：OpenRouter `2號萬能Key` 當天 Gemini 3.8 Flash 全部走 Google Vertex BYOK，逐筆 $0；GCP 帳單本月 Vertex AI $12.74 全被抵免額抵掉，實付 $0。OpenRouter「僅限 BYOK」是關閉的，Vertex 失敗時理論上可能改扣 OpenRouter 餘額，當天未發生。
- **手機被殺重送（0.8.3–0.8.4 實測，測試檔是解析必敗的假 PDF，不花模型費用）**：選檔後約 0.75 秒殺（請求已到伺服器、回應沒收到）→ 重開後重送，同一個 `client_request_id` 仍只有一筆 job；選檔後約 0.1 秒殺（App 確認已死、伺服器確認沒收到）→ 重開後 `WM-ForceStopRunnable` 重排，檔案自動補送，一筆 job。
- **其他**：Android `assembleDebug` 曾有一次 `BUILD FAILED`，daemon log 顯示 `checkDebugAarMetadata` 的 Gradle 快取搬移失敗（`Could not move temporary workspace`），與程式無關，重跑即過。預設模型已改為 OpenRouter，但 job `a45d5c4f` 綁定 ChatGPT profile，不受影響。Drive 留有一個沒被任何資料列引用的測試檔 `187pJPuE1lxXzPMsQoZH_ynuBIucQJGjI`（`vercel env pull` 拿到的環境無法取得 Drive token，沒刪掉）。
- **測試陷阱**：`GET /api/ingest` 也會啟動到期的 job。測 cron 時只要有 client 開著，任務就可能是被 client 推動的（實測發生兩次），要看 `net._http_response` 才算數。

## 2026-09-26 實機全面檢查（Pixel 6a ADB ＋ Web 手機寬度）

- **對話逾時根因**：OpenRouter `gemini-3.8-flash` 在正式 prompt＋工具下常於 headers 後串流卡死（推理 `high` 必卡、預設值約 2/3）。`lib/ai/client.ts`：每請求 150s、串流 35s 無 `data:` 重送一次、OpenRouter 預設 `reasoning.effort=medium`、各流程帶 hard-stop signal；`/api/query` 70s 後強制作答、105s 收尾並說明逾時。修後實機 11.6 秒回答。
- **Android**：返回鍵（抽屜→搜尋/編輯→上一頁→離開）、字元級串流、思考中狀態、停止鍵、可點引用 chip、綜合頁「查看」、錯誤 JSON 解析、匯入橫幅批次視窗、佇列文案、Compose 捲動＋反向連結標題、冷啟先顯示快取、頁面鎖定鍵、登出確認、設定卡片等寬。
- **Web**：手機寬度側欄改覆蓋式抽屜（底部工具列）、對話全寬、頂列不溢出；匯入條計入 pending；刪除其他工作區卡片後刷新選單；佇列「完成·完成」去重。
- 驗證：`bun test` 145 pass、`bun run typecheck` 5/5、Android unit tests 4 pass、release APK 裝到實機逐項操作。
- Android 已發行 `0.7.2`（versionCode `9`，GitHub release `v0.7.2`）。測試用的綜合頁已經用 `/api/agent/execute` 刪除。
## 2026-09-08 審查修復

- 共用 wiki writer 改為先建立新 Drive 檔，再以 DB version / lock CAS 發布檔案 id；成功後才 trash 舊檔，明確衝突只 trash 自己的新檔，禁止把舊內容寫回共用檔案。
- DB 回應不明時保留新檔並記錄錯誤，避免請求其實已成功卻誤刪正式內容；可能留下待清理檔案，Drive / DB / page_links 仍不是單一交易。
- 維護讀不到 inventory 時停止；ingest claim 後核對原 attempt，Web / Android 以請求編號隔離晚到回應。根目錄 test 已接上 Web 測試；lint 已改用 ESLint 原生 flat config。2026-09-09 已修完既有 20 errors，並清掉 Hook 依賴、內部導頁與未使用變數警告；剩 38 warnings（37 個刻意保留的診斷 console、1 個 export 格式）。未停用規則；整套測試 140 pass / 0 fail。
- Android 實機測試依使用者指示延後，不能以 APK 建置或本機回歸測試宣稱已通過實機驗收。

## Android v0.7.0 正式發行（2026-09-01）

- Android 版本為 `versionName 0.7.0`、`versionCode 7`；發行前已確認 tag 與 GitHub Release 未使用 `v0.7.0`。
- 內容摘要：可恢復 Ingest queue、多格式匯入、Faithful raw-source query、Graph Insights，Web/Android 功能對齊。
- GitHub Release：`v0.7.0`；資產：`llm-wiki-0.7.0.apk`。
- APK 內版本讀回為 `0.7.0` / code `7`，release signer 與 `v0.6.0` 相同；SHA-256：`97FF398DC4AA6B106925EEF7AAB277608C6BFE148C781A094D3ABE5A2C5389D7`。

## 本輪完成（2026-09-01，六項知識編譯能力）

- 完成兩階段 `analysis → writing → review` Ingest、可恢復 queue（checkpoint、pause/resume/retry、attempt fencing）與 source SHA unchanged skip。
- 完成 ingest 工具 allowlist、共用 writer version/lock CAS 與失敗補償；多格式 parser 支援 PDF/DOCX/PPTX/EPUB/text/Markdown/image，輸入上限 2 MiB。
- 完成 Faithful raw-source query（只讀 raw source，citation 來自實際讀取）與 Graph Insights（孤立頁、群組、橋接頁、未解析連結）。Web/Android 已對齊，Android 為 `0.7.0`（versionCode `7`）。
- production 已套用 `recoverable_ingest`，並驗證 `sources` 的 hash/mime/size、`ingest_jobs` 的 phase/checkpoint/attempt/result/updated_at、source hash unique 與 workspace running-job index。
- 本輪修復（2026-09-01）：GraphView 依 `resolvedTheme` 使用可讀的深色節點／連線色；Web queue 改走 `/api/ingest`，由 server 先 stale sweep 再提供 job 清單，避免殭屍 `running` row 讓畫面卡在「匯入中」。
- 驗證：`bun test` 108 pass / 0 fail、`bun run typecheck` 5/5、`bun run build` 1/1、Android debug／signed release APK build 成功；本輪 security review 無 CRITICAL/HIGH/MEDIUM。
- 已知限制：Drive → DB → `page_links` 仍非單一交易；目前靠 CAS 與補償降低衝突／孤兒風險。

## 前一輪研究與決策（2026-08-31，nashsu/llm_wiki v0.6.11 / e808211）

- 採用統一 synthesis commit path：synthesis route 改走 `writePageForWorkspace`，補齊 `search_text`、`page_links`、content `hash`、`version` 的一致性。
- 原先暫不做完整兩階段 ingest、durable SHA queue、多格式 ingest、graph insights、faithful research；本輪已全部補完。
- 原先驗證數字（`bun test` 41 pass 等）屬前一輪歷史紀錄，不代表目前版本。
- 安全複核無 CRITICAL/HIGH；中文／emoji slug collision 已由 query fallback + 12 hex UUID 關閉。

## 最近一次變更（2026-07-16，全專案漏洞掃描收尾）

Claude 掃完、驗證全過後 session limit 斷線；本輪接手文件 + APK + commit/push。

### 程式修復

| 嚴重度 | 改動 | 說明 |
|--------|------|------|
| P2 | `ingest-pipeline.ts` → `confirmDestructive: true` | 來源是任意網頁；無 onProposal 時 `deletePage` 直接拒絕。匯入是加法，去重交給 organize。**勿回退** |
| P3 | `api/search/route.ts` ilike fallback | 清洗 `,()|%\`（對齊 tools `safeQuery`），擋 PostgREST or-filter 注入 |
| 依賴 | next 16.2.4→16.2.10、root `overrides` form-data/ws | runtime high 清掉；剩 3 high 全在 eslint / @vercel/config 工具鏈 |

### 驗證（本輪重跑）

- `bun test`（apps/web）：39 pass
- `bun run typecheck`、`bun audit`：見 commit 訊息／終端輸出

### 文件

- `CLAUDE.md` 新增「安全注意事項（2026-07 全專案掃描）」
- `AGENTS.md` 安全表同步
- `gateDestructive` 敘述改為：ingest 固定 true 拒絕刪頁；organize 仍 false

### 還沒做的

- next-intl 升 v4（大遷移，接受現狀）
- build 工具鏈 3 個 high（不進 runtime）
- Android 實機驗 `[[slug|label]]` 渲染（與本輪無關）

## 上一次變更（2026-07-16，Android v0.6.0 發行版）

對齊網頁後重編並發布 **v0.6.0**（versionCode **6**；上一版 v0.5.0 / code 5，不重複）。

- 匯入進度橫幅：與 Web 一樣報「處理中 / 本批完成 / 失敗」+ 已更新頁數（`ingest_jobs` RLS 輪詢，關 App 不中斷）
- `[[slug#anchor|label]]`：MarkdownViewer 切掉 anchor 再組 href
- 維護 `more_work` 接力、來源 re-ingest、Bot 導入／模型選單等已在先前對齊，本版一併打進 signed release
- GitHub Release：`v0.6.0` asset `llm-wiki-0.6.0.apk`

## 上一次變更（2026-07-16，接續 Phase 16i：死連結收工驗證 + extractWikiLinks 切 anchor）

Claude 停在「修了 residual 收工、部署後再按一次把 8 條收掉」。本輪接續完成。

### production 再跑維護（f06485f 已上線）

- 觸發 `POST /api/organize`，4 輪接力（`more_work`：T→T→T→F），ops 7+5+6+4
- 修法生效：模型喊 `ORGANISE_COMPLETE` 後程式重算死連結，仍有殘留就不准 complete

| | 維護前（本輪） | 維護後 |
|---|---|---|
| 知識頁 | 318→320（跑中已寫） | **323** |
| 連結 | 1741→1774 | **1795**（同區存活 1654、跨區 141） |
| **指不到任何頁** | **6**（CoreWeave / 李飛飛 / Jeff Dean / Unitree / materials-science…） | **0** |
| 流程垃圾頁 | 0 | 0 |
| 工作區 | 7 | 7 |

### 小修（程式）

- `extractWikiLinks` 以前只切 `|`、**不切 `#anchor`**，會把 `concepts/foo#bar` 存成 `concepts/foo#bar.md` 進 `page_links`。`canonicalWikiAlias` 讀時有切所以「量起來」不一定死，但表髒、圖譜邊也怪。改走 `parseWikiLink` + `normalizeWikiSlug`。

### 還沒做的

- Android 仍未實機驗 `[[slug|label]]` 渲染。
- 舊 `page_links` 裡帶 `#` 的髒列會在下次 `writePage` 該頁時被重寫清掉；沒有另跑 migration。

## 上一次變更（2026-07-14，Phase 16h 真人操作瀏覽器測完所有按鈕）

使用者：「你自己操作瀏覽器測試按鈕看看所有功能，要導入的內容在 `D:\Workspace\其它\文章分類\整理後文章`，確認功能運作正常。」全程用 Chrome 操作 production UI（貼上／多檔佇列／維護／圖譜／搜尋／來源清單／對話），DB＋Vercel log 交叉驗證。

### 四個真 bug（都是實際點下去才看得到的）

1. **整份 index.md 的藍色連結全是死的**：LLM 幾乎都把連結寫成 `[[entities/donald-trump|Donald Trump]]`，而**兩個渲染器都沒有切 `|`**——href 變成 `?page=entities/donald-trump|Donald Trump.md`，那頁永遠不存在。後端 `extractWikiLinks` 一直有切，所以 `page_links` 表看起來很健康，**DB 指標與使用者體驗完全脫節**（上一輪我就是被這個騙過去）。修：`parseWikiLink()`（`lib/wiki/slug.ts`，有單元測試）供 Web／Android 渲染器共用，`GET /api/pages` 對含 `|` 的請求也切一次（救舊 client 與舊書籤）。
2. **一次按鈕跑出兩條維護 pipeline**：兩個分頁各自輪詢同一個 job，都看到 `done && more_work` 就都送出下一輪。route 的「一次一個」是 check-then-insert，中間隔著好幾秒的 Drive 呼叫——**檢查擋不住併發**。修：migration `0019` 對 `agent_jobs (owner_id) where status='running'` 建 partial unique index（已套 production，實測第二個 POST 當場被擋），route 把 `23505` 轉成 409 + 現行 jobId。
3. **知識圖譜的 zoom-to-fit 從來沒生效**：每次 Realtime 更新 → `setLoading(true)` → 容器換成 spinner → force graph 整個 unmount/remount → layout 重跑、鏡頭歸零。匯入或維護進行中時，圖就是一團在畫布中央跳動的毛球，連手動「重新置中」都會被下一次 remount 吃掉（我上一輪加的 `onEngineStop → zoomToFit` 因此看起來像壞的，其實是被 remount 抹掉）。修：只有第一次載入進 loading；之後 re-render 同一個 root、節點座標跨更新保留、`zoomToFit` 只在第一次 settle 做。實測 console `[graph] handle ok … zoom=1.23`，圖填滿面板、標籤出得來。
4. **對話會回「空白答案」**：citation chips 有、`logs.answer_preview` 是空字串——`streamText` 一個字都沒吐（發生在 6 條維護 pipeline 同時打同一把 OpenRouter key 的時候）。修：串流沒有任何文字時回一句可讀訊息，並 `console.warn` 記下 `finishReason`／steps／工具呼叫。**空泡泡看起來像「wiki 沒有東西可講」，那是最糟的失敗形式。**

### 實測結果（production，真實文章）

- **導入**：4 檔佇列（貼上／多檔）全部成功，即時進度正常，來源清單顯示「已整合 N 個頁面」，沒有 0 頁的假成功。
- **自動分類**：舊版部署下 4 篇只有 1 篇做出判斷（其餘靜默 fallback，但 UI 已不會謊稱分類過）；**新版部署後 2/2 正確**——楊立昆 → 「AI」、標普500 → 「個人理財與退休規劃」（都不是當前工作區）。路由失敗現在會進 log。
- **維護（健康檢查＋整理）**：一次按鈕 6 輪、約 119 個操作。補寫了連結指向但不存在的頁（荷姆茲海峽、股票市場…）、把 UAP 那一叢拆成新工作區（9 頁）、把路由失敗落錯的三篇歸位（禮來→基本面投資、低軌道衛星→AI、標普500→個人理財）。
- **連結健康度**：747 條連結 → 精確命中 545、alias 命中 63、可跨工作區跳轉 138、**真的死掉只剩 1 條**（維護前 33）。
- **搜尋／來源清單／對話／圖譜**：都實際點過，正常。

### 還沒做的

- Android 這輪只跟著改渲染器（`MarkdownViewer` 切 `|`）並建置通過，**沒有在實機驗過**。
- 127 篇文章只導入了 6 篇（測試用）。要整批灌進去請留意：一次匯入是序列跑的，每篇約 1.5–2 分鐘。

## 上一次變更（2026-07-14，Phase 16g 失效連結／過時索引／知識圖譜視覺）

使用者：「wiki 索引也要即時更新／依然有藍色連結失效／戳健康檢查似乎沒處理到／可以優化知識圖譜嗎」。

**先量再修**：production 581 條 wiki 連結，157 條是斷的。拆成三類，各有各的修法：

| 類別 | 數量 | 修法 |
|---|---|---|
| 連結是用**頁面標題**寫的（`[[DRAM 市場 2026 年供需危機]]` vs slug `summaries/dram-market-2026-crisis.md`） | 37 | 咽喉點 alias 比對加上 title（`lib/wiki/resolve.ts` 的 `pickAliasMatch`，唯一命中才 resolve） |
| 頁被維護**搬到別的工作區**了 | 69 | 咽喉點回 `404 PAGE_MOVED_WORKSPACE` + 目標 workspace_id/slug；Web `router.push` 過去、Android `selectPageBySlug` 切工作區（舊版直接 `return`，連錯誤都不給） |
| 真的**沒有那頁** | 51 | `findDeadLinks()` 算好清單餵給健康檢查 |

**健康檢查為什麼一條連結都沒修過**：prompt 從 Phase 16 就寫著「修復失效的 [[wikilink]]」，但要找出它們得把 580 條連結對 140 個頁做交叉比對——這是 set operation，模型讀 inventory 根本做不到。改由程式算好兩份清單（失效連結、index.md 沒列到的頁）塞進 prompt。實測一按下去它就開始補寫那些指向不存在頁面的目標（`entities/lora-ho`、`entities/nasa`、`entities/fbi`、`entities/odni`、`concepts/uap`…）。

**知識圖譜**（先調用 frontend-design skill）：
- **degree 全部算錯的 bug**：`d3-force` 會**就地**把 `link.source`/`target` 從 id 字串換成節點物件，degree/neighbors 拿它當 key，任何 re-mount 後全部失效 → 所有節點 degree=0 → 整張圖畫成孤兒。先正規化端點 id。
- 視覺：顏色＝kind（冷色家族繞著 app 的 cyan，**只有 synthesis 是暖色**）；大小／光暈／標籤優先級由連結度驅動；孤兒頁畫**空心圓**＋readout 直接報「N 頁未連結」（舊版淡到 0.18＝藏起來，那是最該處理的頁）；標籤依 zoom 漸入；`onEngineStop` → `zoomToFit`；圖例與篩選合併成同一個控制項；`_schema` 規則頁不再是節點。實測 140 fps。
- **`PageViewer` 首幀就畫「找不到頁面」**：`loading` 初始 false 而 fetch 在 effect 才開始，Drive 冷讀那幾秒使用者看到的是「這頁不存在」。改成有 slug 就從 loading 開始。

**注意**：「科技產業動態」是**使用者自己在 01:42 從介面刪掉的**（runtime log 有 `DELETE /api/workspaces/89726d57` → 200），不是維護掃的。

## 上一次變更（2026-07-14，Phase 16f 三條路徑實測：導入／自動分類／健康檢查）

使用者：「檢查並修復健康檢查、自動分類、統一導入⋯⋯能不能自動送進對應的工作區，或是建立一個工作區？修好它，自己測試。」全部在 production 用真實資料實測過。

### 找到並修掉的 bug

1. **自動分類的靜默 fallback（真正的元凶）**：`routeToWorkspace()` 每一條失敗路徑都 `return stay`（＝匯入到當前工作區），但回應照樣帶 `routed_workspace_name` → UI 顯示「已導入到 ⟨當前工作區⟩」，看起來像 AI 的判斷。而路由那一次 `generateText` **沒有任何重試**，這個 provider 又常噴 `Provider returned error`——production 7/12 那批匯入（含「老黃CSIS訪談」這種半導體題材）全部落在使用者當時所在的「地緣政治」，就是這樣來的。修法：抽成 `lib/ai/route-workspace.ts`、失敗重試一次、解析器接受「純工作區名稱」的回覆（小模型常這樣答，舊版直接判失敗）、**沒做出決定就不回 `routed_workspace_name`**（不謊稱有分類）、空殼工作區不列候選。
2. **同名雙胞胎工作區**（我自己在 1. 引入的回歸，當場修掉）：把空殼從候選濾掉後，`NEW:` 名稱的同名重用還在比對候選清單——批次匯入時第一個檔剛建好的工作區還沒寫進頁面（=空的、不在候選裡），第二個檔就會再建一個同名的。改成比對**全部**工作區。
3. **掃空工作區失敗會弄死整輪維護**：`deleteWorkspaceForUser` 內的 Drive `trashed:true` 在資料夾不存在時 throw → 冒到 route 的 `after()` → 整個維護 job 標 failed，連 LLM 迴圈都還沒開始。逐一 catch。
4. **維護自己建的空工作區要當場刪**：1 小時寬限期是保護「匯入路由剛建好、ingest 還在寫」的工作區，不該罩到「維護建了卻沒填」的空殼（實測「半導體」工作區建好後有一段時間就是 0 頁）。用 `createWorkspace` 回傳的 id 精確記錄本輪建的，不拿時間猜。
5. **頁面 ping-pong（`frozenMoveSlugs`）**：三輪監控實測，4 頁被上輪搬走、下輪又搬回來（`data-center-infrastructure`、`Cisco`、`workers_platform`、`AI_Datacenter_Energy_Demand`），因為每輪都從零重新推導分類。更糟的是**有變更 → `more_work` 永遠 true → client 自動再開一輪**，一次按鈕可能整趟預算都在自己推翻自己。改為：同一次按鈕（30 分鐘視窗內的 organize job）已搬過的頁，`movePageToWorkspace` 直接拒絕。

### production 實測結果

- **導入 ＋ 自動分類**（從「科技產業動態」發動，fallback 也是它）：
  - 咖啡烘焙文章 → **自建工作區**「咖啡烘焙與生活品味」，7 頁（`routed_workspace_created: true`）
  - 第二篇手沖咖啡 → **路由進剛建的那個工作區**（`created: false`＝真決定，不是 fallback），6 個 touched 只有 1 頁是新的，其餘是改寫既有頁 → **cascading update ＋ 去重都正常**
  - 測完用 `DELETE /api/workspaces/{id}` 整包刪除（回 `{ok:true}`），不留痕跡
- **維護／健康檢查**（一次按鈕 = 5 輪接力，99 個操作，全程監控）：合併語意重複頁、建立「半導體與供應鏈全球布局」與「基本面投資與公司價值分析」、把價值投資頁（ROIC/ROE/巴菲特/龍巖）與半導體頁（HBM/先進封裝/台積電/晶片管制）各自集中。**頁面總數全程守恆（142 → 141，少的 1 頁是合併掉的重複頁）**，上次事故（14 頁理財倒進地緣政治再刪工作區）沒有重演。
  - 最終：AI 43 / 半導體 28 / 地緣 51 / 基本面 13 / 個人理財 6 / 科技產業動態 **0**
  - **第 5 輪 `more_work: false`——整條鏈第一次自己收斂**（前 4 輪全是 true，會一路燒滿 6 輪上限）。那一輪跑的是 `frozenMoveSlugs` 上線後的版本：不能再推翻既有分類，它就去做 index/log 收尾與 `reorderWorkspaces`，然後宣告完成。

### 已知落差（沒修，需要使用者決定）

- **「科技產業動態」被拆到 0 頁**：33 頁分別進了 AI／半導體／基本面投資，每一筆搬移單看都合理，但整個書架實質被解散了。它是當前工作區所以沒被掃掉（那道 guard 有效）；**下次從別的工作區發動維護時，它會被 `sweepEmptyWorkspaces()` 當空殼刪掉**。沒有動它，等使用者決定（要嘛接受這個新分類法、要嘛把它刪掉、要嘛用對話把頁面搬回去）。若使用者不要這種「大改組」，該做的是給每個工作區一份**持久的主題描述**讓每輪分類基準穩定，而不是再疊 guard。
- **分類品質不完美**：「半導體」裡混進了央行、誠信、夥伴關係、台灣病等不該在那裡的頁。無資料損失，用對話即可糾正。
- **兩個空的「My Wiki」不是這個帳號的**（屬於 `peiliu001@` / `rx5950xt@`）——上一版 CONTEXT 說「還剩一個空 My Wiki 待掃」是我查 DB 時沒按 owner 過濾的誤判。維護不該碰別人的工作區，這裡沒有 bug。

## 上一次變更（2026-07-14，Phase 16e 機械判斷歸程式、語意判斷歸模型）

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

~~**待辦**：剩一個空的「My Wiki」——下次按維護時會由 `sweepEmptyWorkspaces()` 自動掃掉。~~ **這條是錯的**（Phase 16f 更正）：那些空的「My Wiki」屬於**別的帳號**，不在本使用者的工作區清單裡，維護本來就不該碰。當時查 DB 沒有按 `owner_id` 過濾。

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

## 2026-09-03：匯入必失敗 + Drive 每週掉授權

兩件事同時發生，看起來像同一個 bug，其實無關。

**匯入卡住**：唯一的 LLM profile 的 model 是 `google/gemini-3.7-flash:batch`。OpenRouter 對 `:batch` 變體只開放 Batch API，一般 `/chat/completions` 回 404「This model is only available through the Batch API」。每次匯入、每次「重新整合」都在 8 秒內失敗，job row 只寫 `Ingest failed`（`publicIngestError` 的 fallback），所以看不出重試是徒勞。已改 production profile 的 model 為 `google/gemini-3.7-flash`，並讓 `publicIngestError` 對 `APICallError` 透出 provider 原話（測試：`apps/web/lib/ai/ingest-pipeline.test.ts`）。

**Drive 每週要重連**：GCP OAuth 同意畫面停在「測試中」，Google 對測試狀態的 app 讓 refresh token 7 天失效。修法是把同意畫面發布為正式版，這需要首頁與隱私權政策網址 → 新增 `apps/web/app/privacy/page.tsx`（`/privacy`），並在 Google Auth Platform 品牌頁填入支援 email、首頁、隱私權網址。詳見 CLAUDE.md「Google OAuth 發布狀態」。

修完 model 之後又連續露出兩層（都是同一個根因：沒有 structured outputs 時，schema 只剩 prompt 在撐）——plan 階段照 `_schema/ingest.md` 的舊 JSON 範例回答、review 階段漏三個必填 key（9 頁已寫入卻標 failed）。兩個 prompt 現在各自列出所有 key，並共用一次「帶著拒絕訊息重試」。production 實測：`done / phase=done / touched=9 / result=updated`。

再往下還有兩層：寫入迴圈寫出一頁就收工（計畫 11 頁只寫 4 頁 → review 正確判 incomplete），改成寫完計畫才停之後，又撞上 Vercel 300s 硬砍（job 卡 running 8 分鐘）。現在有 210s wall-clock 預算並回報「N of M planned pages, retry to continue」；續寫要用佇列的「重試」（保留 checkpoint），不是 Sources 的「重新整合」（重新規劃的新 job）。

同一天處理「切頁很慢」：實測開一頁 1.6–3.4s。access token 每次重換（已快取）、function 跑在 iad1 而 Supabase 在 ap-southeast-1（已改 `regions: ['sin1']`）、Drive 兩次往返（已用 `pages.version` 做 ETag，最新版直接 304）、前端切回讀過的頁面不再重抓（PageViewer 快取 40 頁）。`Server-Timing` 留在回應裡，下次不用猜。

## 2026-09-04：Android v0.7.1 — 開頁改成條件請求

上一則把「切回讀過的頁面立刻顯示」寫成 Web-only，這是錯的：Android 從很早就有 Room 內容快取（`PageEntity.content`，`syncPages` 只在 `version` 變動時清空），切回讀過的頁本來就是即時的，而且跨重啟保留。

真正缺的是另一件事：命中快取時 `loadPageContent` **完全不打 API**，所以在網頁上改過的頁，手機要等下一次 `syncPages` 才會更新。伺服器現在有 ETag，一次條件請求在 304 時連 Drive 都不碰，便宜到可以每次開頁都做。改法：

- `PageRepository.loadPageContent` 對有快取的頁帶 `If-None-Match: pageEtag(slug, version)`（格式必須與伺服器 `"<slug>:<version>"` 一致）；304 沿用快取，200 用 `updateContentAndVersion` 把內容與 `version` 一起寫回 Room。
- **任何失敗都退回已快取內容**（離線、401、Drive 重授權都不會把畫面清空）。
- `WikiViewModel.selectPage` 改成一律呼叫 `loadContent`；`contentLoading` 仍只在沒有快取時為 true，所以畫面不會多出骨架屏。

APK bump 到 `0.7.1`（versionCode `8`）。伺服器端的 token 快取、`sin1`、ETag 對舊版 APK 無害，舊版只是拿不到條件請求這一項。
