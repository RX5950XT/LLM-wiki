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
