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
│   │   ├── ingest/     LLM ingest pipeline（支援 kind: url/text）
│   │   ├── query/      LLM query（streaming，支援 profile_id override）
│   │   ├── lint/       週期健康檢查
│   │   └── workspaces/ CRUD + synthesis
│   └── settings/       LLM profile 管理
├── components/
│   ├── wiki/
│   │   ├── conversation-panel.tsx  ← 聊天 + 模型選擇器 + 批次上傳佇列 + citations
│   │   ├── page-viewer.tsx         ← staleness banner + lock toggle + ReactMarkdown（GFM、frontmatter strip、[[wikilink]] 路由）
│   │   ├── page-tree.tsx           ← 左側導航樹
│   │   └── graph-view.tsx          ← react-force-graph-2d（動態 import）
│   └── workspace/
│       ├── create-form.tsx         ← 新建 workspace + Drive re-auth
│       └── workspace-card.tsx
└── lib/
    ├── ai/
    │   ├── tools.ts          ← 6 個 AI 工具（read/write/search/list/delete/move）
    │   ├── client.ts         ← LLM client factory
    │   └── citation-parser.ts
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
5. **分離原則**：`wiki/`（LLM 寫）、`notes/`（使用者寫，LLM 唯讀）物理分離
6. **Schema 共同演化**：`_schema/ingest.md` 等可由使用者修改
7. **Conversation + Live Wiki**：右欄對話，左中欄 wiki 即時更新

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

## 環境變數（.env.local）

```
NEXT_PUBLIC_SUPABASE_URL=
NEXT_PUBLIC_SUPABASE_ANON_KEY=
SUPABASE_SERVICE_ROLE_KEY=
NEXT_PUBLIC_SITE_URL=       # 生產 URL，用於 OAuth callback 與 Android WEB_API_BASE_URL
ENCRYPTION_KEY=             # base64 32 bytes（openssl rand -base64 32）
GOOGLE_OAUTH_CLIENT_ID=
GOOGLE_OAUTH_CLIENT_SECRET=
CRON_SECRET=                # /api/lint/cron 保護
```

## 進度狀態

- **Phase 0-10b** ✅：MVP、Android、Graph、i18n、安全性強化、Room cache 隔離
- **Phase 11** ✅：批次檔案攝取 + 全文搜尋 + AI 完整檔案操控（deletePage / movePage + backlink rewriting）
- **Production 2026-04-29** ✅：`0004_fulltext_search.sql` 已套用至 Supabase production；臨時 `/api/migrate` route 已移除。

## 關鍵功能

### 模型選擇器
- `conversation-panel.tsx` 輸入框左側 `Bot` 按鈕
- 從 `/api/settings/profiles` 取得 profile 列表，預設選中 `is_default=true`
- Query/Ingest API 支援 `profile_id` override，檢查 `owner_id` 權限

### 批次檔案攝取
- `<input type="file" multiple>` + 拖曳到 textarea
- `uploadQueue` 顯示每檔進度（pending/uploading/done/error）
- 每檔獨立 POST `/api/ingest`（`kind: 'text'`），支援 `profile_id`

### 全文搜尋
- **DB**：`pages.search_text TEXT` + `pages_fts_idx` GIN index + `search_pages` RPC
- **API**：`GET /api/search?workspace_id=xxx&q=keyword`（RPC → ilike graceful fallback）
- **UI**：`workspace-shell.tsx` 頂部 `Search` 按鈕，debounce 200ms

### AI 工具（`lib/ai/tools.ts`）

| 工具 | 說明 |
|------|------|
| `readPage` | 讀取 Drive file 內容 |
| `writePage` | 建立/覆寫，自動同步 `page_links` + `search_text` |
| `searchPages` | `ilike` 搜尋 title + slug |
| `listPages` | 列出 wiki 頁面，可選 kind 篩選 |
| `deletePage` | 清理 `page_links`、刪除 Drive file、刪除 DB record |
| `movePage` | 重命名/移動，自動重寫所有 incoming `[[wikilink]]` |

### Citation 串流協定
Query API 文字串流結尾附加 `\x00CITATIONS\x00["entities/karpathy.md",...]`，前端 `citation-parser.ts` 解析。

### Drive Token 失效處理
`create-form.tsx` 偵測 403 + "Google Drive" → 顯示「Re-connect Google Drive」按鈕 → `signInWithOAuth({ prompt: 'consent', access_type: 'offline' })` → auth/callback 重新儲存 refresh token。

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
- Chat 串流：POST `/api/query` → `text/plain` stream → Ktor `bodyAsChannel()` + `readUTF8Line()`
- 登出：`PageDao.deleteAll()` + `SyncWorker.cancel()` + `navigate("auth") popUpTo(0) inclusive=true`
- `Icons.AutoMirrored.Filled.List` 取代舊版 `Icons.Default.Menu`

## 功能開發原則

**Web 與 Android 功能必須同步**：實作任何使用者可見功能時，需檢查 Web 與 Android 是否都需要對齊；若只適用單一平台，需明確說明。Android 呼叫與 Web 相同的後端 API，無需另建端點。

## 其他

- **Markdown 渲染**：`page-viewer.tsx` 用 `react-markdown` + `remark-gfm`。YAML frontmatter 以 `stripFrontmatterAndWikilinks()` 手動 strip（不用 `remark-frontmatter`，那個不自動隱藏內容）。`[[slug]]` 轉成 `[slug](wiki://slug)` 供自訂 `<a>` renderer 攔截。
- **`.env.vercel.tmp`**：`vercel env pull` 輸出的暫存檔，已加入 `.gitignore`，不應提交。
- Lucide v3 已移除 icon 的 `title` prop，改用 `aria-label`
- `packages/prompts` 的 `.md` import 需要 `markdown.d.ts` + webpack `asset/source` loader
- TypeScript target 需 ES2023（`Array.prototype.findLast`）
- Google Drive scope 用 `drive.file`
- i18n cookie-based（`NEXT_LOCALE`），`zh-TW`（預設）和 `en`
- GraphView 動態 import `react-force-graph-2d` 避免 SSR 問題
- Vercel Cron：每週一 03:00 UTC `GET /api/lint/cron`
- Supabase DB migration 若本機 5432/6543 被擋，可從 Vercel/serverless 走 pooler：`aws-1-ap-southeast-1.pooler.supabase.com:6543`，user 格式 `postgres.<project-ref>`
