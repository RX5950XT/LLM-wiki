# 第二輪：漏洞續掃 + 功能補完 + Web/Android 對齊（2026-07-12）

## Phase G — 漏洞續掃
- [x] G1: `extra_headers` 改 AES-256-GCM 加密（migration 0013 + POST 加密 + client.ts 解密 + GET 停止回傳明文）→ 已套用 production
- [x] G2: SSRF TOCTOU 關窗——undici Agent connect-time lookup（node 腳本實測 PASS）
- [x] G3: revoke `broadcast_page_metadata_change` EXECUTE（先以 rollback transaction 實測 trigger 不受影響，migration 0014 已套用 production）
- [x] G4: advisors 其餘項目處置（owns_workspace 必要保留已註記；leaked password protection 記為 Dashboard 手動項）

## Phase H — Web/Android 對齊
- [x] H1: Android backlinks 面板（page_links 直查 + AssistChip 列）
- [x] H2: Android 離線冷啟 workspace 持久化（DataStore JSON snapshot + refreshWorkspaces 失敗還原）
- [x] H3: Android chat 草稿 hoist 至 WikiUiState.chatDraft

## Phase I — 功能補完
- [x] I1: Sources 管理列表（Web sources-dialog.tsx + Android SourcesListDialog，含最新 job 狀態）
- [x] I2: Ingest 即時進度（onStepFinish 逐步寫回 touched_pages；Web/Android 輪詢顯示「已更新 N 頁」）

## Phase J — 驗證收尾
- [x] typecheck（5/5）/ web build / APK（BUILD SUCCESSFUL 52s）全綠
- [x] 文件同步（CLAUDE.md Phase 13 + 安全節 / AGENTS.md / CONTEXT.md 改寫）
- [x] commit + push

## Review（Phase G-J）

extra_headers 的修法能做到「零遷移」是因為先查了 production 資料（0 筆帶 headers）——先看資料再設計遷移策略。
TOCTOU 修法的關鍵驗證是「undici connect.lookup 真的會被呼叫」，用 10 行 node 腳本實測比讀原始碼快且可信。
revoke trigger function 的 EXECUTE 屬於「文件說安全但後果嚴重」類操作，先在 production 用 begin/rollback 實測是必要成本。

---

# 全專案健檢與修復（2026-07-12）

## Phase A — 研究/審計
- [x] Workflow 平行審計：security（7 發現，5 確認 2 駁回）/ UX web（12 條）/ UX android（12 條）/ Karpathy 差距（inline 完成）

## Phase B — 匯入（ingest）速度與穩定性
- [x] Server：ingest 改非同步——立即回 `202 { jobId }`，pipeline 用 `after()` 背景執行
- [x] Server：`GET /api/ingest?job_id=`（含 stale running job >8min 掃回 failed）
- [x] Server：URL fetch 20s timeout + 5MB 上限；text 2MB 上限；URL 失敗回 422 JSON
- [x] Server：ingest pipeline Drive folder cache（減少重複 findFile）＋前置 findFile 平行化
- [x] Web UI：ingest / 批次上傳改輪詢 job 狀態，完成顯示「已更新 N 頁」
- [x] Android：ingest 改輪詢；可切頁面/背景（job 在伺服器端），回前景自動同步

## Phase C — bug / 漏洞修復
- [x] P0：刪除 `/api/lint/cron` 無驗證代理；cron 直指 `/api/lint`；timingSafeEqual
- [x] P1：SSRF 全面強化（IP 正規化 + DNS 檢查 + 逐跳 redirect）
- [x] P2：`writePage` 等工具加 locked_by_human / zone / protected-slug 硬性防護
- [x] P2：pages PATCH content 2MB 上限
- [x] P3：synthesis answer/cited_slugs 上限與 slug regex；顯式 owner 檢查
- [x] P3：migration 0012（google_oauth_tokens 只留 service_role）→ 已套用 production
- [x] `movePage` 反向連結 regex 修復（不帶 .md 的 wikilink 之前不會被改寫）
- [x] `searchPages` fallback PostgREST 特殊字元清洗
- [x] `/api/query` messages schema 驗證
- [x] page-viewer save/lock 失敗不再吃掉整頁（actionError 內嵌條）
- [x] extra_headers 擋 authorization key（完整加密列入 CONTEXT.md 待辦）

## Phase D — UI/UX 優化
- [x] Web：RWD 收合、觸控拖曳、瀏覽器返回、Ctrl+K + 鍵盤搜尋、五對話框 a11y、
      聊天可中止、未儲存草稿保護、lint 錯誤條+reportSlug、profile 刪除確認、
      graph i18n/ResizeObserver/圖例/主題色、violet 殘留色修正、佔位文案提示快捷鍵
- [x] Android：rememberSaveable、BackHandler、chat sheet 內嵌錯誤、syncError 可關閉、
      syncLoading spinner、ExternalEvent token、錯誤本地化、48dp 工具列、
      surfaceContainer 色票、DayNight 主題、FilterChip、launchSingleTop、離線啟動路由修復

## Phase E — Karpathy 精神補強
- [x] 原則 3/5（lock、zone 分離）從 prompt 宣示升級為工具層強制
- [x] Backlinks 面板（Web PageViewer）
- [x] Ingest cascade 可見性（touched pages 回饋）
- [x] Lint 模型獲知今日日期 + 回傳實際 reportSlug
- [ ] 後續（見 CONTEXT.md）：矛盾呈現 UI、Sources 管理頁、逐頁 ingest 進度、Android backlinks

## Phase F — 驗證與收尾
- [x] `bun run typecheck` 全綠
- [x] `bun run build` 成功
- [x] Android `.\gradlew.bat :app:assembleDebug` BUILD SUCCESSFUL
- [x] 更新 CLAUDE.md / AGENTS.md、建立 CONTEXT.md、tasks/lessons.md
- [x] commit + push

## Review

根因鏈：匯入「慢又一直報錯」= 同步 pipeline（300s 零輸出）× Android socket timeout（120s）。
改為 job 化後 POST 秒回，穩定性問題（背景斷線、逾時、stuck job）一次解決。
安全面最嚴重的是 lint/cron 匿名觸發（可燒光所有使用者 API 額度）與 SSRF 繞過，皆已修復並經
對抗性驗證確認；兩個審計發現被驗證駁回（避免了錯誤的 revoke 造成 prod 事故）。
所有修改經 typecheck / web build / APK build 三重驗證。
