# LLM Wiki — CLAUDE.md

## 專案概覽

Karpathy-principle 知識庫工具。LLM 持續維護結構化 markdown wiki，內容本體存於使用者的 Google Drive，Supabase 存 metadata + Realtime 推送，BYO API key。

**Monorepo 結構**：`apps/web`（Next.js 16）、`apps/android`（Kotlin + Jetpack Compose）、`packages/`（共用型別/prompts/drive-schema）

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

## 重要 AI SDK v6 差異（避免踩坑）

- `CoreMessage` → `ModelMessage`（從 `ai` 匯入）
- `maxSteps: N` → `stopWhen: stepCountIs(N)`（需匯入 `stepCountIs` from `ai`）
- `tool()` 的 `parameters:` → `inputSchema:`
- `result.toDataStreamResponse()` → `result.toTextStreamResponse()`
- `toolResult.result` → `toolResult.output`
- **`ai/react` 路徑不存在**，不可 import `useChat`；改用自訂 fetch + ReadableStream hook

## 重要 Supabase SSR v2 差異

`setAll` callback 的型別：
```typescript
import type { CookieOptions } from '@supabase/ssr';
type CookieEntry = { name: string; value: string; options: CookieOptions };
// 不是 CookieOptionsWithName（缺少 value 欄位）
```

## 目錄速查

```
apps/web/
├── app/
│   ├── (auth)/         登入頁
│   ├── w/[wid]/        Workspace 主介面（workspace-shell.tsx）
│   ├── api/
│   │   ├── ingest/     LLM ingest pipeline
│   │   ├── query/      LLM query（streaming）
│   │   ├── lint/       週期健康檢查
│   │   └── workspaces/ pages CRUD
│   └── settings/       LLM profile 管理
├── components/
│   ├── wiki/           PageTree, PageViewer, ConversationPanel
│   └── workspace/      WorkspaceCard
└── lib/
    ├── ai/             LLM client factory + tools + ingest pipeline
    ├── crypto/         AES-256-GCM API key 加解密
    ├── drive/          Google Drive API wrapper
    ├── supabase/       server/browser client factories
    └── sync/           Realtime hook (useRealtimePages)

packages/
├── shared-types/       TS 型別（LLMProfile, WorkspacePage...）
├── prompts/            ingest/query/lint.md prompt templates
└── drive-schema/       Drive 資料夾路徑常量
```

## 核心 Karpathy 原則（設計決策基準）

1. **Ingest = 編譯**：一次 ingest 應觸及 10-15 個既有頁面（cascading updates）
2. **Query file back**：問答結果可一鍵存成 synthesis page
3. **LLM 主宰 wiki**：使用者只導演，`updated_by='human'` 標記的頁面 LLM 不覆寫
4. **Sources immutable**：ingest 完成後原始來源不可編輯
5. **分離原則**：`wiki/`（LLM 寫）、`notes/`（使用者寫，LLM 唯讀）物理分離
6. **Schema 共同演化**：`_schema/ingest.md` 等可由使用者修改
7. **Conversation + Live Wiki**：右欄對話，左中欄 wiki 即時更新

## 開發指令

```bash
bun run dev          # 啟動 Next.js 開發伺服器
bun run typecheck    # 跑 Turborepo 全套型別檢查
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
ENCRYPTION_KEY=          # base64 32 bytes，用於 AES-256-GCM 加密 API key / Google refresh token
GOOGLE_OAUTH_CLIENT_ID=
GOOGLE_OAUTH_CLIENT_SECRET=
```

## 目錄速查（補充）

