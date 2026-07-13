# LLM Wiki — AGENTS.md

## 專案概覽

Karpathy-principle 知識庫工具。LLM 持續維護結構化 markdown wiki，內容本體存於使用者的 Google Drive，Supabase 存 metadata + Realtime 推送，BYO API key。

**Monorepo**：`apps/web`（Next.js 16）、`apps/android`（Kotlin + Jetpack Compose）、`packages/`（共用型別/prompts/drive-schema）

**生產環境**：https://llm-wiki-seven.vercel.app

## 技術棧

| 層級 | 技術 |
|------|------|
| Web 前端 | Next.js 16 App Router, Tailwind CSS v4, shadcn/ui |
| AI SDK | `ai@6` (`@ai-sdk/openai-compatible`) |
| 資料庫 | Supabase Postgres + Realtime |
| 儲存 | Google Drive API (`drive.file` scope) |
| 認證 | Supabase Auth + Google OAuth |
| 部署 | Vercel (Fluid Compute) |
| 套件管理 | bun + Turborepo |

## 目錄速查

```
apps/web/
├── app/
│   ├── (auth)/         登入頁
│   ├── w/[wid]/        Workspace 主介面（workspace-shell.tsx）
│   ├── api/
│   │   ├── search/     GET: 全文搜尋（RPC search_pages + ilike fallback）
│   │   ├── ingest/     LLM ingest pipeline（kind: url/text；支援 auto_route 由 AI 選工作區）
│   │   ├── query/      LLM query（streaming；current_slug + context_workspace_ids）
│   │   ├── agent/execute/  POST: 執行使用者確認過的破壞性動作
│   │   ├── organize/   POST/GET: 跨工作區自動分類＋去重複 job
│   │   ├── lint/       週期健康檢查
│   │   └── workspaces/ CRUD + synthesis + reorder
│   └── settings/       LLM profile 管理（含 PATCH 編輯）+ AI 權限開關
├── components/
│   ├── wiki/
│   │   ├── conversation-panel.tsx  ← 對話中心：citations + 確認卡片 + @ 工作區標記 + Bot 多功能選單
│   │   ├── import-dialog.tsx       ← 統一導入入口（貼上/拖曳/檔案 + 自動判斷工作區）
│   │   ├── page-viewer.tsx         ← staleness banner + lock toggle + ReactMarkdown（GFM、frontmatter strip、[[wikilink]] 路由）
│   │   ├── page-tree.tsx           ← 左側導航樹（只顯示 wiki zone；無 icon）
│   │   └── graph-view.tsx          ← react-force-graph-2d（動態 import；degree sizing + hover 高亮）
│   └── workspace/
│       ├── create-form.tsx         ← 新建 workspace + Drive re-auth
│       └── workspace-card.tsx
└── lib/
    ├── ai/
    │   ├── tools.ts             ← 跨工作區 AI 工具（6 頁面 + 5 workspace 管理）
    │   ├── organize-pipeline.ts ← 跨工作區去重＋重新分類
    │   ├── client.ts            ← LLM client factory
    │   └── citation-parser.ts   ← 解析 \x00NAME\x00 metadata blocks
    ├── workspaces/manage.ts  ← create/rename/delete workspace 共用函式
    ├── crypto/               ← AES-256-GCM API key 加解密
    ├── drive/                ← Google Drive API wrapper
    ├── supabase/             ← server/browser client factories
    └── sync/                 ← Realtime hook (useRealtimePages)

packages/
├── shared-types/       TS 型別（LLMProfile, WorkspacePage...）
├── prompts/            ingest/query/lint.md prompt templates
└── drive-schema/       Drive 資料夾路徑常量
```

## 核心 Karpathy 原則

1. **Ingest = 編譯**：一次 ingest 應觸及 10-15 個既有頁面（cascading updates）
2. **Query file back**：問答結果可一鍵存成 synthesis page
3. **LLM 主宰 wiki**：使用者只導演，`updated_by='human'` 標記的頁面 LLM 不覆寫
4. **Sources immutable**：ingest 完成後原始來源不可編輯
5. **分離原則**：`wiki/`（LLM 寫）、`notes/`（LLM 禁區）物理分離。**Phase 14 起筆記 UI 已移除、資料保留**；`notes/` 仍是工具層硬性禁區，不可讓 LLM 寫入
6. **Schema 共同演化**：`_schema/ingest.md` 等可由使用者修改
7. **Conversation + Live Wiki**：右欄對話，左中欄 wiki 即時更新。**產品重心是對話**：使用者在對話講想法 → AI 判斷有價值的內容 → 直接整理成知識頁

