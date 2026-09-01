# 六項知識編譯能力（2026-08-31）

## 規劃與資料契約

- [x] 盤點 Ingest / Query / Sources / Graph 的 Web、Android、DB 完整 caller
- [x] 設計並新增 `ingest_jobs` 可恢復狀態、checkpoint、SHA256 去重 migration（GRANT + RLS 同步）
- [x] 定義兩階段 Ingest plan、寫入、自我審查與錯誤／暫停邊界
- [x] 定義 Faithful mode 原始來源工具與可驗證 citation metadata
- [x] 選定最少且安全的多格式解析依賴，完成漏洞與維護狀態檢查

## 後端實作

- [x] 兩階段 Ingest：分析人物／概念／證據／矛盾／目標頁，再寫入並自我審查
- [x] 共用 `writePageForWorkspace` 加安全合併：保留 sources/tags/related，拒絕可疑縮短
- [x] 可恢復 Ingest queue：pause / resume / retry / checkpoint / SHA256 unchanged skip
- [x] PDF / DOCX / PPTX / EPUB / image 匯入與圖片描述
- [x] Faithful Query：只可讀 raw sources，不注入 wiki／背景知識，回傳來源 citation
- [x] Graph Insights API：孤立頁、社群、橋接頁、可能缺失連結（5 個 fixture 通過）

## Web / Android 對齊

- [x] Web：Faithful 切換、queue 控制、多格式狀態、graph insights
- [x] Android：沿用同一 API，對齊 Faithful、queue、多格式、graph insights 與雙語字串
- [x] 未知串流 metadata 保持向後相容；錯誤／loading／disabled／a11y 狀態齊全

## 驗證與交付

- [x] 單元／route／DB policy 測試涵蓋安全合併、checkpoint、去重、Faithful citation、圖演算法
- [x] `bun test`（107 pass / 0 fail）、`bun run typecheck`（5/5）、`bun run build`（1/1）、`bun audit`、`git diff --check`
- [x] Android `./gradlew.bat :app:assembleDebug` 與相關 unit tests（APK `0.7.0`）
- [x] 瀏覽器實測：公開登入 redirect，以及新 API 未登入時回 JSON/401
- [x] `recoverable_ingest` migration 套用 production，欄位與索引讀回驗證
- [x] push 後部署並驗證公開站與 commit status
- [x] 更新 `CONTEXT.md` / `tasks/lessons.md`，完成文件收尾（commit + push 由主代理執行）

## Review

- `bun test`：107 pass / 0 fail。
- `bun run typecheck`：5/5 packages passed；`bun run build`：1/1 passed。
- Android `testDebugUnitTest` 無測試來源但成功，`assembleDebug` 成功；APK `0.7.0` / versionCode `7`。
- `recoverable_ingest` 已套用 production；`sources` 欄位、`ingest_jobs` 欄位與 unique/index 約束已讀回驗證。
- Security review：無 CRITICAL/HIGH；剩餘已知限制是 Drive → DB → `page_links` 非單一交易，保留 CAS + compensation。
- 部署：commit `3318b26`、Vercel success、GitHub Actions `33473299451` success，Android APK artifact 已上傳；production 公開頁/API 回讀正常。

---

# 參考 nashsu/llm_wiki 改善本專案（2026-08-31）

- [x] 查證 Codex 全域子代理設定欄位
- [x] 將一般 Codex 與 Orca runtime 子代理預設設為 `gpt-5.6-luna` / `max`
- [x] 在全域與專案 `AGENTS.md` 寫入積極委派規則
- [x] 研究並比較上游 `nashsu/llm_wiki` v0.6.11（`e808211`），整理產品、資料流、prompts、工具與 UI 差異
- [x] 選出不重複且能直接提升本專案的改善：統一 synthesis commit path
- [x] 完成 synthesis route 實作；Android 無需變更
- [x] 完成最終驗證：`bun test` 41 pass/0 fail、`bun run typecheck` 5/5、`bun run build` 1/1、Android `assembleDebug` `BUILD SUCCESSFUL`
- [x] Review：安全複核無 CRITICAL/HIGH；中文／emoji slug collision 已由 query fallback + 12 hex UUID 關閉；既有 MEDIUM 是 shared writer 的 Drive→DB→page_links 非原子，本輪未做跨核心交易／補償重構
- [x] Commit 並 push 目前分支

---

# 修復批次：連結 / 圖譜 / 來源 / 維護按鈕（2026-07-13）

使用者連續回報 5 項。診斷完成，依 root cause 分組。

## 診斷數據（production mjuciqffwayydobpxzcz）
- 189 頁、600 page_links，**225 條 dangling（37.5%）**
- dangling 拆解：126 條「格式不符但頁面存在」（缺 `concepts/` 前綴／大小寫／`.md`）、99 條真失連
- 唯一可 alias 解析 35 個 distinct slug、1 個撞頁、68 個真失連
- sources：49 筆，2 筆 ingest 失敗（要 re-ingest 入口）
- lint route 是**同步** `await generateText`（關頁面即斷），organize 已是 job