```
apps/web/
├── app/api/
│   ├── search/                     ← GET: 全文搜尋（RPC search_pages + ilike fallback）
│   ├── workspaces/[id]/synthesis/  ← POST: 儲存 Q&A 為 synthesis page
│   └── pages/[wid]/[...slug]/lock/ ← PATCH: 切換 locked_by_human
├── components/wiki/
│   ├── conversation-panel.tsx  ← 含 citation chips + file-back 通知 + icon-only 模型選擇器 + 批次上傳佇列
│   └── page-viewer.tsx         ← 含 staleness banner + lock toggle + ReactMarkdown（GFM、frontmatter strip、[[wikilink]] 路由）
└── lib/ai/
    ├── tools.ts                  ← AI wiki 工具（read/write/search/list/delete/move）
    └── citation-parser.ts      ← 解析串流尾端的 \x00CITATIONS\x00 block
```

## Citation 串流協定

Query API 在文字串流結尾附加：
```
\x00CITATIONS\x00["entities/karpathy.md","concepts/rag.md"]
```
前端用 `citation-parser.ts` 的 `parseCitations(raw)` 解析，分離 text 和 citedSlugs。

## 功能開發原則

**Web 與 Android 功能必須同步**：實作任何使用者可見功能時，需檢查 Web 與 Android 是否都需要對齊；若只適用單一平台（例如 Web-only 的版面、tooltip、route loading），需在回報時明確說明。  
Android 呼叫與 Web 相同的後端 API（`/api/ingest`、`/api/query`、`/api/pages/…`、`/api/workspaces/…`），無需另建端點。

## 進度狀態

- **Phase 0** ✅：Monorepo + Next.js 16 + Android 骨架 + Supabase schema
- **Phase 1** ✅：Web MVP — Google OAuth + Drive 初始化 + Source ingest + Wiki 瀏覽 + Realtime 同步
- **Phase 2** ✅：Query file-back + Citation chips + Version staleness banner + Lock/unlock toggle
- **Phase 3** ✅：Android（Kotlin + Compose）— Google Sign-In + Room 離線快取 + Markwon viewer + 分享意圖 + WorkManager 背景同步
- **Phase 4** ✅：Lint + Graph view + 開源準備 — GraphView (react-force-graph-2d), Lint trigger button, README quick-start
- **Phase 5** ✅：Graph edge fix + 開源收尾 — page_links 寫入、.env.example、vercel.json cron、CONTRIBUTING.md
- **Phase 6** ✅：介面優化 — 完整繁體中文 i18n、多工作區切換 + 新增工作區、登出按鈕、設定返回按鈕
- **Phase 7** ✅：Ingest 任意格式（URL/文字/Markdown）、側邊欄拖移調整寬度、設定頁個人資料、Drive token 失效重授權
- **Phase 8** ✅：Android 功能對齊 — Chat/Query 串流、citations、synthesis file-back、文字/Markdown ingest、lock toggle、登出
- **Phase 9** ✅：Web 介面精修 — 設定頁主題切換、route loading 骨架屏、檔案上傳 ingest、完整 i18n tooltip；Android 無需變更（本階段為 Web-only UI/效能調整）
- **Phase 10** ✅：安全性強化 + Android 手機 UI 適配 — 見下方安全注意事項
- **Phase 10b** ✅：Android i18n + 每帳號 Room cache 隔離 + LLM profile owner guard migration
- **Phase 11** ✅：批次檔案攝取 + 全文搜尋 + AI 完整檔案操控 — 多檔上傳/拖曳、PostgreSQL tsvector 搜尋、模型選擇器、deletePage / movePage 工具（自動重寫 backlink）

## 安全注意事項（Phase 10）

**已修復的漏洞**：