## 重要技術差異

### AI SDK v6
- `CoreMessage` → `ModelMessage`
- `maxSteps: N` → `stopWhen: stepCountIs(N)`
- `tool()` 的 `parameters:` → `inputSchema:`
- `result.toDataStreamResponse()` → `result.toTextStreamResponse()`
- **`ai/react` 路徑不存在**，不可 import `useChat`

### Supabase SSR v2
`setAll` callback 型別為 `{ name: string; value: string; options: CookieOptions }`（不是 `CookieOptionsWithName`）

## 開發指令

```bash
bun run dev          # 啟動 Next.js 開發伺服器
bun run typecheck    # Turborepo 全套型別檢查
bun run build        # 建置
```

## 交付流程

- 每次完成任何修改後，必須額外執行一次 Android APK 建置：`.\gradlew.bat :app:assembleDebug`（工作目錄：`apps/android`）
- 每次完成任何修改後，必須提交並推送目前分支到遠端；不可只停留在本機工作樹
- 上述兩件事屬於固定收尾流程，更新 `CLAUDE.md` / `AGENTS.md` / 程式碼時都一樣要做

## 環境變數（.env.local）

```
NEXT_PUBLIC_SUPABASE_URL=
NEXT_PUBLIC_SUPABASE_ANON_KEY=
SUPABASE_SERVICE_ROLE_KEY=
NEXT_PUBLIC_SITE_URL=       # 生產 URL，用於 OAuth callback 與 Android WEB_API_BASE_URL
ENCRYPTION_KEY=             # base64 32 bytes（openssl rand -base64 32）
GOOGLE_OAUTH_CLIENT_ID=
GOOGLE_OAUTH_CLIENT_SECRET=
CRON_SECRET=                # /api/lint GET（Vercel Cron 自動帶 Bearer）驗證用
```

## 進度狀態

- **Phase 0-10b** ✅：MVP、Android、Graph、i18n、安全性強化、Room cache 隔離
- **Phase 11** ✅：批次檔案攝取 + 全文搜尋 + AI 完整檔案操控（deletePage / movePage + backlink rewriting）
- **Production 2026-04-29** ✅：`0004_fulltext_search.sql` 已套用至 Supabase production；臨時 `/api/migrate` route 已移除。
- **Phase 12** ✅（2026-07-12）：全專案健檢——非同步 ingest（`202 { jobId }` + `GET /api/ingest?job_id=` 輪詢，手機匯入不再逾時、可背景執行）、P0 cron 漏洞（`/api/lint/cron` 已刪除）、SSRF 全面強化、tools 層 lock/zone 硬性防護、movePage 反向連結 regex 修復、Web/Android UX 大修、backlinks 面板、migration `0012` 已套用 production。細節見 CLAUDE.md「非同步 Ingest 協定」與「安全注意事項（Phase 12）」。
- **Phase 13** ✅（2026-07-12）：漏洞續掃 + 功能補完 + Web/Android 對齊——`extra_headers` AES-256-GCM 加密（migration `0013`）、SSRF TOCTOU 關窗（undici Agent connect-time lookup）、`broadcast_page_metadata_change` revoke（migration `0014`）、Sources 管理列表（Web `sources-dialog.tsx` + Android `SourcesListDialog`）、Ingest 即時進度（`onStepFinish` 逐步寫回 `touched_pages`）、Android backlinks 面板、離線冷啟 workspace 持久化（DataStore）、chat 草稿 hoist 至 ViewModel。migrations 0013/0014 已套用 production。細節見 CLAUDE.md「安全注意事項（Phase 13）」。
- **Phase 14** ✅（2026-07-13）：對話中心化 + 跨工作區 AI——移除筆記 UI（資料保留）、跨工作區 AI 工具（建立/改名/刪除工作區、跨工作區搬頁）、破壞性操作確認卡片（`\x00ACTIONS\x00` + `/api/agent/execute`）、對話預設帶當前頁 context + `@` 工作區標記、統一導入入口（AI 自動判斷目標工作區）、自動分類＋去重複 job（`/api/organize` + migration `0015` agent_jobs，已套用 production）、LLM profile 編輯、效能修復（Drive 呼叫移出 server component 請求路徑）、工作區拖曳 FLIP 動畫、Graph Obsidian 化。細節見 CLAUDE.md。

