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
- Android 現在有 `workspace-create` route；登入後若沒有 workspace，直接進建立工作區畫面
- Google Drive 重新授權 deep link 使用 `llmwiki://auth/reconnect?source=...`；`apps/web/app/auth/reconnect/page.tsx` 為 Android 啟動 OAuth 的橋接頁
- Android Supabase Auth 必須設定 `SettingsSessionManager()` + `SettingsCodeVerifierCache()`，否則 session 不會跨 App 重啟保留
- `AppPreferencesRepository` 必須共用同一個 `preferencesDataStore`；不要在 Activity 與 ViewModel 各自用 `PreferenceDataStoreFactory.create()` 開同一個檔案，否則設定頁會直接閃退
- Android 語言切換需由 `AppCompatActivity` 在 `setContent` 前先套用已儲存 locale，且只在 `toLanguageTags()` 真正變動時呼叫 `AppCompatDelegate.setApplicationLocales()`，否則會造成切換失效或啟動閃黑
- Android 呼叫 Web API 時要先用 `requireAccessToken()` 取 token；若目前 token 為空但 session 仍在，要先 refresh，再於 401 時再 refresh 重試一次，直接拿舊 access token 容易讓設定頁與 LLM profiles 同步失敗
- Android 呼叫 Web API 前應使用 `requireAccessToken(forceRefresh = true)`，直接 Supabase PostgREST 查詢（例如 pages/workspaces）也要先 refresh session，避免首頁偶發「登入狀態已失效」紅字
- Android Web API 錯誤解析要處理純文字 `Unauthorized`；部分 route（例如 `/api/query` stream）不一定回 JSON，需轉為本地化錯誤訊息
- Android 對預期 JSON 的 Web API 回應不可只看 HTTP 2xx；Vercel 對未部署的 method/path 可能回 `200 text/html`，必須確認 body 是 JSON object 才能更新本機狀態
- Android 讀取 LLM profiles 使用 `LlmProfileRepository` 直接查 Supabase `llm_profiles`（RLS + `owner_id`），不要用 Web API Bearer token 做列表同步；Web API 保留給需要 server-side 加密的 create/delete
- `MainActivity` 不要在 `onCreate()` 用 `runBlocking` 等待 Supabase Auth 初始化；改由 `LlmWikiNavGraph` 的 launch route 非阻塞判定 session，避免啟動卡頓或黑屏
- Android `LlmWikiNavGraph` 先進 `launch` route，再非阻塞導向 `auth` / `wiki` / `workspace-create`；已登入使用者不必先經登入頁轉圈
- Android 登出時要同步清除 `GoogleSignIn` 快取，否則下次登入不會再出現 Google 帳號選擇器
- Android Wiki drawer 使用工作區下拉選單；建立工作區整合在下拉內，並支援從手機附加文字檔直接 ingest
- Android workspace 下拉選單需提供切換、新建、重新命名、刪除；刪除時清掉該 workspace 的 Room cache 並選下一個 workspace 或回建立頁
- Android Chat 模型選擇用模型/聊天語意 icon（例如 `SmartToy`），不要用設定齒輪；頁面鎖定狀態需以 `Lock` / `LockOpen` 區分，因為鎖頭本身可點擊切換
- Android `MarkdownViewer` 用 Markwon + `TextView` 時必須在 Compose update 內同步 `MaterialTheme` 的文字與連結顏色，否則深色模式會出現黑底黑字
- Android FAB 要明確設定 `containerColor` / `contentColor`，不要依賴預設 primaryContainer；淺色模式容易出現不自然白色塊
- Web API 若要服務 Android，需支援 `Authorization: Bearer <token>`；不要只依賴 cookie session
- `lib/supabase/request.ts` 驗證 Android Bearer token 時需用 admin client `auth.getUser(token)`，再回傳 bearer Supabase client 給 RLS 查詢；只用 anon/bearer client 驗證會造成有效 token 被判定 Unauthorized
- Workspace 管理需 Web / Android 對齊：`PATCH /api/workspaces/[id]` 更新名稱，`DELETE /api/workspaces/[id]` 刪除 workspace；刪除必須先成功 trash Google Drive folder 才能刪 DB，避免狀態不一致
- Android 端 workspace 刪除只有在 API 回 `{ ok: true }` 後才能清本機 Room / UI 狀態；不可 optimistic remove，否則 production route 漏部署時會出現手機消失但 Web/Drive 仍存在
- Android 共用 `AndroidHttpClient` 必須設定 Ktor timeout（connect 10s / socket 30s / request 60s），避免 API request 無限 loading；timeout / DNS / connection abort 要轉成本地化網路錯誤
- Android 切換、新建或刪除後切到下一個 workspace 時，`syncPagesInternal()` 後需自動選中 `index.md`（fallback `log.md`），避免停在「從選單選擇一個頁面」
- Android 匯入本機文字檔要限制大小（2 MB）並以串流文字讀取，不可直接 `readBytes()` 全讀進記憶體
- Web 三欄拖曳改用 `requestAnimationFrame` 批次更新寬度，避免拖動卡頓
- 共用色票已改為 teal-blue；若新增顏色請同步 `packages/ui/src/styles.css` 與 Android `ui/theme/Color.kt`
- Chat 串流：POST `/api/query` → `text/plain` stream → Ktor `bodyAsChannel()` + `readUTF8Line()`
- 登出：`PageDao.deleteAll()` + `SyncWorker.cancel()` + `navigate("auth") popUpTo(0) inclusive=true`
- `Icons.AutoMirrored.Filled.List` 取代舊版 `Icons.Default.Menu`
- `PageRepository.syncPages()` 不再限制 200 筆，且會刪除本機已過期頁面，避免手機端顯示舊資料
- Web / Android 建立工作區 UI 不保留 description 欄位；Web `/w/create` 需提供返回 `/w` 的按鈕
- 使用說明入口需在 Web top bar 與 Android drawer 同步提供，說明內容涵蓋工作區、匯入、對話、設定同步與 Drive 重授權

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