| 嚴重度 | 位置 | 問題 | 修復方式 |
|--------|------|------|---------|
| P0 | `api/lint/route.ts` | admin client 查 `llm_profiles` 缺 `.eq('owner_id', userId)`，攻擊者可設 `lint_profile_id` 指向他人 profile 以使用他人 API key | 加入 `.eq('owner_id', userId)` |
| P0 | `WikiViewModel.kt` | `webApiUrl()` 用字串替換 Supabase URL 推導 Vercel URL，Supabase URL 格式改變時 bearer token 可送到錯誤 domain | 改用 `BuildConfig.WEB_API_BASE_URL` |
| P1 | `WikiViewModel.signOut()` | 登出後未清空 Room DB cache，未取消 WorkManager job | 加入 `db.pageDao().deleteAll()` + `SyncWorker.cancel()` |
| P1 | `apps/web/.env.example` | `ENCRYPTION_KEY` 說明寫 `openssl rand -hex 32`（hex），但程式碼用 `base64` 解碼，runtime 會爆 | 改為 `openssl rand -base64 32` |
| P1 | `supabase/migrations/0003_profile_ownership_guards.sql` | `workspaces.*_profile_id` 與 `ingest_jobs.profile_id` 原本只有一般 FK，未在 DB 層保證 profile owner 與 workspace owner 相同 | 加入 `(profile_id, owner_id)` composite FK 與 ingest job trigger guard |

**Android 設定注意**：
- `WEB_API_BASE_URL` 現在是必要 build config 欄位（來源：`local.properties` 或 `NEXT_PUBLIC_SITE_URL`）
- `GOOGLE_CLIENT_ID` 必須是 **Web OAuth client ID**，不是 Android client ID

## 目錄速查（Android）

```
apps/android/app/src/main/java/com/llmwiki/
├── MainActivity.kt           ← ACTION_SEND 分享意圖 → extractSharedUrl
├── ui/
│   ├── LlmWikiNavGraph.kt    ← auth → wiki 路由，傳遞 accountName + shareUrl
│   ├── auth/
│   │   ├── AuthViewModel.kt  ← CredentialManager + Supabase IDToken sign-in
│   │   │                        AuthState.Success 含 workspaceId + accountName
│   │   └── AuthScreen.kt
│   └── wiki/
│       ├── WikiScreen.kt     ← ModalNavigationDrawer + Scaffold + IngestUrlDialog
│       ├── WikiViewModel.kt  ← pages Flow（Room）+ syncPages + ingestUrl (Ktor)
│       │                        init() 後自動呼叫 SyncWorker.schedule()
│       └── MarkdownViewer.kt ← Markwon + AndroidView(TextView)
├── data/
│   ├── DriveClient.kt        ← GoogleAccountCredential + Drive SDK
│   ├── PageRepository.kt     ← syncPages（Supabase→Room）+ loadPageContent（Drive）
│   ├── Models.kt             ← WorkspaceRow, PageRow（@Serializable）
│   └── room/
│       ├── AppDatabase.kt
│       ├── PageDao.kt        ← observePages(workspace_id, account_name) Flow + upsertAll
│       └── PageEntity.kt     ← (workspace_id, account_name, slug) PK，確保每帳號 Room cache 隔離
└── sync/
    └── SyncWorker.kt         ← CoroutineWorker，schedule() 每小時 KEEP 策略

```

## Android 注意事項

