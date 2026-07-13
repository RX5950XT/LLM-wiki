# 大改版：對話中心化 + 跨工作區 AI + UI 精修（2026-07-13）

計畫全文：`C:\Users\rx595\.claude\plans\imperative-forging-corbato.md`

## A — 效能修復
- [x] A1: `[wid]/page.tsx` drive_folder_id 併入 Promise.all + ensureWorkspaceSystemPages 改 after()
- [x] A2: `settings/page.tsx` schema backfill 改 after()（樂觀渲染）

## B — LLM Profile 編輯
- [x] B1: `/api/settings/profiles` 加 PATCH（api_key 留空保留、is_default 互斥、先驗 id owner）
- [x] B2: Web ProfileList 編輯按鈕 + ProfileForm 預填模式
- [x] B3: Android SettingsScreen/ViewModel updateProfile

## E — 跨工作區 AI 工具 + 確認流程（核心依賴）
- [x] E1: tools.ts ToolContext 跨工作區化（folderCache keyed by ws、workspace_id 參數、owner 檢查）
- [x] E2: lib/workspaces/manage.ts（create/rename/delete 共用函式，route 重構共用）
- [x] E3: 新工具 listWorkspaces/createWorkspace/renameWorkspace/deleteWorkspace/movePageToWorkspace
- [x] E4: 破壞性確認：user_metadata 開關 + proposal + \x00ACTIONS\x00 協定 + citation-parser 通用化
- [x] E5: POST /api/agent/execute（同一份 core 重跑，防竄改）+ Web 確認卡片
- [x] E6: query prompt 跨工作區章節 + stopWhen 20
- [x] E7: Web/Android 設定頁確認開關

## D — Chat context + @ 標記
- [x] D1: query route current_slug + context_workspace_ids 注入
- [x] D2: Web @ 選單 + chip + current_slug 傳遞
- [x] D3: Android @ 選單 + sendQuery 參數

## C — 對話面板改版（Web）
- [x] C1: 移除頂部導入表單（根治「重複輸入框」觀感）
- [x] C2: Bot 按鈕改多功能選單（選擇模型/導入內容）
- [x] C3: ImportDialog（貼上/拖曳/檔案 + 自動判斷工作區選項）

## F — 智慧導入路由
- [x] F1: ingest schema（workspace_id optional + auto_route + fallback + profile_id 入 schema）
- [x] F2: routeToWorkspace generateText + 回應 routed_workspace_*（先驗 ownership 再抓 URL）
- [x] F3: Web/Android 顯示「已導入到 X」

## G — 自動分類＋去重複
- [x] G1: migration 0015_agent_jobs（GRANT+RLS，單支 apply production，檔案 idempotent）
- [x] G2: /api/organize POST/GET（stale sweep + limit(1) guard）+ organize-pipeline（不給 workspace 生命週期工具、報告存在才回 slug）
- [x] G3: Web Wand2 按鈕 + 確認 + 輪詢 + 跳報告
- [x] G4: Android 入口（AutoFixHigh）+ 輪詢

## H — 筆記功能移除（UI only）
- [x] H1: Web page-tree/workspace-shell notes UI 移除
- [x] H2: Android WikiScreen/WikiViewModel notes UI 移除

## I/J — 視覺（Web only）
- [x] I1: 工作區拖曳 FLIP 動畫（pointer events + prefers-reduced-motion）
- [x] I2: PageTree 移除 FileText icon
- [x] J1: Graph degree sizing + canvas 標籤 + hover 高亮 + 孤兒淡化

## Review（對抗性審查，9 findings 全修）
- [x] organize stale job 卡死（sweep + limit(1)）／ingest fetch-proxy（先驗 owner）／deletePage 確認前查 lock
- [x] cross-workspace citations 污染／organize 不給 workspace admin 工具／report_slug 存在才回
- [x] profiles PATCH 先驗 owner／ACTIONS parser 要求 params／movePageToWorkspace rollback／migration idempotent／AI 建改工作區後刷新選單

## K — 驗證收尾
- [x] K1: typecheck（5/5）/ web build / Android compileDebugKotlin 全綠
- [x] K2: 文件同步（CLAUDE.md/AGENTS.md/CONTEXT.md）+ APK release build + commit push

## Review 心得
- 「輸入框重複顯示兩次」不是 render bug 是版面觀感（頂部導入框 + 底部對話框樣式相近）——移除頂部框根治。
- 破壞性操作確認的關鍵防護：proposal 的 params 從 client 回傳，execute route 必須用 zod 白名單 + 同一份 core 函式重跑所有 guard，不可信任回傳參數。
- 背景 job（organize）沒有 UI 可確認，`gateDestructive` 必須 fail-closed（無 onProposal 就拒絕），否則會對模型謊稱「已顯示確認卡片」。
- ingest 為了 auto-route 把抓 URL 提前了，順手引入 fetch-proxy 漏洞——外部 fetch 一律要在 ownership 檢查之後。