## 關鍵功能

### Bot 多功能選單（模型 + 導入）
- `conversation-panel.tsx` 輸入框左側 `Bot` 按鈕 =「導入內容」＋「選擇模型」（Android chat sheet 的 `SmartToy` 同理，另有「從檔案匯入」）
- profile 列表來自 `/api/settings/profiles`，預設選中 `is_default=true`
- Query / Ingest / Organize API 支援 `profile_id` override，檢查 `owner_id` 權限
- **不要再加獨立的導入輸入框**：舊版把導入 textarea 疊在對話輸入框上方，使用者會誤認成「輸入框重複顯示兩次」

### 統一導入 + 智慧路由
- `import-dialog.tsx`：貼上 URL/文字/Markdown、拖曳檔案、多檔佇列（pending/uploading/done/error）
- 目標工作區預設「自動判斷」：POST `/api/ingest` 帶 `{ auto_route: true, fallback_workspace_id }`，server 用一次 LLM 呼叫選工作區，**失敗一律 fallback，不可擋掉匯入**；回應帶 `routed_workspace_name` 供 UI 顯示「已導入到 X」

### 跨工作區 AI + 破壞性操作確認
- `lib/ai/tools.ts` 的頁面工具都吃可選 `workspace_id`；`resolveScope()` 必帶 `.eq('owner_id', userId)`
- 新增 workspace 管理工具：`listWorkspaces` / `createWorkspace` / `renameWorkspace` / `deleteWorkspace` / `movePageToWorkspace`
- 破壞性操作（刪頁 / 刪工作區）預設需確認：工具不執行 → 串流尾端送 `\x00ACTIONS\x00[...]` → 前端確認卡片 → `POST /api/agent/execute` 用**同一份 core 函式**重跑（guard 全部再驗一次，client 無法竄改繞過）
- 偏好存在 auth `user_metadata.ai_confirm_destructive`（Web/Android 共用）

### 自動分類＋去重複
- `POST /api/organize` → `agent_jobs`（migration `0015`）→ `after()` 背景跑 → `GET ?job_id=` 輪詢 → 報告頁 `_organize/YYYYMMDD.md`
- 入口：Web 頂列 `Wand2`、Android drawer `AutoFixHigh`

### 全文搜尋
- **DB**：`pages.search_text TEXT` + `pages_fts_idx` GIN index + `search_pages` RPC
- **API**：`GET /api/search?workspace_id=xxx&q=keyword`（RPC → ilike graceful fallback）
- **UI**：`workspace-shell.tsx` 頂部 `Search` 按鈕，debounce 200ms

### AI 工具（`lib/ai/tools.ts`）

頁面工具都吃可選 `workspace_id`（省略＝當前）。workspace 管理工具只在 `crossWorkspace: true` + `userId` 時掛載（query / organize 有，ingest pipeline 沒有）。

| 工具 | 說明 |
|------|------|
| `readPage` / `writePage` / `searchPages` / `listPages` | 讀 / 寫（同步 `page_links`+`search_text`）/ ilike 搜尋 / 列頁 |
| `deletePage` | 清理 `page_links`、刪 Drive file、刪 DB record（**破壞性**，走確認） |
| `movePage` | 重命名/移動，重寫所有 incoming `[[wikilink]]`（帶/不帶 `.md` 都匹配） |
| `listWorkspaces` / `createWorkspace` / `renameWorkspace` | 列 / 建（走 `manage.ts`）/ 改名工作區 |
| `deleteWorkspace` | 刪工作區：先 trash Drive 再刪 DB（**破壞性**，走確認） |
| `movePageToWorkspace` | 跨工作區搬頁：讀來源 → 寫目標 → 刪來源 |

**工具層硬性防護（勿移除）**：所有寫入/刪除/移動路徑拒絕 `notes/`、`_schema/`、`sources/`、`..` slug 與 `locked_by_human` 頁面；`index.md`/`log.md` 不可刪除/移動；`resolveScope` 必帶 owner 檢查；slug 自動補 `.md`；page write/delete core 是 module-level 函式（`writePageForWorkspace`/`deletePageForWorkspace`），與 `/api/agent/execute` 共用。