- `AuthState.Success` 含 `accountName`（Google 帳號 email），NavGraph 透過 `rememberSaveable` 保留後傳給 WikiViewModel
- Android 現在有 `workspace-create` route；若登入後沒有任何 workspace，直接進建立工作區畫面，不再卡在空白 wiki
- Google Drive 重新授權 deep link 使用 `llmwiki://auth/reconnect?source=...`；`MainActivity` 會接回 App，`apps/web/app/auth/reconnect/page.tsx` 負責啟動 OAuth
- Android Supabase Auth 必須設定 `SettingsSessionManager()` + `SettingsCodeVerifierCache()`，否則 session 不會跨重啟保留，使用者每次都要重新登入
- `AppPreferencesRepository` 必須透過 `preferencesDataStore` 共用單一 DataStore；若在 `MainActivity` / `SettingsViewModel` 各自建立獨立 `PreferenceDataStoreFactory`，設定頁會因同檔案多實例而閃退
- Android 語言切換要讓 `MainActivity` 使用 `AppCompatActivity`，並在 `setContent` 前先套用已儲存 locale；`AppCompatDelegate.setApplicationLocales()` 也要先比較 `toLanguageTags()`，避免每次啟動都重建 Activity 導致閃黑
- Android 打 Web API 時不可直接信任舊的 `currentSessionOrNull()?.accessToken`；需先經 `requireAccessToken()`，若目前 token 為空但 session 仍存在也要先 refresh，再在 401 時用 `forceRefresh=true` 重試一次，否則設定頁與模型/設定檔同步容易出現 `Unauthorized`
- Android 呼叫 Web API / Supabase PostgREST 時應先用 `requireAccessToken(forceRefresh = false)` 取現有 token；只有 token 為空或收到 401 才以 `forceRefresh=true` 重試。`refreshCurrentSession()` 必須透過共用 mutex 序列化，避免多個初始化流程同時 refresh 導致 refresh token 競爭並出現「登入狀態已失效」。
- Android Web API 錯誤解析要處理純文字 `Unauthorized`；部分 route（例如 `/api/query` stream）不一定回 JSON，需轉為本地化錯誤訊息
- Android 對預期 JSON 的 Web API 回應不可只看 HTTP 2xx；Vercel 對未部署的 method/path 可能回 `200 text/html`，必須確認 body 是 JSON object 才能更新本機狀態
- Android 讀取 LLM profiles 使用 `LlmProfileRepository` 直接查 Supabase `llm_profiles`（RLS + `owner_id`），不要用 Web API Bearer token 做列表同步；Web API 保留給需要 server-side 加密的 create/delete
- `MainActivity` 不要在 `onCreate()` 用 `runBlocking` 等待 Supabase Auth 初始化；改由 `LlmWikiNavGraph` 的 launch route 非阻塞判定 session，避免啟動畫面卡住或黑屏
- Android `LlmWikiNavGraph` 先進 `launch` route，再非阻塞判定導向 `auth` / `wiki` / `workspace-create`，已登入使用者不必先看登入頁轉圈
- Android 登出與重新登入時，需同時清掉 `GoogleSignIn` 快取，否則再次登入不會跳出 Google 帳號選擇器
- Android Wiki drawer 已改為工作區下拉選單；「建立工作區」整合進下拉內，檔案匯入除了文字/URL 也支援從手機選取文字檔直接 ingest
- Android workspace 下拉選單需提供切換、新建、重新命名、刪除；刪除時清掉該 workspace 的 Room cache 並選下一個 workspace 或回建立頁
- Android workspace 下拉選單的切換區與 rename/delete action 區必須分離，且 action hit target 至少 44dp；否則容易誤觸成切換 workspace
- Android Chat 模型選擇用模型/聊天語意 icon（例如 `SmartToy`），不要用設定齒輪；頁面鎖定狀態需以 `Lock` / `LockOpen` 區分，因為鎖頭本身可點擊切換
- Android `MarkdownViewer` 用 Markwon + `TextView` 時必須在 Compose update 內同步 `MaterialTheme` 的文字與連結顏色，否則深色模式會出現黑底黑字
- Android FAB 要明確設定 `containerColor` / `contentColor`，不要依賴預設 primaryContainer；淺色模式容易出現不自然白色塊
- Web API 若要同時服務 Web cookie 與 Android Bearer token，route 需經 `lib/supabase/request.ts` 取 user，不能只靠 `lib/supabase/server.ts`
- `lib/supabase/request.ts` 驗證 Android Bearer token 時需用 admin client `auth.getUser(token)`，再回傳 bearer Supabase client 給 RLS 查詢；只用 anon/bearer client 驗證會造成有效 token 被判定 Unauthorized
- Workspace 管理需 Web / Android 對齊：`PATCH /api/workspaces/[id]` 更新名稱，`DELETE /api/workspaces/[id]` 刪除 workspace；刪除必須先成功 trash Google Drive folder 才能刪 DB，避免手機/Web/Drive 狀態不一致
- Android 端 workspace 刪除只有在 API 回 `{ ok: true }` 後才能清本機 Room / UI 狀態；不可 optimistic remove，否則 production route 漏部署時會出現手機消失但 Web/Drive 仍存在
- Android 共用 `AndroidHttpClient` 必須設定 Ktor timeout（connect 10s / socket 30s / request 60s），避免建立工作區或 API request 卡在 loading；timeout / DNS / connection abort 要轉成本地化網路錯誤
- Android 切換、新建或刪除後切到下一個 workspace 時，`syncPagesInternal()` 後需自動選中 `index.md`（fallback `log.md`），避免停在「從選單選擇一個頁面」
- Android 匯入本機文字檔要限制大小（與 Web 同級 2 MB）並以串流文字讀取，不可直接 `readBytes()` 全讀進記憶體，否則大檔容易卡頓
- Web 三欄拖曳改用 `requestAnimationFrame` 批次套用寬度，避免每個 `mousemove` 都直接觸發整棵 shell 重渲染
- 共用色票已從 soft violet 改為 teal-blue；若新增顏色請同步 `packages/ui/src/styles.css` 與 Android `ui/theme/Color.kt`
- `Icons.AutoMirrored.Filled.List` 取代舊版 `Icons.Default.Menu`（Compose Material 3 方向性圖示）
- `SyncWorker.schedule()` 使用 `ExistingPeriodicWorkPolicy.KEEP`（不重複排程同一個 workspace）
- `PageRepository.syncPages()` 不再限制 200 筆，且會刪除本機 Room 中伺服器已不存在的頁面，避免 Android 側欄殘留舊頁
- Android `refreshAfterForeground()` 回到前景時需同步目前 workspace，否則 Web 端剛匯入完成的 `index.md` / `log.md` 容易被本機舊快取蓋住，看起來像手機沒更新
- Android / Web 的內部 wiki 連結解析都要接受不帶副檔名的 slug（例如 `entities/foo`），並自動補成 `.md`，否則索引頁連結會顯示但不能跳
- `ingestUrl()` / `ingestText()` 呼叫 Web app 的 `/api/ingest`，使用 Supabase session accessToken
- Web API 端點位址由 `BuildConfig.WEB_API_BASE_URL` 決定（從 `local.properties` 的 `WEB_API_BASE_URL` 或 `NEXT_PUBLIC_SITE_URL` 注入）
- Chat 串流協定：POST `/api/query` → `text/plain` stream，結尾附 `\x00CITATIONS\x00[...]`；Android 用 Ktor `bodyAsChannel()` + `readUTF8Line()` 消費
- Lock toggle：PATCH `/api/pages/{wid}/{slug}` `{locked_by_human:bool}`，同步更新 Room cache（`PageDao.updateLock`）
- 登出後 NavController navigate("auth") popUpTo(0) inclusive=true
- 登出時 `WikiViewModel.signOut()` 會清空 Room DB（`PageDao.deleteAll()`）並取消 WorkManager job（`SyncWorker.cancel()`）
- `GOOGLE_CLIENT_ID` 必須使用 **Web OAuth client ID**（非 Android client ID），`requestIdToken()` 需要它來取得 ID token
- Web / Android 建立工作區 UI 不保留 description 欄位；Web `/w/create` 需提供返回 `/w` 的按鈕
- 使用說明入口需在 Web top bar 與 Android drawer 同步提供，說明內容涵蓋工作區、匯入、對話、設定同步與 Drive 重授權

