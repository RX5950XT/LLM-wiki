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
ENCRYPTION_KEY=          # 32-byte hex，用於 AES-256-GCM 加密 API key
GOOGLE_OAUTH_CLIENT_ID=
GOOGLE_OAUTH_CLIENT_SECRET=
```

## 目錄速查（補充）

```
apps/web/
├── app/api/
│   ├── workspaces/[id]/synthesis/  ← POST: 儲存 Q&A 為 synthesis page
│   └── pages/[wid]/[...slug]/lock/ ← PATCH: 切換 locked_by_human
├── components/wiki/
│   ├── conversation-panel.tsx  ← 含 citation chips + file-back 通知
│   └── page-viewer.tsx         ← 含 staleness banner + lock toggle
└── lib/ai/
    └── citation-parser.ts      ← 解析串流尾端的 \x00CITATIONS\x00 block
```

## Citation 串流協定

Query API 在文字串流結尾附加：
```
\x00CITATIONS\x00["entities/karpathy.md","concepts/rag.md"]
```
前端用 `citation-parser.ts` 的 `parseCitations(raw)` 解析，分離 text 和 citedSlugs。

## 進度狀態

- **Phase 0** ✅：Monorepo + Next.js 16 + Android 骨架 + Supabase schema
- **Phase 1** ✅：Web MVP — Google OAuth + Drive 初始化 + Source ingest + Wiki 瀏覽 + Realtime 同步
- **Phase 2** ✅：Query file-back + Citation chips + Version staleness banner + Lock/unlock toggle
- **Phase 3** ✅：Android（Kotlin + Compose）— Google Sign-In + Room 離線快取 + Markwon viewer + 分享意圖 + WorkManager 背景同步
- **Phase 4** ✅：Lint + Graph view + 開源準備 — GraphView (react-force-graph-2d), Lint trigger button, README quick-start
- **Phase 5** ✅：Graph edge fix + 開源收尾 — page_links 寫入、.env.example、vercel.json cron、CONTRIBUTING.md

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
│       ├── PageDao.kt        ← observePages Flow + upsertAll
│       └── PageEntity.kt     ← (workspace_id, slug) PK
└── sync/
    └── SyncWorker.kt         ← CoroutineWorker，schedule() 每小時 KEEP 策略

```

## Android 注意事項

- `AuthState.Success` 含 `accountName`（Google 帳號 email），NavGraph 透過 `rememberSaveable` 保留後傳給 WikiViewModel
- `Icons.AutoMirrored.Filled.List` 取代舊版 `Icons.Default.Menu`（Compose Material 3 方向性圖示）
- `SyncWorker.schedule()` 使用 `ExistingPeriodicWorkPolicy.KEEP`（不重複排程同一個 workspace）
- `ingestUrl()` 呼叫 Web app 的 `/api/ingest`，使用 Supabase session accessToken

## Graph View 注意事項

- `GraphView` (`components/wiki/graph-view.tsx`) 動態 import `react-force-graph-2d`（ESM + window）避免 SSR 問題
- 從 Supabase `page_links` 表讀邊，`pages` 表讀節點（需 `createClient` from `@/lib/supabase/client`）
- `page_links` 由 `writePage` 工具在每次寫頁面時自動同步（解析 `[[wikilink]]` → upsert）
- workspace-shell 頂列 `GitFork` 按鈕切換，點節點後自動跳回 PageViewer
- `FlaskConical` 按鈕觸發 POST `/api/lint`，完成後導航至當日 lint 報告頁（slug `_lint/YYYYMMDD.md`）

## Vercel Cron

`apps/web/vercel.json` 設定每週一 03:00 UTC 跑 GET `/api/lint/cron`。
需在 Vercel 環境變數設定 `CRON_SECRET`，與 `.env.local` 一致。

## 其他注意事項

- Lucide v3 已移除 icon 的 `title` prop，改用 `aria-label`
- `packages/prompts` 的 `.md` import 需要 `markdown.d.ts` 宣告 + next.config webpack `asset/source` loader
- TypeScript target 需 ES2023（`Array.prototype.findLast`）
- Google Drive scope 用 `drive.file`（只看到 App 建立的檔案）