### 串流 metadata 協定
Query API 文字串流結尾依序附加 `\x00CITATIONS\x00[...]`、`\x00ACTIONS\x00[...]`（proposal）。前端 `citation-parser.ts` / Android `parseStreamMeta()` 解析，**未知 block 名稱一律忽略**。串流顯示文字截到第一個 `\x00`。

### Drive Token 失效處理
`create-form.tsx` 偵測 403 + "Google Drive" → 顯示「Re-connect Google Drive」按鈕 → `signInWithOAuth({ prompt: 'consent', access_type: 'offline' })` → auth/callback 重新儲存 refresh token。

### 筆記／規則
- 工作區建立與頁面列表讀取時，會自動補齊 `notes/guide.md` 與 `_schema/{ingest,query,lint}.md` 的 metadata，避免「筆記／規則」區看起來像空白故障
- 設定頁若偵測 `schema` zone 缺少系統規則頁，會先做 DB count pre-check，再呼叫 `ensureWorkspaceSystemPages()` 補齊後重新查詢，避免規則區空白
- `notes/guide.md` 與 `_schema/*.md` 的預設內容會跟著目前 UI 語系切換；若內容仍是預設模板，切語言時要同步改成對應語言並 bump `version`，讓 Android Room cache 重新載入
- Web 與 Android 都可新增、重新命名、刪除新的 `notes/*.md` 頁面，且筆記／規則頁都用內建 Markdown 工具列編輯；LLM 仍只讀 `notes/`，不會主動改寫
- `_schema/*.md` 入口搬到設定頁，仍顯示為「匯入規則 / 查詢規則 / 健康檢查規則」；不要再把規則當成一般 Wiki 側欄區塊
- Web 與 Android 的 markdown 內部連結都應留在同一個 App / 視窗內跳轉，不另開新視窗
- Android 頁面內容讀取優先走 Web `/api/pages/{workspaceId}/{slug}`，避免手機端 Google Drive `drive.file` scope 與 Web 匯入檔案歸屬不同造成空內容
- `/api/pages/[workspaceId]/[...slug]` 的 GET 現在固定回 JSON；成功時 `content` 必須是字串，失敗時回 `{ error: { code, message, requestId, ...publicMeta } }`，不可把 Drive 內部 metadata 洩漏給 client
- `readDriveFile()` 會先查 Drive metadata 再依 MIME type 分流：`text/markdown` / `text/plain` 直接讀、Google Docs 走 export、`application/octet-stream` 先過 binary guard；讀不到就 throw `DriveReadError`，不可 silent fallback 成空字串
- Web `PageViewer` 若收到 `DRIVE_RECONNECT_REQUIRED`，必須顯示可直接觸發 OAuth 重授權的按鈕；不能只顯示錯誤文字讓使用者自己猜

### 工作區排序
- `workspaces.sort_order`（`0005_workspace_sort_order.sql`）保存使用者自訂順序
- Web 工作區選單支援 drag-and-drop 重排，API 為 `/api/workspaces/reorder`
- Android 工作區選單支援上移 / 下移，走同一套排序 API
- Web 首頁導頁、登入回跳與工作區列表查詢若遇到 production 尚未套用 `sort_order` 或 schema cache 未刷新，必須 fallback 至 `created_at`，不可誤判為沒有工作區
- 若 production 出現「拖曳後又跳回原順序」，先查 `workspaces.sort_order` 是否存在；缺欄位時只執行 idempotent 的 `0005_workspace_sort_order.sql` 修 schema，不要用整批 `db push` 硬套舊 migration history

## 安全注意事項