## Graph View 注意事項

- `GraphView` (`components/wiki/graph-view.tsx`) 動態 import `react-force-graph-2d`（ESM + window）避免 SSR 問題
- 從 Supabase `page_links` 表讀邊，`pages` 表讀節點（需 `createClient` from `@/lib/supabase/client`）
- `page_links` 由 `writePage` 工具在每次寫頁面時自動同步（解析 `[[wikilink]]` → upsert）
- workspace-shell 頂列 `GitFork` 按鈕切換，點節點後自動跳回 PageViewer
- `FlaskConical` 按鈕觸發 POST `/api/lint`，完成後導航至當日 lint 報告頁（slug `_lint/YYYYMMDD.md`）

## Vercel Cron

`apps/web/vercel.json` 設定每週一 03:00 UTC 跑 GET `/api/lint/cron`。
需在 Vercel 環境變數設定 `CRON_SECRET`，與 `.env.local` 一致。

## Ingest 任意格式

`conversation-panel.tsx` 的 ingest 欄位為 textarea，自動偵測輸入：
- URL（`http://` / `https://`）→ `{ kind: 'url', url: ... }`
- 其他文字或 Markdown → `{ kind: 'text', title: 第一非空行, content: ... }`

API (`/api/ingest`) 已支援兩種 kind。Ctrl+Enter 快速提交。

