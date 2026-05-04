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
│   ├── conversation-panel.tsx  ← 含 citation chips + file-back 通知 + 模型選擇器 + 批次上傳佇列
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
- `Icons.AutoMirrored.Filled.List` 取代舊版 `Icons.Default.Menu`（Compose Material 3 方向性圖示）
- `SyncWorker.schedule()` 使用 `ExistingPeriodicWorkPolicy.KEEP`（不重複排程同一個 workspace）
- `ingestUrl()` / `ingestText()` 呼叫 Web app 的 `/api/ingest`，使用 Supabase session accessToken
- Web API 端點位址由 `BuildConfig.WEB_API_BASE_URL` 決定（從 `local.properties` 的 `WEB_API_BASE_URL` 或 `NEXT_PUBLIC_SITE_URL` 注入）
- Chat 串流協定：POST `/api/query` → `text/plain` stream，結尾附 `\x00CITATIONS\x00[...]`；Android 用 Ktor `bodyAsChannel()` + `readUTF8Line()` 消費
- Lock toggle：PATCH `/api/pages/{wid}/{slug}` `{locked_by_human:bool}`，同步更新 Room cache（`PageDao.updateLock`）
- 登出後 NavController navigate("auth") popUpTo(0) inclusive=true
- 登出時 `WikiViewModel.signOut()` 會清空 Room DB（`PageDao.deleteAll()`）並取消 WorkManager job（`SyncWorker.cancel()`）
- `GOOGLE_CLIENT_ID` 必須使用 **Web OAuth client ID**（非 Android client ID），`requestIdToken()` 需要它來取得 ID token

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

若本地無法連接 PostgreSQL port，可透過臨時部署的 `/api/migrate` endpoint（已於部署後移除）執行。

## 其他注意事項

- **Markdown 渲染**：`page-viewer.tsx` 用 `react-markdown` + `remark-gfm`。YAML frontmatter 以 `stripFrontmatterAndWikilinks()` 手動 strip（不用 `remark-frontmatter`，那個不自動隱藏內容）。`[[slug]]` 轉成 `[slug](wiki://slug)` 供自訂 `<a>` renderer 攔截。
- **`.env.vercel.tmp`**：`vercel env pull` 輸出的暫存檔，已加入 `.gitignore`，不應提交。
- Lucide v3 已移除 icon 的 `title` prop，改用 `aria-label`
- `packages/prompts` 的 `.md` import 需要 `markdown.d.ts` 宣告 + next.config webpack `asset/source` loader
- TypeScript target 需 ES2023（`Array.prototype.findLast`）
- Google Drive scope 用 `drive.file`（只看到 App 建立的檔案）
- i18n 採 cookie-based（`NEXT_LOCALE`），支援 `zh-TW`（預設）和 `en`