| 嚴重度 | 位置 | 問題 | 修復 |
|--------|------|------|------|
| P0 | `api/lint/route.ts` | admin client 查 `llm_profiles` 缺 `.eq('owner_id', userId)` | 已加入 `.eq('owner_id', userId)` |
| P0 | `WikiViewModel.kt` | `webApiUrl()` 用字串替換推導 URL，token 可送錯 domain | 改用 `BuildConfig.WEB_API_BASE_URL` |
| P1 | `WikiViewModel.signOut()` | 登出後未清空 Room cache / 未取消 WorkManager job | 已加入 `deleteAll()` + `SyncWorker.cancel()` |
| P1 | `.env.example` | `ENCRYPTION_KEY` 說明寫 `openssl rand -hex 32`（hex），程式碼用 `base64` | 已改為 `-base64 32` |
| P1 | `0003_profile_ownership_guards.sql` | FK 未保證 profile owner = workspace owner | 已加入 composite FK + trigger guard |

## Android 注意事項

- `GOOGLE_CLIENT_ID` 必須使用 **Web OAuth client ID**（非 Android client ID）
- `WEB_API_BASE_URL` 是必要 build config（來源：`local.properties` 或 `NEXT_PUBLIC_SITE_URL`）
- Android 現在有 `workspace-create` route；登入後若沒有 workspace，直接進建立工作區畫面
- Google Drive 重新授權 deep link 使用 `llmwiki://auth/reconnect?source=...`；`apps/web/app/auth/reconnect/page.tsx` 為 Android 啟動 OAuth 的橋接頁
- Android Supabase Auth 必須設定 `SettingsSessionManager()` + `SettingsCodeVerifierCache()`，否則 session 不會跨 App 重啟保留
- `AppPreferencesRepository` 必須共用同一個 `preferencesDataStore`；不要在 Activity 與 ViewModel 各自用 `PreferenceDataStoreFactory.create()` 開同一個檔案，否則設定頁會直接閃退
- Android 語言切換需由 `AppCompatActivity` 在 `setContent` 前先套用已儲存 locale，且只在 `toLanguageTags()` 真正變動時呼叫 `AppCompatDelegate.setApplicationLocales()`，否則會造成切換失效或啟動閃黑
- Android 呼叫 Web API 時要先用 `requireAccessToken()` 取 token；若目前 token 為空但 session 仍在，要先 refresh，再於 401 時再 refresh 重試一次，直接拿舊 access token 容易讓設定頁與 LLM profiles 同步失敗
- Android 呼叫 Web API / Supabase PostgREST 時應先用 `requireAccessToken(forceRefresh = false)` 取現有 token；只有 token 為空或收到 401 才以 `forceRefresh=true` 重試。`refreshCurrentSession()` 必須透過共用 mutex 序列化，避免多個初始化流程同時 refresh 導致 refresh token 競爭並出現「登入狀態已失效」。
- Android Web API 錯誤解析要處理純文字 `Unauthorized`；部分 route（例如 `/api/query` stream）不一定回 JSON，需轉為本地化錯誤訊息
- Android 對預期 JSON 的 Web API 回應不可只看 HTTP 2xx；Vercel 對未部署的 method/path 可能回 `200 text/html`，必須確認 body 是 JSON object 才能更新本機狀態
- Android 讀取 LLM profiles 使用 `LlmProfileRepository` 直接查 Supabase `llm_profiles`（RLS + `owner_id`），不要用 Web API Bearer token 做列表同步；Web API 保留給需要 server-side 加密的 create/delete
- `MainActivity` 不要在 `onCreate()` 用 `runBlocking` 等待 Supabase Auth 初始化；改由 `LlmWikiNavGraph` 的 launch route 非阻塞判定 session，避免啟動卡頓或黑屏
- Android `LlmWikiNavGraph` 先進 `launch` route，再非阻塞導向 `auth` / `wiki` / `workspace-create`；已登入使用者不必先經登入頁轉圈
- Android 登出時要同步清除 `GoogleSignIn` 快取，否則下次登入不會再出現 Google 帳號選擇器
- Android Wiki drawer 使用工作區下拉選單；建立工作區整合在下拉內，並支援從手機附加文字檔直接 ingest
- Android workspace 下拉選單需提供切換、新建、重新命名、刪除；刪除時清掉該 workspace 的 Room cache 並選下一個 workspace 或回建立頁
- Android workspace 下拉選單的切換區與 rename/delete action 區必須分離，且 action hit target 至少 44dp；否則容易誤觸成切換 workspace
- Android Chat 模型選擇用模型/聊天語意 icon（例如 `SmartToy`），不要用設定齒輪；頁面鎖定狀態需以 `Lock` / `LockOpen` 區分，因為鎖頭本身可點擊切換
- Android `MarkdownViewer` 用 Markwon + `TextView` 時必須在 Compose update 內同步 `MaterialTheme` 的文字與連結顏色，否則深色模式會出現黑底黑字
- Android FAB 要明確設定 `containerColor` / `contentColor`，不要依賴預設 primaryContainer；淺色模式容易出現不自然白色塊
- Web API 若要服務 Android，需支援 `Authorization: Bearer <token>`；不要只依賴 cookie session
- `lib/supabase/request.ts` 驗證 Android Bearer token 時需用 admin client `auth.getUser(token)`，再回傳 bearer Supabase client 給 RLS 查詢；只用 anon/bearer client 驗證會造成有效 token 被判定 Unauthorized
- Workspace 管理需 Web / Android 對齊：`PATCH /api/workspaces/[id]` 更新名稱，`DELETE /api/workspaces/[id]` 刪除 workspace；刪除必須先成功 trash Google Drive folder 才能刪 DB，避免狀態不一致
- Android 端 workspace 刪除只有在 API 回 `{ ok: true }` 後才能清本機 Room / UI 狀態；不可 optimistic remove，否則 production route 漏部署時會出現手機消失但 Web/Drive 仍存在
- Android 共用 `AndroidHttpClient` 必須設定 Ktor timeout（connect 10s / socket 310s / request 320s）；socket timeout 需涵蓋 `/api/lint` 這類完成前零輸出的同步呼叫（伺服器預算 300s）。timeout / DNS / connection abort 要轉成本地化網路錯誤
- Ingest 走非同步協定：POST 立即回 `{ jobId, status: 'running' }`，Android `pollIngestJob()` 每 3s 輪詢 `GET /api/ingest?job_id=`；App 切頁/背景不影響伺服器端 job
- Android 切換、新建或刪除後切到下一個 workspace 時，`syncPagesInternal()` 後需自動選中 `index.md`（fallback `log.md`），避免停在「從選單選擇一個頁面」
- Android 匯入本機文字檔要限制大小（2 MB）並以串流文字讀取，不可直接 `readBytes()` 全讀進記憶體
- Web 三欄拖曳改用 `requestAnimationFrame` 批次更新寬度，避免拖動卡頓
- 共用色票已改為 teal-blue；若新增顏色請同步 `packages/ui/src/styles.css` 與 Android `ui/theme/Color.kt`
- Chat 串流：POST `/api/query` → `text/plain` stream → Ktor `bodyAsChannel()` + `readUTF8Line()`
- 登出：`PageDao.deleteAll()` + `SyncWorker.cancel()` + `navigate("auth") popUpTo(0) inclusive=true`
- `Icons.AutoMirrored.Filled.List` 取代舊版 `Icons.Default.Menu`
- `PageRepository.syncPages()` 不再限制 200 筆，且會刪除本機已過期頁面，避免手機端顯示舊資料
- Android `refreshAfterForeground()` 回到前景時需同步目前 workspace，否則 Web 端剛匯入完成的 `index.md` / `log.md` 容易被本機舊快取蓋住，看起來像手機沒更新
- Android / Web 的內部 wiki 連結解析都要接受不帶副檔名的 slug（例如 `entities/foo`），並自動補成 `.md`，否則索引頁連結會顯示但不能跳
- Web / Android 建立工作區 UI 不保留 description 欄位；Web `/w/create` 需提供返回 `/w` 的按鈕
- 使用說明入口需在 Web top bar 與 Android drawer 同步提供，說明內容涵蓋工作區、匯入、對話、設定同步與 Drive 重授權