## 側邊欄拖移

`workspace-shell.tsx` 用 `dragging` ref + `document.addEventListener` 實作：
- 左側面板：160~480px（預設 240）
- 右側面板：240~600px（預設 384）
- 拖移把手：4px 透明 div，hover 顯示 accent 色

## Drive Token 失效處理

`create-form.tsx` 偵測 `/api/workspaces` 回傳 403 + "Google Drive"：
- 顯示「Re-connect Google Drive」按鈕
- 觸發 `supabase.auth.signInWithOAuth` with `prompt: consent, access_type: offline`
- 重授權後 auth/callback 重新儲存 refresh token

## 模型選擇器

Conversation panel 輸入框左側有模型選擇按鈕（`Bot` icon），從 `/api/settings/profiles` 取得使用者自訂 LLM profile 列表：
- 預設選中 `is_default=true` 的 profile
- Query / Ingest API 支援可選 `profile_id` override，會檢查 `owner_id` 權限
- 若使用者未設定任何 profile，按鈕隱藏，API fallback 至 workspace 綁定的 default profile

## 批次檔案攝取

`conversation-panel.tsx` 支援多檔案上傳：
- `<input type="file" multiple>` 選擇多個 `.md` / `.txt` / `text/*` 檔案
- 拖曳檔案到 textarea 觸發批次上傳
- `uploadQueue` 狀態顯示每個檔案的進度（pending / uploading / done / error）
- 每個檔案獨立呼叫 `/api/ingest`（`kind: 'text'`），支援 `profile_id` 覆寫

## 筆記／規則

- 工作區建立與頁面列表讀取時，會自動補齊 `notes/guide.md` 與 `_schema/{ingest,query,lint}.md` 的 metadata，避免「筆記／規則」看起來是空白壞掉
- 設定頁若發現 `schema` zone 缺少系統規則頁，會先做 DB count pre-check，再呼叫 `ensureWorkspaceSystemPages()` 補齊後重新查詢，避免規則區空白
- `notes/guide.md`、`_schema/*.md` 會依目前 UI 語系自動本地化預設內容；內容變更時需同步 bump `version`，讓 Android Room cache 重新載入
- Web 與 Android 現在都可新增、重新命名、刪除 `notes/*.md` 頁面，且筆記／規則頁都用內建 Markdown 工具列編輯；LLM 仍只讀 `notes/`、不會主動改寫
- `_schema/*.md` 入口搬到設定頁，仍顯示為「匯入規則 / 查詢規則 / 健康檢查規則」；不要再把規則當成一般 Wiki 側欄區塊
- Web `PageViewer` 與 Android `MarkdownViewer` 都會把 wiki 內部連結留在同一個 App / 視窗內跳轉，不再強制另開新視窗
- Android 頁面內容讀取優先走 Web `/api/pages/{workspaceId}/{slug}`，避免手機端 Google Drive `drive.file` scope 與 Web 匯入檔案歸屬不同造成空內容
- `/api/pages/[workspaceId]/[...slug]` 的 GET 現在固定回 JSON；成功時 `content` 必須是字串，失敗時回 `{ error: { code, message, requestId, ...publicMeta } }`，不可把 Drive 內部 metadata 洩漏給 client
- `readDriveFile()` 會先查 Drive metadata 再依 MIME type 分流：`text/markdown` / `text/plain` 直接讀、Google Docs 走 export、`application/octet-stream` 先過 binary guard；讀不到就 throw `DriveReadError`，不可 silent fallback 成空字串
- Web `PageViewer` 若收到 `DRIVE_RECONNECT_REQUIRED`，必須顯示可直接觸發 OAuth 重授權的按鈕；不能只顯示錯誤文字讓使用者自己猜