<claude-mem-context>
# Memory Context

# [LLM-wiki] recent context, 2026-05-06 8:36am GMT+8

Legend: 🎯session 🔴bugfix 🟣feature 🔄refactor ✅change 🔵discovery ⚖️decision 🚨security_alert 🔐security_note
Format: ID TIME TYPE TITLE
Fetch details: get_observations([IDs]) | Search: mem-search skill

Stats: 50 obs (9,903t read) | 924,076t work | 99% savings

### Apr 28, 2026
S27 Google Drive 重連按鈕仍無效（第二輪修復）：深入調查環境變數與 token 儲存靜默失敗問題 (Apr 28, 7:49 PM)
S29 修復 LLM-wiki 兩個 UI Bug：Google Drive 重連按鈕無效 + 新建 LLM 設定檔按鈕卡在載入狀態 (Apr 28, 7:49 PM)
S30 修復 Google Drive 重連失敗與新建 LLM 設定檔卡住問題，並處理本機開發缺少 SUPABASE_SERVICE_ROLE_KEY 的設定 (Apr 28, 8:28 PM)
### Apr 29, 2026
S31 修復本機開發環境缺少 SUPABASE_SERVICE_ROLE_KEY，排除 Google Drive reconnect 失敗與 LLM 設定檔建立卡住的共同後端阻塞。 (Apr 29, 4:48 AM)
S32 補齊本機開發缺少的 SUPABASE_SERVICE_ROLE_KEY，解除 Google Drive reconnect 與 LLM 設定檔建立流程的後端阻塞，並準備進入重啟與驗證階段。 (Apr 29, 4:50 AM)
S33 Fix Google Drive OAuth redirect loop in workspace creation and chat flows; remove redundant manual reconnect button (Apr 29, 4:57 AM)
### May 3, 2026
S34 Debug `invalid_client` Google OAuth error after redirect loop fix — GCP OAuth client credentials mismatch (May 3, 5:11 PM)
S35 繼續 LLM-wiki 開發 — 升級 PageViewer 支援 Markdown 渲染並恢復 Realtime 監聽 (May 3, 5:12 PM)
### May 4, 2026
569 7:06p 🔵 主 session 瀏覽器分頁全景：跨 Supabase、GCP、Vercel 多服務同步工作
570 7:07p 🔵 生產環境截圖確認新部署已生效（pre 標籤渲染）
571 7:09p 🔵 workspace-shell.tsx 確認 useRealtimePages 位置與 settings 預取
### May 5, 2026
572 12:42a 🔵 PageViewer component renders wiki content as plain text, not parsed Markdown
573 " 🔵 WorkspaceShell is a three-panel layout with Realtime temporarily disabled
574 " 🔵 react-markdown installed but not used — PageViewer renders plain text instead
575 12:43a 🟣 PageViewer upgraded from plain-text pre tag to ReactMarkdown with GFM and wiki:// link routing
576 " 🟣 stripFrontmatterAndWikilinks function added to PageViewer — YAML frontmatter stripped and [[wikilinks]] converted to wiki:// URLs
577 " 🔴 Supabase Realtime subscription re-enabled in WorkspaceShell
578 " ✅ TypeScript typecheck passes after PageViewer Markdown upgrade and Realtime re-enable
579 12:45a ✅ LLM-wiki Markdown rendering feature deployed to Vercel production
S36 修復 .env.vercel.tmp 未排除問題、更新文件、從工作紀錄萃取可複用 Skills (May 5, 12:45 AM)
580 1:39a 🔵 .env.vercel.tmp 應排除於版本控制
581 " ✅ 審查工作紀錄以建立可複用 Skills
582 " 🔵 LLM-wiki .gitignore 缺少 .env.vercel.tmp 排除規則
583 " 🔴 補充 .env.vercel.tmp 至 .gitignore
584 " 🟣 建立兩個新 Claude Code Skills 資料夾
585 1:40a 🟣 建立 google-oauth-supabase-debug Skill
586 " 🟣 建立 react-markdown-wiki Skill
587 " 🔵 LLM-wiki 專案架構與 Citation 串流協定
588 1:41a ✅ 更新 CLAUDE.md 記錄 Markdown 渲染與 .env.vercel.tmp 規範
589 1:43a 🔵 Skills 系統存在兩個目錄：~/.claude/skills/ 與 ~/.agents/skills/
590 1:44a ✅ 新 Skills 複製至 ~/.agents/skills/ 並同步更新 AGENTS.md
S37 修復 .env.vercel.tmp gitignore、更新文件、從工作紀錄萃取 Skills 並同步至正確目錄 (May 5, 1:44 AM)
### May 6, 2026
591 2:40a 🔵 LLM-wiki Android App 現有檔案結構盤點
592 " 🔵 CLAUDE.md 確認 Android App 落後網頁版至少 Phase 11 功能
593 " 🔵 AuthViewModel 使用舊版 GoogleSignIn API 而非 CredentialManager
594 2:41a 🔵 Android WikiViewModel 缺少模型選擇器與搜尋功能，strings.xml 有設定頁字串但無對應畫面
595 " 🔵 Explore Agent 完成 Android App 功能完整稽核報告
596 2:42a 🔵 繁體中文字串資源嚴重不完整，English strings.xml 有 42 條，zh-rTW 僅有 16 條
597 2:43a 🔵 GET /api/settings/profiles 回傳格式確認，Android 需呼叫此端點取得模型列表
598 " 🔵 GET /api/search 端點契約確認，Android 搜尋功能需呼叫此端點
599 2:47a 🟣 新增 LlmProfile 和 SearchResult 資料類別至 Models.kt
600 2:48a 🟣 WikiViewModel 大規模擴充：新增搜尋、模型選擇器、多工作區切換功能
601 " 🔵 WikiViewModel.kt 包含 literal null bytes 導致 grep 誤判為 binary file
602 " 🟣 WikiScreen 重大功能升級：搜尋、工作區切換、LLM Profile 選擇器
603 " 🟣 新增 Settings 畫面（SettingsScreen + SettingsViewModel）
604 " 🟣 NavGraph 新增 Settings 路由並串接 onNavigateToSettings
605 " ✅ strings.xml（EN + zh-rTW）大幅擴充新功能字串
606 " 🔵 Android 專案缺少 gradlew / gradlew.bat — gradle-wrapper.jar 從 GitHub raw 下載補齊
607 2:59a 🔴 WikiScreen 修正 SwapHoriz 未使用 import 並將工作區切換按鈕改為 TextButton
608 6:51a 🔵 Android App 功能完整稽核報告
609 " 🔵 後端 API 契約確認：搜尋與 LLM Profile 端點
610 " 🟣 新增 LlmProfile 與 SearchResult 資料類別
611 " 🟣 WikiViewModel 大規模擴充：搜尋、模型選擇器、多工作區切換
612 " 🟣 WikiScreen 重大 UI 升級：搜尋、工作區切換、LLM Profile 選擇器
613 " 🟣 新增 Settings 畫面（SettingsScreen + SettingsViewModel）
614 " ✅ strings.xml 大幅擴充新功能字串（EN + zh-rTW）
615 " 🔴 補齊缺失的 gradlew / gradlew.bat 執行腳本
617 7:34a 🔵 工作區功能缺陷與 UI 問題清單確認
616 " 🔵 Claude 的瀏覽器為無頭瀏覽器，使用者不可見
618 7:36a 🔵 Android app still hitting HTML 404 for workspace API routes post-deploy

Access 924k tokens of past work via get_observations([IDs]) or mem-search skill.
</claude-mem-context>