## 功能開發原則

**Web 與 Android 功能必須同步**：實作任何使用者可見功能時，需檢查 Web 與 Android 是否都需要對齊；若只適用單一平台，需明確說明。Android 呼叫與 Web 相同的後端 API，無需另建端點。

## 其他

- **Markdown 渲染**：`page-viewer.tsx` 用 `react-markdown` + `remark-gfm`。YAML frontmatter 以 `stripFrontmatterAndWikilinks()` 手動 strip（不用 `remark-frontmatter`，那個不自動隱藏內容）。`[[slug]]` 轉成 `[slug](wiki://slug)` 供自訂 `<a>` renderer 攔截；ReactMarkdown 必須設定 `urlTransform` 放行 `wiki:`，否則預設 sanitizer 會把 href 清空。
- **`.env.vercel.tmp`**：`vercel env pull` 輸出的暫存檔，已加入 `.gitignore`，不應提交。
- Lucide v3 已移除 icon 的 `title` prop，改用 `aria-label`
- `packages/prompts` 的 `.md` import 需要 `markdown.d.ts` + webpack `asset/source` loader
- TypeScript target 需 ES2023（`Array.prototype.findLast`）
- Google Drive scope 用 `drive.file`
- i18n cookie-based（`NEXT_LOCALE`），`zh-TW`（預設）和 `en`
- GraphView 動態 import `react-force-graph-2d` 避免 SSR 問題
- Vercel Cron：每週一 03:00 UTC 直接 `GET /api/lint`（Vercel 自動帶 `Authorization: Bearer CRON_SECRET`；舊 `/api/lint/cron` 無驗證代理已因 P0 漏洞刪除，不可加回）
- Supabase DB migration 若本機 5432/6543 被擋，可從 Vercel/serverless 走 pooler：`aws-1-ap-southeast-1.pooler.supabase.com:6543`，user 格式 `postgres.<project-ref>`