## 工作區排序

- `workspaces.sort_order`（migration `0005_workspace_sort_order.sql`）提供持久化自訂排序
- Web 工作區選單支援 drag-and-drop 排序，經 `/api/workspaces/reorder`
- Android 工作區選單支援上移 / 下移，走同一套排序 API，同步 Web / 手機順序
- Web 端任何首頁導頁、登入回跳或工作區列表查詢，若遇到 production 尚未套用 `sort_order` / schema cache 未刷新，必須 fallback 至 `created_at`，不可誤顯示「建立工作區」

## 全文搜尋

**資料庫層**：`pages.search_text TEXT` + `pages_fts_idx` GIN index（`to_tsvector('simple', ...)`）

**API**：`GET /api/search?workspace_id=xxx&q=keyword`
- 優先嘗試 `search_pages` RPC；若函數不存在（migration 尚未執行），graceful fallback 至 `ilike` 基礎搜尋

**UI**：`workspace-shell.tsx` 頂部 `Search` 按鈕
- 點擊展開下拉搜尋框（`showSearch` state）
- 輸入 2 字元以上自動 debounce（200ms）搜尋
- 結果顯示 title / kind / slug，點擊跳轉至該頁面

## AI 完整檔案操控

`lib/ai/tools.ts` 現有 6 個工具：

| 工具 | 說明 |
|------|------|
| `readPage` | 讀取頁面內容（Drive file） |
| `writePage` | 建立/覆寫頁面，自動同步 `page_links` 與 `search_text` |
| `searchPages` | 基礎 `ilike` 搜尋 title + slug |
| `listPages` | 列出所有 wiki 頁面，可選 kind 篩選 |
| `deletePage` | 刪除頁面：清理 `page_links`、刪除 Drive file、刪除 DB record |
| `movePage` | 重命名/移動頁面：自動重寫所有**引用該頁面**的 `[[wikilink]]`，更新 `page_links` slug |

## 資料庫 Migration

`supabase/migrations/0004_fulltext_search.sql`：
- `ALTER TABLE pages ADD COLUMN search_text TEXT`
- `CREATE INDEX pages_fts_idx USING GIN (...)`
- `CREATE OR REPLACE FUNCTION search_pages(p_workspace_id UUID, p_query TEXT)`

### Data API GRANT 規範（參考全域 CLAUDE.md Supabase 資料庫規範）

本專案已統一透過 migration `0011_data_api_grants.sql` 為所有表補上 Data API GRANT，並設置 `ALTER DEFAULT PRIVILEGES` 預防未來疏漏。往後新增表或 function 時請同步補上 GRANT，否則 PostgREST 會回 `42501`。

## 其他注意事項

- **Markdown 渲染**：`page-viewer.tsx` 用 `react-markdown` + `remark-gfm`。YAML frontmatter 以 `stripFrontmatterAndWikilinks()` 手動 strip（不用 `remark-frontmatter`，那個不自動隱藏內容）。`[[slug]]` 轉成 `[slug](wiki://slug)` 供自訂 `<a>` renderer 攔截。
- **`.env.vercel.tmp`**：`vercel env pull` 輸出的暫存檔，已加入 `.gitignore`，不應提交。
- Lucide v3 已移除 icon 的 `title` prop，改用 `aria-label`
- `packages/prompts` 的 `.md` import 需要 `markdown.d.ts` 宣告 + next.config webpack `asset/source` loader
- TypeScript target 需 ES2023（`Array.prototype.findLast`）
- Google Drive scope 用 `drive.file`（只看到 App 建立的檔案）
- i18n 採 cookie-based（`NEXT_LOCALE`），支援 `zh-TW`（預設）和 `en`