## Group 1 — 藍色連結 PAGE_NOT_FOUND + 圖譜亂（同一 root cause）
- [x] 1a. 共用 `lib/wiki/slug.ts`（canonicalWikiAlias）
- [x] 1b. `/api/pages/[...slug]` GET：exact miss → 唯一 alias 匹配才 resolve（共用咽喉點，修所有 client）
- [x] 1c. `page-viewer.tsx`：真失連顯示友善訊息，不再噴 `[PAGE_NOT_FOUND]`
- [x] 4a. `graph-view.tsx`：邊的端點經 alias 解析成真實節點；解不到就濾掉（去幽靈節點）

## Group 3 — 已匯入來源修復（re-ingest）
- [x] 5a. Web `sources-dialog.tsx` + Android `SourcesListDialog`：每列加「重新整合」按鈕
- [x] 5b. 新 route `POST /api/sources/[id]/reingest`：讀 Drive 既有內容 → 建新 ingest_job → 重跑 pipeline，沿用 `/api/ingest?job_id=` 輪詢

## Group 2 — 維護按鈕整合（lint + organize 合一 + 進度 + 背景）
- [x] 2a. lint 改 job 化（migration `0016` 加 `lint` kind、`after()` 背景跑、GET `?job_id=` 輪詢 + stale sweep；cron GET 保留）
- [x] 2b. Web 頂列一顆 `Wrench` 維護選單（健康檢查 / 自動整理＋去重）；Android drawer `Build` 選單
- [x] 2c. Web 統一進度 pill：進行中（含「可關頁面背景續跑」提示）/完成（查看報告）/失敗，localStorage 續跑
- [x] 2d. Android 對齊：`runMaintenance(kind)` 泛化、kind-aware 進行中 banner + 背景提示

## 收尾
- [x] Android 連結解析：走同支 `/api/pages`，自動吃到伺服器 fallback（WikiViewModel 本就有 canonicalWikiAlias 本地解析）
- [x] typecheck 5/5 / web build 綠 / Android compileDebugKotlin 綠 / migration 0016 已套 production
- [x] Android release APK + commit push

## Review 心得
- 連結失效的 root cause 是資料髒（225/600 dangling），但正解不是改資料而是**讀取時在伺服器咽喉點做唯一-alias fallback**——survives writePage 重寫、一次修所有 client（Web/Android/直接 URL）。ambiguity 只有 1 筆，故「唯一匹配才 resolve」安全。
- 圖譜的「亂」= force-graph 對 dangling 邊生幽靈節點；client 端解析邊端點 + 濾掉解不到的，比清資料更穩。
- lint 從同步改 job 化後，Android 舊的「2xx 即完成」邏輯會假完成——協定改動一定要回頭掃所有 client caller。
- 兩顆按鈕合一 + 背景續跑：organize 早就是 job，只要把 lint 也放進 agent_jobs（共用 one-at-a-time 鎖）就自然變「一次一個維護任務」。前端 localStorage 記 jobId → 重載/關頁面回來續 poll。

# 深色圖譜與匯入卡住修復（2026-09-01）

- [x] 查 production logs、`ingest_jobs` 與前端輪詢資料流，確認卡住根因
- [x] 修 Web 知識圖譜深色模式，沿用既有主題 token
- [x] 修匯入狀態不會自動結束的根因並補回歸檢查
- [x] 驗證 Web 深色／淺色、匯入狀態、typecheck、build 與 Android APK
- [x] 更新 Review、commit、push 並確認 production 部署

## Review

- 根因是 Web 直接查 `ingest_jobs.status=running`；Vercel 中斷留下 stale row 時，畫面會永遠顯示「匯入中」。改由 `/api/ingest` 先做 server stale sweep，再回傳 queue 清單給 UI。
- GraphView 改用 `next-themes` 的 `resolvedTheme` 與深色專用節點／連線色，切換深色模式後重繪仍保持可讀。
- `findStaleRunningJobs` 回歸測試確認只清理過期 running job，不影響仍活著的 job。
- commit `67a1522` 已部署至 production；正式網址 redirect 正常，新 ingest list 未登入回 JSON `401`，近 10 分鐘無 error log。

---

# Android 最新 APK 發行（2026-09-01）

- [x] 盤點現有 GitHub Release、tag、Android 版本與發行流程，決定未使用版本
- [x] 確認 Android `versionName` / `versionCode`，更新 README／CONTEXT 文件
- [x] 執行 Android 測試與 APK 建置，核對 APK 內版本、大小與 SHA-256
- [x] 提交並推送，建立 GitHub Release 並上傳版本化 APK
- [x] 驗證遠端 branch、tag、Release 與下載資產

## Review

- `v0.7.0` / versionCode `7` 發行前確認未與遠端 tag／Release 重複。
- `bun test`：108 pass / 0 fail；`bun run typecheck`：5/5；`bun run build`：1/1。
- Android `testDebugUnitTest`：NO-SOURCE；`assembleDebug`、`assembleRelease`：BUILD SUCCESSFUL。
- 正式 APK：4,854,680 bytes；SHA-256 `97FF398DC4AA6B106925EEF7AAB277608C6BFE148C781A094D3ABE5A2C5389D7`；簽章與 `v0.6.0` 相同。

---