<claude-mem-context>
# Memory Context

# [LLM-wiki] recent context, 2026-05-14 8:43pm GMT+8

Legend: 🎯session 🔴bugfix 🟣feature 🔄refactor ✅change 🔵discovery ⚖️decision 🚨security_alert 🔐security_note
Format: ID TIME TYPE TITLE
Fetch details: get_observations([IDs]) | Search: mem-search skill

Stats: 50 obs (22,633t read) | 769,081t work | 97% savings

### Apr 29, 2026
S33 Fix Google Drive OAuth redirect loop in workspace creation and chat flows; remove redundant manual reconnect button (Apr 29, 4:57 AM)
### May 3, 2026
S34 Debug `invalid_client` Google OAuth error after redirect loop fix — GCP OAuth client credentials mismatch (May 3, 5:11 PM)
S35 繼續 LLM-wiki 開發 — 升級 PageViewer 支援 Markdown 渲染並恢復 Realtime 監聽 (May 3, 5:12 PM)
### May 5, 2026
S36 修復 .env.vercel.tmp 未排除問題、更新文件、從工作紀錄萃取可複用 Skills (May 5, 12:45 AM)
S37 修復 .env.vercel.tmp gitignore、更新文件、從工作紀錄萃取 Skills 並同步至正確目錄 (May 5, 1:41 AM)
S38 Investigate and fix Supabase project "llm-wiki" 504 MIDDLEWARE_INVOCATION_TIMEOUT error, Disk IO budget exhaustion, and Security Advisor warnings (May 5, 1:44 AM)
### May 10, 2026
S48 Reduce Supabase egress costs by 60-75% across Android and web clients in LLM-wiki monorepo (May 10, 4:53 AM)
### May 13, 2026
S49 整理接下來要做的事情詳細一點 — Detailed deployment checklist for Supabase Realtime egress optimization (May 13, 1:40 AM)
S51 Supabase Data API 預設 GRANT 政策變更影響評估與因應 — LLM-wiki 專案 (May 13, 1:50 AM)
833 10:58p 🔵 LLM-wiki Migrations Have No Table GRANT Statements
834 " 🔵 LLM-wiki Init Migration Creates 7 Tables With RLS But No Table GRANTs
839 11:01p 🔵 Migration 0009 Revokes RPC Execute on Internal Trigger Functions
842 " 🔵 google_oauth_tokens Table Uses Deny-All RLS — Server-Side Access Only
843 " 🔵 Migration 0007 Adds workspace_sync_state Table — Also Missing GRANT
844 " 🔵 Migration 0006 Switched search_pages from SECURITY DEFINER to SECURITY INVOKER
845 " 🔵 Pages Realtime Switched from postgres_changes to Supabase Broadcast
846 " 🔵 Migration 0010 Revokes PUBLIC Execute on All Internal Functions
848 11:02p 🔵 Complete Audit: 9 Tables and 1 RPC Function Need GRANT Review for Supabase Change
851 " 🟣 Migration 0011 Created to Add Explicit Data API GRANTs for All Tables
854 11:03p 🔵 LLM-wiki Deployed on Vercel as Project "llm-wiki" Under Hobby Plan
856 11:04p 🔵 Production Supabase Project Identified; SUPABASE_SERVICE_ROLE_KEY Is Empty
859 " 🔵 SUPABASE_SERVICE_ROLE_KEY Missing from Both Local and Production Env Files
861 11:06p 🔵 SUPABASE_SERVICE_ROLE_KEY IS Set in Vercel Production — Local Pull Was Stale
862 11:07p 🔵 Service Role Key Found in .env.vercel.tmp at Project Root
863 11:08p 🔵 Data API Test Returned 401 Due to Unexpanded PowerShell Env Vars
864 " 🔵 Data API Currently Works for Existing Tables — Old Implicit Grant Still Active
865 " 🚨 Anthropic API Key Exposed in Primary Session
866 11:09p 🔵 Production Database Has Live Data — Service Role Key Confirmed Working
867 " 🔵 Supabase Projects Inventory for LLM-wiki Workspace
868 " 🔵 Supabase CLI Non-TTY Login Requires --token Flag
877 11:13p 🚨 Supabase Data API Default Grant Behavior Changing May 30 / Oct 30 2026
878 " 🔵 Supabase Management API Rejects service_role JWT for Database Queries
899 11:24p 🔐 Supabase Data API Public Schema Grant Policy Change
900 11:25p 🔵 owns_workspace RPC: anon 拒絕 (42501)，service_role 返回 false
901 " 🟣 Migration 0011: Data API GRANTs + ALTER DEFAULT PRIVILEGES
906 11:27p ✅ Migration 0011 committed and pushed to GitHub master
### May 14, 2026
935 1:12a 🚨 Supabase Data API Public Schema Grant Requirement — Breaking Change
936 " ✅ Supabase Data API GRANT Policy Documented in CLAUDE.md
937 1:15a 🚨 Supabase Data API Default Grant Policy Change
S52 Supabase Data API GRANT policy change — assess impact and update project/global documentation (May 14, 1:15 AM)
958 6:49p 🔵 Tracing "Failed to load page" Errors Across Android and Web
959 6:50p 🔵 Root Cause Analysis: Page Content Loading Architecture and Three Failure Paths
960 6:51p 🔵 Settings Rules Panel Missing Backfill Trigger — Schema Pages Never Auto-Populated
961 " 🔵 Egress Optimization Created Drive File Orphan Risk — Pages Table Can Reference Deleted Drive Files
962 " 🔵 Wiki Internal Link Navigation Works — Failure Limited to RulesPanel Context
963 6:59p 🔵 Three Independent Bugs Identified for Android/Web/Settings Failures
964 " ⚖️ Fix Strategy: Diagnose Android API Response Before Code Changes
965 7:05p 🔵 Root cause analysis: Three distinct bugs in page loading, navigation, and settings
966 7:11p ⚖️ LLM-Wiki 頁面載入失敗三合一修復計畫 v2 — Diagnostic 優先策略
970 7:16p ⚖️ LLM-Wiki 頁面載入失敗修復計畫 v3：六階段全端修復架構
971 7:33p ⚖️ Wiki App Bug Fix Plan v3: Page Load / Settings / Wikilink Failures
972 " 🟣 DriveReadError: Dual-Layer Error Metadata with TypeScript Union Codes
973 " 🔴 readDriveFile: MIME-Branched Reading with Binary Guard and Google Docs Fallback
974 " 🔴 Android PageRepository: Sealed Result Type Replaces Silent Drive Fallback
975 " 🔴 Settings Page Schema Backfill with DB Pre-Check
976 " 🔴 Wikilink Fix: onWikiLinkClick Prop and PageViewer Content Type Validation
977 7:34p 🔵 P0 Diagnostic: Root Cause of Blank Content Confirmed in readDriveFile
978 " 🔵 Existing Drive Auth Error Handling Uses String-Matched Error Messages, Not Structured Codes
979 7:35p 🔴 P1+P2 Implemented: DriveReadError, readDriveFile MIME Branching, and Structured API Errors
980 " 🔴 P4+P5 Web: Settings Backfill, RulesPanel onWikiLinkClick, PageViewer Content Validation

Access 769k tokens of past work via get_observations([IDs]) or mem-search skill.
</claude-mem-context>
