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
│   ├── agent/execute/              ← POST: 執行使用者確認過的破壞性動作（delete_page / delete_workspace）
│   ├── organize/                   ← POST/GET: 唯一的維護 job（健康檢查＋跨工作區整理去重，agent_jobs）
│   ├── workspaces/[id]/synthesis/  ← POST: 儲存 Q&A 為 synthesis page
│   └── pages/[wid]/[...slug]/lock/ ← PATCH: 切換 locked_by_human
├── components/wiki/
│   ├── conversation-panel.tsx  ← 對話中心（citation chips、確認卡片、@ 工作區標記、Bot 多功能選單）
│   ├── import-dialog.tsx       ← 統一導入入口（貼上／拖曳／檔案 + 自動判斷工作區）
│   └── page-viewer.tsx         ← 含 staleness banner + lock toggle + ReactMarkdown（GFM、frontmatter strip、[[wikilink]] 路由）
├── lib/workspaces/manage.ts    ← create/rename/delete workspace 共用函式（REST route 與 AI 工具共用）
└── lib/ai/
    ├── tools.ts                ← AI wiki 工具（跨工作區；read/write/search/list/delete/move + workspace 管理）
    ├── organize-pipeline.ts    ← 維護 pipeline（健康檢查＋去重＋重新分類＋工作區調整，不寫報告）
    └── citation-parser.ts      ← 解析串流尾端的 \x00NAME\x00 metadata blocks
```

## 串流 metadata 協定（Citations + Actions）

Query API 在文字串流結尾依序附加 NUL 分隔的 metadata block：
```
\x00CITATIONS\x00["entities/karpathy.md","concepts/rag.md"]
\x00ACTIONS\x00[{"action":"delete_page","params":{"workspace_id":"…","slug":"…"},"label":"…"}]
```
- `CITATIONS`：LLM 讀過的頁面 slug（file-back / citation chips 用）
- `ACTIONS`：需使用者確認的破壞性動作 proposal（見「AI 破壞性操作確認」）
- 前端用 `citation-parser.ts` 的 `parseCitations(raw)` 解析（Android：`WikiViewModel.parseStreamMeta`）。
- **解析器必須忽略未知 block 名稱**，新增 block 才不會打壞舊 client。
- 串流中顯示文字時，一律截到第一個 `\x00` 為止，避免 metadata 閃現。

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
- **Phase 12** ✅：全專案健檢 — 非同步 ingest（jobId + 輪詢，解決手機匯入逾時）、SSRF/cron P0-P2 安全修復、tools 層 lock/zone 硬性防護、Web/Android UX 大修（RWD、a11y、鍵盤、錯誤可見性、瀏覽器返回、backlinks 面板、rememberSaveable、BackHandler、DayNight 主題）
- **Phase 13** ✅：漏洞續掃 + 功能補完 + Web/Android 對齊 — `extra_headers` AES-256-GCM 加密（migration 0013）、SSRF TOCTOU 關窗（undici pinned-DNS lookup）、broadcast trigger revoke（0014）、Sources 管理列表（Web + Android）、Ingest 即時進度（touched_pages 逐步回報）、Android backlinks 面板、離線冷啟 workspace 持久化（DataStore）、chat 草稿 hoist 至 ViewModel
- **Phase 14** ✅：對話中心化 + 跨工作區 AI — 移除筆記 UI（資料保留）、跨工作區 AI 工具（建立/改名/刪除工作區、跨工作區搬頁）、破壞性操作確認卡片（`\x00ACTIONS\x00` 協定 + `/api/agent/execute`）、對話預設帶當前頁 context + `@` 工作區標記、統一導入入口（ImportDialog，AI 自動判斷目標工作區）、自動分類＋去重複 job（`/api/organize` + `agent_jobs` migration 0015）、LLM profile 編輯（PATCH）、切換工作區/設定頁效能修復（Drive 呼叫移出請求路徑）、工作區拖曳 FLIP 動畫、Graph Obsidian 化（degree sizing / canvas 標籤 / hover 高亮 / 孤兒淡化）
- **Phase 16** ✅：維護合一 + AI 真權限 — 健康檢查與整理去重合併成單一按鈕／單一 pipeline（`/api/organize`），不再產生報告頁；維護 job 改 `confirmDestructive: false` 且保留 workspace 生命週期工具（真的能合併、刪除、改名、重排），新增 `reorderWorkspaces` AI 工具；刪除 `/api/lint` route、`vercel.json` cron 與 `CRON_SECRET`；`_schema/lint.md` 改為「檢查並直接修正」的清單並注入維護 pipeline
- **Phase 15** ✅：連結修復 + 維護整合 + 來源重跑 — wiki 連結伺服器咽喉點 alias fallback（`lib/wiki/slug.ts` + `/api/pages` GET，修 `[PAGE_NOT_FOUND]`）、圖譜邊 alias 解析去幽靈節點、lint job 化（migration `0016`，與 organize 共用 agent_jobs 鎖）、維護按鈕整合（Web `Wrench` 選單 + 進度 pill + localStorage 背景續跑；Android `Build` 選單）、來源重新整合（`/api/sources/[id]/reingest`）

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

## 安全注意事項（Phase 12）

| 嚴重度 | 位置 | 問題 | 修復方式 |
|--------|------|------|---------|
| P0 | `api/lint/cron/route.ts`（已刪除） | route 無任何驗證且替匿名呼叫者附上正確 CRON_SECRET 轉發到 `/api/lint`——任何人可匿名觸發全站 lint、燒光所有使用者 LLM API 額度 | 刪除代理 route，`vercel.json` cron 直指 `/api/lint`（Vercel 自動帶 secret），比較改用 `timingSafeEqual` |
| P1 | `lib/fetch/url-to-markdown.ts` | SSRF 防護只有 hostname 前綴 regex：`http://[::1]/`、`169.254.169.254`（雲端 metadata）、CGNAT、DNS 指向內網的網域全部繞過；redirect 只驗最終 URL | 重寫為 IP 正規化（含 IPv6 去括號/mapped 形式）+ `dns.lookup` 全 IP 檢查 + `redirect: 'manual'` 逐跳驗證 + 20s timeout + 5MB 上限。TOCTOU rebinding 窗口已於 Phase 13 以 undici Agent connect-time `lookup` 關閉（連線當下驗證同一份 DNS 結果） |
| P2 | `api/pages/[...slug]` PATCH | `content` 無大小上限 | `.max(2MB)` 對齊全站規範 |
| P2 | `lib/ai/tools.ts` | `writePage` 不檢查 `locked_by_human`、不擋 `notes/`/`_schema/` zone——LLM 可覆寫人類鎖定頁與唯讀區 | 工具層硬性 guard（見「AI 完整檔案操控」節） |
| P3 | `api/workspaces/[id]/synthesis` | `answer`/`cited_slugs` 無上限、slug 可注入 YAML frontmatter | `answer` 2MB、slugs regex `^[\w/.-]+$` + 上限 50 |
| P3 | migration `0012` | `google_oauth_tokens`（加密 refresh token 表）被 0011 慣例授予 anon/authenticated SELECT | REVOKE 只留 service_role（已套用至 production）。注意：`owns_workspace` 的 authenticated EXECUTE 是 RLS 必要的，**不可 revoke** |
| P3（Phase 13 已修） | `llm_profiles.extra_headers` | 明文儲存且 GET 原樣回傳；`api-key`/`x-api-key` 型 provider 的 secret 只能放這裡 | migration `0013`：新增 `extra_headers_encrypted bytea`，POST 走 AES-256-GCM 加密、GET 不再回傳 headers、`createLLMClient` 解密（legacy 明文列 fallback）。Android 不受影響（只讀 id/name/model 等欄位） |

## 安全注意事項（Phase 13）

- migration `0014`：revoke `broadcast_page_metadata_change()` 的 anon/authenticated EXECUTE（Supabase advisor 0029）。trigger 在 fire 時不檢查呼叫者的 EXECUTE 權限（已在 production 以 rollback transaction 實測），revoke 只擋直接 RPC 呼叫。
- `owns_workspace(uuid)` 的 authenticated EXECUTE 是 RLS 必要依賴，advisor 會持續 WARN——**這是接受的設計，不可 revoke**。
- Advisor「Leaked Password Protection Disabled」：本專案只用 Google OAuth；若要消除警告需在 Supabase Dashboard Auth 設定手動開啟（MCP/CLI 無法設定），不影響現有登入流程。
- SSRF 修法依賴 `undici` 套件（`apps/web` 直接依賴）：`Agent({ connect: { lookup: guardedLookup } })` 讓 net/tls connect 使用被驗證過的 DNS 結果；IP literal 由 `assertPublicHost` 前置擋掉（connect 不會對 literal 呼叫 lookup）。

## 安全注意事項（2026-07 全專案掃描）

| 嚴重度 | 位置 | 問題 | 修復方式 |
|--------|------|------|---------|
| P2 | `lib/ai/ingest-pipeline.ts` | ingest 的 LLM 拿到未 gate 的 `deletePage`——來源內容是任意網頁（不可信輸入），prompt injection 可讓匯入永久刪除該工作區未鎖定的 wiki 頁（`drive.files.delete`，非 trash） | pipeline 傳 `confirmDestructive: true`（無 onProposal → 直接拒絕）。匯入本來就是加法，去重交給 organize，**勿回退** |
| P3 | `api/search/route.ts` | ilike fallback 未清洗 PostgREST 特殊字元（`,()|%\`），可注入 or-filter 條件（RLS 仍擋跨帳號，實害低） | 對齊 `tools.ts` 的 `safeQuery` 清洗規則 |
| 依賴 | next 16.2.4 等 | `bun audit` 31 個漏洞（12 high），含 next RSC DoS/SSRF/cache poisoning | `bun update`（next→16.2.10）+ root `overrides`（`form-data ^4.0.6`、`ws ^8.20.1`）。剩 3 high 全在 build/deploy 工具鏈（fast-uri via eslint、path-to-regexp via @vercel/config），不進 runtime，接受 |
| 接受 | next-intl 3.x | advisor 報 open redirect 與 prototype pollution | 兩者分別只影響 next-intl middleware 模式與 `experimental.messages.precompile`，本專案皆未使用；升 v4 是大遷移，不做 |

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
- Android 共用 `AndroidHttpClient` 必須設定 Ktor timeout（connect 10s / socket 310s / request 320s）；socket timeout 必須涵蓋「完成前零輸出」的長呼叫（伺服器預算 300s），否則長操作必逾時。timeout / DNS / connection abort 要轉成本地化網路錯誤
- Android 切換、新建或刪除後切到下一個 workspace 時，`syncPagesInternal()` 後需自動選中 `index.md`（fallback `log.md`），避免停在「從選單選擇一個頁面」
- Android 匯入本機文字檔要限制大小（與 Web 同級 2 MB）並以串流文字讀取，不可直接 `readBytes()` 全讀進記憶體，否則大檔容易卡頓
- Web 三欄拖曳改用 `requestAnimationFrame` 批次套用寬度，避免每個 `mousemove` 都直接觸發整棵 shell 重渲染
- 共用色票已從 soft violet 改為 teal-blue；若新增顏色請同步 `packages/ui/src/styles.css` 與 Android `ui/theme/Color.kt`
- `Icons.AutoMirrored.Filled.List` 取代舊版 `Icons.Default.Menu`（Compose Material 3 方向性圖示）
- `SyncWorker.schedule()` 使用 `ExistingPeriodicWorkPolicy.KEEP`（不重複排程同一個 workspace）
- `PageRepository.syncPages()` 不再限制 200 筆，且會刪除本機 Room 中伺服器已不存在的頁面，避免 Android 側欄殘留舊頁
- Android `refreshAfterForeground()` 回到前景時需同步目前 workspace，否則 Web 端剛匯入完成的 `index.md` / `log.md` 容易被本機舊快取蓋住，看起來像手機沒更新
- Android / Web 的內部 wiki 連結解析都要接受不帶副檔名的 slug（例如 `entities/foo`），並自動補成 `.md`，否則索引頁連結會顯示但不能跳
- **Wiki 連結 alias fallback（Phase 15，勿移除）**：LLM 常把連結寫成 `[[Agentic AI Transformation]]`（缺 `concepts/` 前綴、大小寫、`.md` 不一致），與實際 slug `concepts/agentic_ai_transformation.md` 對不上。解法在**伺服器咽喉點** `GET /api/pages/[...slug]`：exact miss 時用 `canonicalWikiAlias`（`apps/web/lib/wiki/slug.ts`：取 basename + 小寫 + 去 `[\s_\-()]` + `&→and`）做**唯一匹配**才 resolve（0 或 2+ 匹配則不猜，回 404）。一次修所有 client（Web/Android/直接 URL），且 survives writePage 重寫，不需清資料。Graph（`graph-view.tsx`）同樣把邊端點經 alias 解析成真實節點 id、解不到就濾掉，避免 force-graph 生幽靈節點。真失連時 `page-viewer.tsx` 顯示 `wiki.linkedPageMissing`（友善訊息），不噴原始 `[PAGE_NOT_FOUND]`。
- **連結解析的第二、三層（Phase 16g，`lib/wiki/resolve.ts` 的 `pickAliasMatch`）**：production 581 條連結量到 157 條是斷的，拆成三類——
  - **用「頁面標題」當連結**（37 條）：`[[DRAM 市場 2026 年供需危機]]`，實際 slug 是 `summaries/dram-market-2026-crisis.md`。alias 比對從只比 slug 擴充到**也比 title**（slug 優先；仍是唯一匹配才 resolve）。
  - **頁被維護搬到別的工作區**（69 條）：`movePageToWorkspace` 只「回報」來源端反向連結會斷，沒有真的修。咽喉點在同工作區找不到時，會用同一套 alias 去**該使用者的其他工作區**找唯一匹配 → 回 `404 PAGE_MOVED_WORKSPACE` + `workspace_id`/`slug`；Web `PageViewer` 直接 `router.push` 過去，Android `selectPageBySlug` 查其他工作區並 `refreshWorkspaces(preferredWorkspaceId, preferredPageSlug)` 切過去（舊版連錯誤訊息都沒有，直接 `return`）。
  - **真的沒有那頁**（51 條）：交給健康檢查（見下）。
- **`[[slug|顯示名]]` 的顯示名不是 slug 的一部分（Phase 16h，勿回退）**：後端 `extractWikiLinks` 一直有 `split('|')`，但**兩個渲染器都沒有**——`page-viewer.tsx` 與 Android `MarkdownViewer` 把整串 `entities/donald-trump|Donald Trump` 當 slug，href 變成 `?page=entities/donald-trump|Donald Trump.md`（那頁永遠不存在）。LLM 寫索引時幾乎每條都用這個形式，所以**整份 index.md 的藍色連結全是死的**，而 `page_links` 表看起來很健康（它有切）——這就是「連結還是失效但資料庫說沒事」的落差。解法：`lib/wiki/slug.ts` 的 `parseWikiLink()`（slug / label / anchor 三段，有單元測試）供 Web 渲染器使用，Android 同樣切；`GET /api/pages/[...slug]` 對含 `|` 的請求也切一次（舊 client、舊書籤一併救回）。
- `ingestUrl()` / `ingestText()` 呼叫 Web app 的 `/api/ingest`，使用 Supabase session accessToken
- Web API 端點位址由 `BuildConfig.WEB_API_BASE_URL` 決定（從 `local.properties` 的 `WEB_API_BASE_URL` 或 `NEXT_PUBLIC_SITE_URL` 注入）
- Chat 串流協定：POST `/api/query` → `text/plain` stream，結尾附 `\x00CITATIONS\x00[...]`（可再接 `\x00ACTIONS\x00[...]`）；Android 用 Ktor `bodyAsChannel()` + `readUTF8Line()` 消費，`parseStreamMeta()` 解析（未知 block 忽略）
- Android chat sheet 的 `SmartToy` 按鈕是**多功能選單**（導入內容 / 從檔案匯入 / 選擇模型）；FAB 只剩一顆對話按鈕，匯入不再有獨立 FAB
- Android 破壞性確認卡片渲染在 `ChatBubble` 內；`executeProposal(messageIndex, proposalIndex)` 走 `/api/agent/execute`，刪除工作區成功後要清該 workspace 的 Room cache + cancel SyncWorker + `refreshWorkspaces()`
- Android 設定頁的 AI 權限開關寫 `supabase.auth.updateUser { data { put("ai_confirm_destructive", …) } }`（與 Web 共用同一個 user_metadata 欄位）；LLM profile 編輯走 `PATCH /api/settings/profiles`，api_key 留空＝保留原金鑰
- Lock toggle：PATCH `/api/pages/{wid}/{slug}` `{locked_by_human:bool}`，同步更新 Room cache（`PageDao.updateLock`）
- 登出後 NavController navigate("auth") popUpTo(0) inclusive=true
- 登出時 `WikiViewModel.signOut()` 會清空 Room DB（`PageDao.deleteAll()`）並取消 WorkManager job（`SyncWorker.cancel()`）
- `GOOGLE_CLIENT_ID` 必須使用 **Web OAuth client ID**（非 Android client ID），`requestIdToken()` 需要它來取得 ID token
- Web / Android 建立工作區 UI 不保留 description 欄位；Web `/w/create` 需提供返回 `/w` 的按鈕
- 使用說明入口需在 Web top bar 與 Android drawer 同步提供，說明內容涵蓋工作區、匯入、對話、設定同步與 Drive 重授權
- `ModalNavigationDrawer` 的 `gesturesEnabled` 必須設為 `drawerState.isOpen`，而非 `true`；Drawer 關閉時保留橫向手勢會與頁面垂直捲動產生競爭，導致上下滑動卡頓
- WikiScreen 的對話框開關、`inlineEditorPageSlug`、`inlineEditorValue`（`TextFieldValue.Saver`）、ingest 草稿一律用 `rememberSaveable`——旋轉/行程死亡不可丟失未儲存文字
- `BackHandler` 已接管搜尋模式與行內編輯器；系統返回鍵先關閉它們，不會直接退出 App
- `MainActivity` 的 `ExternalEvent` 含 `token`（nanoTime）；NavGraph 必須把 `shareUrlEvent?.token` / `authReturnEvent?.token` 傳進 WikiScreen 並作為 `LaunchedEffect` key——否則分享同一個 URL 第二次不會觸發
- `LaunchRoute` 查 workspaces 失敗（離線）時導向 `wiki` 而非 `workspace-create`；`workspace-create` 只保留給「成功查詢且真的沒有工作區」
- 離線冷啟：`AppPreferencesRepository.setLastWorkspace()` 持久化最後使用的 workspace（account + WorkspaceRow JSON），`refreshWorkspaces()` 失敗時還原它並顯示 Room 快取頁面清單，不再出現空白畫面
- Android backlinks 面板：`selectPage` 觸發 `loadBacklinks()` 直查 Supabase `page_links`（RLS），顯示為 MarkdownViewer 下方的 AssistChip 橫向捲動列；查詢失敗靜默為空（離線可接受）
- Sources 清單：drawer 底列 `LibraryBooks` icon → `SourcesListDialog`，`loadSources()` 直查 `sources` + `ingest_jobs`（各 source 取最新 job 的 status/touched 數）；來源不可編輯（Karpathy 原則），純檢視
- Chat 草稿存 `WikiUiState.chatDraft`（ViewModel），sheet 關閉/旋轉不丟；`sendQuery` 送出時清空
- Ingest 進度：`pollIngestJob` 於 running 期間讀 `touched_pages` 長度 → `WikiUiState.ingestProgress`，banner 顯示「整合中…已更新 N 個頁面」
- `themes.xml` 用 `Theme.AppCompat.DayNight.NoActionBar`，`values/` 淺色 windowBackground（#FAF9F7）、`values-night/` 深色（#0F1419）——避免淺色模式冷啟黑閃；AppCompat parent 不可換（`setApplicationLocales` 依賴）
- Compose 主題已補 `surfaceContainer*` 五個 slot（`Color.kt` 由 Bg/Bg2 衍生）——否則 AlertDialog/DropdownMenu/ModalBottomSheet 會用 M3 預設紫調
- 查詢失敗的錯誤必須傳進 `ChatBottomSheet` 內部顯示（sheet 全螢幕，Scaffold banner 會被蓋住）；`syncError` banner 有關閉鈕（`clearSyncError()`）
- Chat/設定選擇（主題/語言）用 `FilterChip`（含勾選 + TalkBack selected 語意），不要用僅變文字色的 OutlinedButton

## Graph View 注意事項

- **`d3-force` 會就地改寫 `link.source` / `link.target`**：從 id 字串換成節點物件。任何拿它當 Map key 的統計（degree、neighbors）在 re-mount 後會全部失效——實測所有節點 degree 都變 0，全部畫成孤兒。一律先 `endpointId()` 正規化（Phase 16g）。
- 視覺語言（Phase 16g）：顏色＝kind（冷色家族繞著 app 的 cyan accent，**只有 synthesis 是暖色**——那是 wiki 自己推理出來的頁）；大小／光暈亮度／標籤優先級全部由**連結度**驅動；孤兒頁畫**空心圓**（沒有連結的頁是待處理的發現，不是雜訊，舊版淡到 0.18 等於藏起來），頂列 readout 直接報「N 頁未連結」；標籤依 zoom 漸入（globalScale > 1.5 才浮現，否則整張圖是毛球）；`onEngineStop` → `zoomToFit`；圖例與篩選是**同一個控制項**；`prefers-reduced-motion` 時用 `warmupTicks` 離線跑完 layout 再畫。
- 圖只讀 `zone='wiki'` 的頁：`_schema` 規則頁不是知識，不該是節點。
- `GraphView` (`components/wiki/graph-view.tsx`) 動態 import `react-force-graph-2d`（ESM + window）避免 SSR 問題
- 從 Supabase `page_links` 表讀邊，`pages` 表讀節點（需 `createClient` from `@/lib/supabase/client`）
- `page_links` 由 `writePage` 工具在每次寫頁面時自動同步（解析 `[[wikilink]]` → upsert）
- workspace-shell 頂列 `GitFork` 按鈕切換，點節點後自動跳回 PageViewer
- `Wrench` 按鈕觸發 POST `/api/organize`（單一維護動作：健康檢查 ＋ 跨全部工作區整理去重）
- **Obsidian 對齊（Phase 14）**：節點大小改 degree-based（`3 + sqrt(degree) * 1.6`，上限 12），`nodeCanvasObject` 自繪節點 + 文字標籤（`globalScale > 1.4` 或 hover 才顯示標籤），hover 高亮鄰居（其餘節點/邊降透明度），孤兒節點（degree 0）平時淡化

## 維護 job（健康檢查 ＋ 整理去重，Phase 16 合一）

**只剩一個維護動作**：Web 頂列 `Wrench`、Android drawer `Build`，各一顆按鈕 → confirm → `POST /api/organize`（`agent_jobs` kind `organize`）。健康檢查與整理去重是**同一個 pipeline**（`lib/ai/organize-pipeline.ts` 的 `runOrganizePipeline`），不再有兩支 job、兩顆按鈕。

- **不產生任何報告頁**（不寫 `_lint/*`、`_organize/*`）——wiki 本身就是產出。`agent_jobs.progress` 累積工具呼叫（`toolName:slug|name|workspace_id`），前端 pill 顯示「已變更 N 項」，`report_slug` 永遠 null。
- **全權限、不 gate**：pipeline 傳 `confirmDestructive: false`——按鈕上的 confirm dialog 就是使用者授權。以前預設 `ai_confirm_destructive=true` 會讓背景 job 的刪除被 `gateDestructive` 直接拒絕（沒人能按確認卡片），這就是「自動整理去重沒有實際作用」的根因，**不要改回去**。
- **能用程式判斷的事不要交給模型（`lib/ai/organize-mechanical.ts`，勿回退）**：
  - **刪空工作區＝程式做**。維護 pipeline 傳 `allowWorkspaceDelete: false`，模型**根本拿不到 `deleteWorkspace` 工具**；`sweepEmptyWorkspaces()` 在 LLM 迴圈前後各掃一次，刪掉「只剩 index.md / log.md」的工作區（跳過當前工作區、跳過 1 小時內建立的——自動路由剛建好、ingest 還在跑的工作區不能被掃掉）。合法的合併照樣完成：這輪把頁面搬走，跑完的 post-sweep 當場清掉空殼。
    - **單一工作區刪除失敗不可弄死整輪維護**：`deleteWorkspaceForUser` 內的 `drive.files.update({trashed:true})` 在資料夾不存在／權限變更時會 throw，冒上去就會被 route 的 `after()` catch 成 job failed（連 LLM 迴圈都還沒開始）。掃描逐一 catch，失敗就跳過。
    - **維護自己建的工作區不吃寬限期**：1 小時寬限是保護「匯入路由剛建好、ingest 還在寫」的工作區；維護自己 `createWorkspace` 出來、跑完卻沒填東西的空殼要當場刪掉，否則使用者選單裡會多一個空書架、還得等一小時。用 `createWorkspace` 工具回傳的 `workspace_id` 精確記錄本輪建的（`graceExemptIds`），**不要拿時間去猜**——猜會誤殺使用者在維護期間匯入時新建的工作區。
  - **完全重複的頁＝程式找**。`findDuplicateClusters()` 用 `canonicalWikiAlias`（大小寫／資料夾前綴／`.md` 差異）＋ 標題完全相同，跨工作區算出重複叢集，直接把答案寫進 prompt。模型只負責語意重複（同一件事兩個名字）與分類。
  - **失效連結與過時 index＝程式找（Phase 16g，`findDeadLinks` / `findPagesMissingFromIndex`）**。prompt 從 Phase 16 就叫它「修復失效的 [[wikilink]]」，它一條都沒修過——要找出來得把 580 條連結對 140 個頁做交叉比對，這是 set operation，模型讀 inventory 根本做不到。現在程式算好兩份清單塞進 prompt（失效連結分「頁在別的工作區」與「根本沒這頁」兩類；index.md 沒列到的頁逐工作區列出），任務書第 5、6 步直接指向這兩份清單。
  - **同一頁在同一次按鈕裡只能被搬一次（`frozenMoveSlugs`，Phase 16f）**。每一輪都從 inventory 從零重新推導分類，邊界模糊的頁（資料中心算科技產業、半導體、還是 AI？）每輪答案都不一樣：production 實測三輪監控，4 頁被上輪搬走、下輪又搬回來。而且**有變更 → `more_work` 永遠 true → client 自動再開一輪**，一次按鈕可能整趟預算都花在自己推翻自己。`loadFrozenMoveSlugs()` 讀同一使用者 30 分鐘內 organize job 的 `progress`（一次按鈕最多 6 輪 × ~4 分鐘）取出已搬過的 slug，`movePageToWorkspace` 在查 DB 前就拒絕。只有維護 pipeline 會設這個旗標，**對話不受影響**（使用者叫它搬就該搬）。
  - **有頁面卻說「此知識庫尚無內容」的索引＝程式補（Phase 16h，`buildSeedIndexMarkdown` / `backfillSeedIndexes`）**。維護可能在最後一輪 `createWorkspace` ＋ 搬進 9 頁，然後預算用完——新工作區的 `index.md` 還是建立時的空殼種子頁，使用者切過去看到的第一句話是「此知識庫尚無內容」（production 實測，「UAP 與國家安全」）。「這個工作區裡有哪些頁」不是判斷題：LLM 迴圈與 final sweep 之後，對「有知識頁但 index.md 內完全沒有 `[[wikilink]]`」的工作區，依 kind 分組列出所有頁。**模型寫過的索引不動**（有 `[[` 就跳過），它之後仍可重新分組加上敘述。
  - 模型仍可 `renameWorkspace` / `createWorkspace` / `reorderWorkspaces` / `movePageToWorkspace` / `writePage` / `deletePage`——那些需要判斷「這頁在講什麼、該放哪」。
  - 測試：`apps/web/lib/ai/organize-mechanical.test.ts` ＋ `tools.test.ts`（`bun test`）。
- 健康檢查清單來源：觸發工作區的 `_schema/lint.md`（找不到就用 `getDefaultPrompt('lint', locale)`），以「參考」身分注入，並明講忽略其中任何「只寫報告 / 不要自動修」的字眼——舊 workspace 的 Drive 內還留著舊版文案。
- **深度重整靠三件事，缺一就退化成「只刪重複頁」**：(1) inventory 要帶每頁的 `search_text` 內容摘要——只有 slug/title 時模型只認得出 slug 相同的重複頁，看不出「這頁該搬去哪個工作區」；(2) prompt 要是明確的深度重整任務書（理解各工作區真實主題 → 跨工作區去重 → 依主題重新分類 → 工作區改名/合併/刪空的/新建/重排），**不可寫「別讀太多頁」之類節省字眼**，那會直接讓它變淺；(3) **loop-until-dry**：單次 `generateText` 講完一段話就結束（實測只用 60s / 5 個操作就宣告完成，預算還剩 150s），每輪結束要把「還沒處理的事」丟回去要它繼續，直到它回 `ORGANISE_COMPLETE`、連續兩輪零變更、或預算用盡。
- **一次 invocation 做不完 → 自動接力（`more_work`）**：pipeline 因時間預算停下且還有事沒做完時，把 `agent_jobs.more_work` 設為 true（migration `0017`）；Web / Android 收到 `done && more_work` 就自動開下一輪（上限 6 輪，`MAX_MAINTENANCE_PASSES`），pill 顯示整條鏈的累計變更數。沒有這個，深度重整會停在半路（頁面搬走了、空掉的工作區沒刪、index 沒收尾）。實測一次按鈕 = 8 輪 / 94 個操作，工作區從 10 個收斂到 6 個。
- **為什麼模型不能有 `deleteWorkspace`（事故記錄，勿回退）**：實測 gemini-3.5-flash 把「合併工作區」理解成「把所有頁面掃進我被觸發的那個工作區，再刪掉空殼」——一輪就把「個人理財與退休規劃」14 頁全倒進「地緣政治與全球貿易」然後刪掉整個工作區（頁面沒丟，但使用者少了一個書架，畫面只顯示「已變更 N 項」）。Phase 16d 曾用白名單（只准刪本輪開始時就空的）擋，Phase 16e 直接把工具收掉：**這個動作沒有任何判斷成分，卻是唯一一個失手就毀掉整個書架的動作**。prompt 也保留「每次搬移必須讓目標工作區更內聚」「當前工作區不是垃圾桶」「不同主題的工作區不可合併」「不准為了刪工作區而把頁面搬走」。
- **Provider 暫時性錯誤不可讓整輪白做**：OpenRouter 會回 `Failed after 3 attempts. Last error: Provider returned error`（SDK 自己重試完仍失敗）。pipeline 的每一輪 `generateText` 都 catch：等 8s（`PROVIDER_RETRY_DELAY_MS`）重跑同一輪；預算用完就以 `done + more_work` 收尾，讓 client 自動接下一輪——已完成的工具呼叫本來就逐一 commit，不能因為最後一輪炸掉就整個 job 標 failed。**只有「整趟 0 變更」才把 provider 錯誤 throw 出去**給使用者看。
- **工具迴圈有 210s wall-clock 預算（`TOOL_LOOP_BUDGET_MS`，勿移除）**：`stopWhen: [stepCountIs(80), () => Date.now() > deadline]`。Vercel `maxDuration = 300s` 一到會直接殺掉整個 invocation（含 `after()`），被殺的 run 來不及寫 job row → 永遠停在 `running` → 8 分鐘後才被 sweep 成 `Organize timed out`，使用者看到「逾時且沒有變化」。自己先停可優雅收尾；每個工具呼叫都各自 commit，中途停下 wiki 仍一致，使用者再按一次即可續做。
- `POST /api/organize` 仍是 `202 { jobId }` + `after()`，`GET /api/organize?job_id=` 輪詢（6 分鐘 stale sweep——超過 `maxDuration` 就一定是死掉的 job，設太長會讓下一次按鈕被 one-at-a-time 鎖 409 擋住、owner-scoped one-at-a-time 鎖）。Web jobId 存 `localStorage['llmwiki:maintenance']`，關頁面回來續 poll；完成時 `refreshPageList()` + `refreshWorkspaceList()`（工作區可能被改名/刪除/重排）。Android 完成時 `syncPagesInternal()` + `refreshWorkspaces()`。
- **`/api/lint` route 與 Vercel cron 已刪除**（連同 `vercel.json`、`CRON_SECRET`）：週期性、無人看管地跑一個有刪除權的 pipeline 太危險，且會不斷產生報告頁。要恢復排程請先想清楚破壞性動作的授權模型。舊 APK 會打到不存在的 `/api/lint`，需更新。

## 來源重新整合（re-ingest，Phase 15）

`POST /api/sources/[id]/reingest`：讀 source 既有 Drive 內容（`drive_file_id`）→ 建新 `ingest_job` → `after()` 重跑 `runIngestPipeline`，沿用 `GET /api/ingest?job_id=` 輪詢。**不重新抓 URL、不建重複 source row**（來源 immutable，只是重跑整合）。用於修 provider 暫時性失敗的來源。Web `SourcesDialog` + Android `SourcesListDialog` 每列「重新整合」按鈕（`reingestingSourceId` 期間 disable 其他列）。

## 統一導入入口（Phase 14）

導入不再有獨立輸入框。入口統一在對話輸入框左側的 `Bot` 多功能選單：
- Web：選單 →「導入內容」→ `ImportDialog`（`components/wiki/import-dialog.tsx`）：貼上文字/URL/Markdown、拖曳檔案、選檔（多檔佇列）
- Android：Chat sheet 的 `SmartToy` 選單 →「導入內容」/「從檔案匯入」

自動偵測輸入型別：URL（`http://` / `https://`）→ `{ kind: 'url' }`；其他 → `{ kind: 'text', title: 第一非空行 }`。text content 上限 2 MB（`MAX_TEXT_LENGTH`，與 client 端一致）。

**智慧導入（AI 判斷目標工作區，必要時自建工作區）**：`POST /api/ingest` 的 `workspace_id` 改為 optional，可改送 `{ auto_route: true, fallback_workspace_id }`。`lib/ai/route-workspace.ts` 的 `routeToWorkspace()` 用一次 `generateText` 給 LLM 看「所有工作區名稱 + 各自前 40 個頁面標題」，要它回**既有 workspace_id**，或在主題完全不屬於任何工作區時回 `NEW: <名稱>` → `createWorkspaceForUser()` 建新工作區並導入。**任何失敗都 fallback 到 `fallback_workspace_id`，不可讓路由失敗擋掉匯入**。回應帶 `routed_workspace_id` / `routed_workspace_name` / `routed_workspace_created`，前端顯示「已導入到 X」或「已建立新工作區「X」並導入」，`created` 時 Web 呼叫 `onWorkspaceCreated` / Android `refreshWorkspaces()` 讓選單立刻看得到。UI 預設就是「自動判斷」。

**路由失敗不可假裝有分類（Phase 16f，勿回退）**：舊版每一條失敗路徑都靜默 `return stay`（＝匯入到當前工作區），而回應照樣帶 `routed_workspace_name` → UI 顯示「已導入到 ⟨當前工作區⟩」，看起來像 AI 的判斷。這個 provider 常噴 `Provider returned error`，而路由那一次 `generateText` **完全沒有重試**，一失敗整批就落在使用者當下所在的工作區（production 7/12 那批全部落在「地緣政治」）。現在：
- provider 失敗、或回覆解不出決定 → **重試一次**（`ROUTING_ATTEMPTS = 2`）
- 解析器（`parseRoutingReply`，有單元測試）接受 workspace **id**、`NEW: <名稱>`、或**純工作區名稱**——小模型常直接回名字，舊版一律判失敗。名稱比對要能吃 markdown 粗體與整句回覆（`**地緣政治與全球貿易**`、「這篇屬於「AI」工作區。」）；**整句只在唯一一個工作區名稱出現時才算數**——兩個名字同時出現是模型在比較，不是在選。
- 真的沒做出決定時 `decided: false` → **不回 `routed_workspace_name`**，UI 就不會謊稱分類過（Android 用 `?.let{}` 取值，缺欄位天然相容）
- **失敗要留下 log（Phase 16h）**：provider 失敗與無法解讀的回覆都 `console.warn('[route-workspace] …')`。這條路徑一旦靜默 `.catch(() => null)`，「路由沒跑」與「AI 判斷就是放這」在外面長得**一模一樣**，只能靠猜。
- 只有 index/log 的**空殼工作區不列為候選**（空殼沒有主題可比對，維護也會掃掉它）

自建工作區的防護（勿移除）：`MAX_AUTO_WORKSPACES = 12` 上限；`NEW:` 名稱要跟**全部工作區**（不只候選）做不分大小寫比對，命中就沿用——多檔批次導入是逐檔序列送出，第一個檔剛建好的工作區**還沒寫進頁面（=空的、不在候選裡）**，只比候選會生出同名雙胞胎。整個庫還沒有任何知識頁時直接 fallback，不在空工作區旁邊再開一個。

**profile fallback**：production 的工作區普遍沒有 `default_profile_id`（profile 是工作區建立後才加的，沒人回填），所以 `/api/ingest` 必須跟 `/api/organize` 一樣退回 owner 的 `is_default` profile（`loadDefaultProfileId()`）。少了這段，client 只要沒帶 `profile_id` 就 422「No LLM profile configured」。

**ingest 去重靠的是 DB 頁面清單，不是 index.md**：`runIngestPipeline` 會把該工作區**所有 wiki 頁**（`pages` 表 slug/kind/title，上限 400）塞進 user message，並要求「要寫的 slug 不在清單裡時，先確認清單中沒有頁面已涵蓋同一主題；有就 readPage 後改寫那一頁」。index.md 是模型自己維護的、會漂移，拿它當唯一來源就會出現「同一實體兩頁不同 slug」。

## 非同步 Ingest 協定（重要）

`POST /api/ingest` **不再同步等待 LLM pipeline**：
1. 驗證 + 抓取來源 + 建立 source / job 記錄後，立即回 `202 { jobId, status: 'running' }`
2. Pipeline 透過 `after()`（`next/server`）在回應後繼續執行（Vercel Fluid Compute，maxDuration 300s）
3. Client 輪詢 `GET /api/ingest?job_id=<uuid>` → `{ jobId, status, error, touched_pages }`
4. `running` 超過 8 分鐘的 job 會在下次查詢時被掃成 `failed`（stale sweep）

Web（`pollIngestJob`，3s 間隔）與 Android（`WikiViewModel.pollIngestJob`）都走這套協定；完成後顯示「已更新 N 頁」。
**這是手機匯入不再逾時的關鍵**：舊版同步等待 300s，Android socket timeout 必炸；現在 POST 幾秒內返回，App 跳背景／切頁面都不影響伺服器端 job，回前景同步即見結果。
向後相容：舊 server 回 `{ status: 'done' }` 時 client 直接視為完成。
`urlToMarkdown` 有 20s fetch timeout、5 MB 頁面上限、逐跳 redirect SSRF 驗證（IP 正規化 + DNS 解析檢查，含 IPv6/link-local/CGNAT/metadata IP），並用 undici Agent 的 connect-time `lookup` 在建立連線當下驗證 IP（無 TOCTOU rebinding 窗口）。
**即時進度**：pipeline 的 `onStepFinish` 會把 `touched_pages` 逐步寫回 job row，輪詢端在 `running` 期間即可顯示「已更新 N 頁」（Web `ingestProgress` state / Android `WikiUiState.ingestProgress`）。

**0 頁 = 失敗，不是成功（Phase 16e，勿回退）**：`runIngestPipeline` 舊版跑完一次 `generateText` 就無條件把 job 標 `done`。模型只要回一段話、沒呼叫任何工具（provider 抽風、prompt 沒踩到、內容太長），就會出現 **status=done / touched_pages=[] / 只花 10 秒** 的 job——UI 顯示「匯入完成」，wiki 卻完全沒變。production 22 次匯入中有 7 次是這樣（使用者以為存進去了，其實整篇不見）。現在：`touchedSlugs` 為空時在同一段對話追加 `NUDGE_PROMPT` 再跑一輪（provider 錯誤則等 5s 重試），兩輪都沒寫入就 **throw** → route 的 `after()` catch 把 job 標 `failed` 並寫入錯誤訊息，使用者看得到、可用「重新整合」按鈕重跑。**「有沒有真的寫進去」是程式該驗的事，不能靠模型自述。**

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

## 模型選擇器（Bot 多功能選單）

Conversation panel 輸入框左側的 `Bot` 按鈕是**多功能選單**：「導入內容」＋「選擇模型」（Android：`SmartToy` icon，含「從檔案匯入」）。
- profile 列表來自 `/api/settings/profiles`，預設選中 `is_default=true`
- Query / Ingest / Organize API 支援可選 `profile_id` override，會檢查 `owner_id` 權限
- 若使用者未設定任何 profile，選單只留導入項，API fallback 至 workspace 綁定的 default profile

## 批次檔案攝取

`import-dialog.tsx` 支援多檔案上傳：
- `<input type="file" multiple>` 選擇多個 `.md` / `.txt` / `text/*` 檔案
- 拖曳檔案到 dialog textarea 觸發批次上傳
- `queue` 狀態顯示每個檔案的進度（pending / uploading / done / error）
- 每個檔案獨立呼叫 `/api/ingest`（`kind: 'text'`），支援 `profile_id` 覆寫與 `auto_route`

## 筆記（已於 Phase 14 移除 UI）／規則

- **筆記 UI 已移除**（Web page-tree/workspace-shell、Android WikiScreen/WikiViewModel）。產品改為對話驅動：使用者在對話中講想法，AI 判斷有價值的內容 → 直接寫進知識頁。
- **資料與 API 保留**：Drive 的 `notes/` 資料夾、`notes/guide.md` seed、`/api/pages/[workspaceId]` 的 notes CRUD route 都還在，只是沒有入口。要復原筆記功能只需接回 UI。
- **`notes/` 仍是 LLM 禁區**：`lib/ai/tools.ts` 的 `guardWikiSlug` 照舊拒絕 `notes/`、`_schema/`、`sources/` 開頭的 slug（Karpathy 原則 5 的程式層落實，**不可移除**）。
- 頁面樹只顯示 `zone === 'wiki'`；`notes` / `schema` zone 不再出現在側欄。
- 工作區建立與頁面列表讀取時，仍會自動補齊 `notes/guide.md` 與 `_schema/{ingest,query,lint}.md` 的 metadata
- 設定頁若發現 `schema` zone 缺少系統規則頁，會先做 DB count pre-check，再以 `after()` 在背景呼叫 `ensureWorkspaceSystemPages()` 補齊（不阻塞渲染）
- `_schema/*.md` 入口在設定頁，顯示為「匯入規則 / 查詢規則 / 健康檢查規則」；不要再把規則當成一般 Wiki 側欄區塊
- Web `PageViewer` 與 Android `MarkdownViewer` 都會把 wiki 內部連結留在同一個 App / 視窗內跳轉，不再強制另開新視窗
- Android 頁面內容讀取優先走 Web `/api/pages/{workspaceId}/{slug}`，避免手機端 Google Drive `drive.file` scope 與 Web 匯入檔案歸屬不同造成空內容
- `/api/pages/[workspaceId]/[...slug]` 的 GET 現在固定回 JSON；成功時 `content` 必須是字串，失敗時回 `{ error: { code, message, requestId, ...publicMeta } }`，不可把 Drive 內部 metadata 洩漏給 client
- `readDriveFile()` 會先查 Drive metadata 再依 MIME type 分流：`text/markdown` / `text/plain` 直接讀、Google Docs 走 export、`application/octet-stream` 先過 binary guard；讀不到就 throw `DriveReadError`，不可 silent fallback 成空字串
- Web `PageViewer` 若收到 `DRIVE_RECONNECT_REQUIRED`，必須顯示可直接觸發 OAuth 重授權的按鈕；不能只顯示錯誤文字讓使用者自己猜

## 工作區排序

- `workspaces.sort_order`（migration `0005_workspace_sort_order.sql`）提供持久化自訂排序
- Web 工作區選單的拖曳改用 **pointer events + FLIP 動畫**（Phase 14）：按住把手 → `setPointerCapture`，拖曳項用 `translateY(dy)` 跟手 + 提升 z-index/陰影，其他項依即時目標 index 位移一個 row 高度並帶 `transform 150ms ease-out` 過渡（「推開」效果），放開才 commit 順序。`prefers-reduced-motion` 時關閉過渡。**不要退回 HTML5 drag-and-drop**（無跟手回饋、觸控不支援）
- 排序落庫仍走 `/api/workspaces/reorder`（樂觀更新 + 失敗 rollback）
- Android 工作區選單支援上移 / 下移，走同一套排序 API，同步 Web / 手機順序
- Web 端任何首頁導頁、登入回跳或工作區列表查詢，若遇到 production 尚未套用 `sort_order` / schema cache 未刷新，必須 fallback 至 `created_at`，不可誤顯示「建立工作區」
- 若 production 出現「拖曳後又跳回原順序」，先查 `workspaces.sort_order` 是否存在；缺欄位時只執行 idempotent 的 `0005_workspace_sort_order.sql` 修 schema，不要用整批 `db push` 硬套舊 migration history

## 全文搜尋

**資料庫層**：`pages.search_text TEXT` + `pages_fts_idx` GIN index（`to_tsvector('simple', ...)`）

**API**：`GET /api/search?workspace_id=xxx&q=keyword`
- 優先嘗試 `search_pages` RPC；若函數不存在（migration 尚未執行），graceful fallback 至 `ilike` 基礎搜尋

**UI**：`workspace-shell.tsx` 頂部 `Search` 按鈕
- 點擊展開下拉搜尋框（`showSearch` state）
- 輸入 2 字元以上自動 debounce（200ms）搜尋
- 結果顯示 title / kind / slug，點擊跳轉至該頁面

## AI 完整檔案操控（跨工作區）

`lib/ai/tools.ts` 的 `buildWikiTools(ctx)`。頁面工具全部接受可選 `workspace_id`（省略＝當前工作區）；workspace 管理工具只在 `crossWorkspace: true` 且有 `userId` 時掛載（query / organize 有，ingest pipeline 沒有）。

| 工具 | 說明 |
|------|------|
| `readPage` | 讀取頁面內容（Drive file） |
| `writePage` | 建立/覆寫頁面，自動同步 `page_links` 與 `search_text` |
| `searchPages` | 基礎 `ilike` 搜尋 title + slug（fallback 查詢會先清洗 PostgREST 特殊字元） |
| `listPages` | 列出所有 wiki 頁面，可選 kind 篩選 |
| `deletePage` | 刪除頁面：清理 `page_links`、刪除 Drive file、刪除 DB record（**破壞性**） |
| `movePage` | 重命名/移動頁面：自動重寫所有**引用該頁面**的 `[[wikilink]]`，更新 `page_links` slug |
| `listWorkspaces` | 列出使用者所有工作區（id + name + 是否為當前） |
| `createWorkspace` | 建立工作區（Drive 資料夾 + 系統頁 + default profile 綁定，走 `lib/workspaces/manage.ts`） |
| `renameWorkspace` | 重新命名工作區 |
| `reorderWorkspaces` | 重新排序工作區（寫 `workspaces.sort_order`；漏傳的工作區自動補在後面，不會消失） |
| `deleteWorkspace` | 刪除工作區（先 trash Drive 資料夾再刪 DB，**破壞性**） |
| `movePageToWorkspace` | 跨工作區搬頁：讀來源 → 寫目標 → 刪來源；回傳來源側會變成 dangling 的 backlink 清單 |

**工具層硬性防護（Karpathy 原則 enforcement，勿移除）**：
- `writePage` / `deletePage` / `movePage` / `movePageToWorkspace` 一律拒絕 `notes/`、`_schema/`、`sources/` 開頭與含 `..` 的 slug——LLM 只能寫 wiki zone（原則 5 的程式層落實，不能只靠 prompt）
- `locked_by_human = true` 的頁面拒絕覆寫/刪除/移動（原則 3 的程式層落實）
- `index.md` / `log.md` 為 `PROTECTED_SLUGS`，不可刪除或移動（跨工作區搬移也擋）
- `resolveScope(workspace_id)` 查 workspace 時**必帶 `.eq('owner_id', ctx.userId)`**——這是跨工作區存取的唯一授權關卡，不可拿掉
- **slug 解析必須問 DB，不可盲目補 `.md`（勿改回去）**：舊資料有一批沒有副檔名的 slug（`concepts/HBM`、`concepts/Advanced_Packaging`…）。過去 `readPage`/`deletePage`/`movePage`/`movePageToWorkspace` 一律把輸入補成 `X.md` 再查，導致這些頁**永遠查不到**；模型於是 `writePage` 一個新的 `X.md`、再 `deletePage` 同一個 `X.md`（以為刪掉重複頁），舊頁原封不動，空轉到 300s 被砍——這就是「自動整理逾時且沒有任何變化」的根因。現在一律走 `resolveExistingSlug()`：查 DB 實際存在的 slug（優先 `.md`，退回字面 legacy row）；`writePage` 命中 legacy row 時會把該列的 slug 收斂成 `.md`（含 `page_links` 的 `from_slug` 一併搬移）。新頁仍 normalize 成 `.md`
- `movePage` 的反向連結 regex 同時匹配 `[[slug]]` 與 `[[slug.md]]`（含 `|display` / `#anchor` 後綴）
- Drive folder cache 的 key 是 `${workspaceId}:${path}`（跨工作區不可共用同一個 path key）
- 頁面寫入/刪除的核心邏輯已抽成 module-level 的 `writePageForWorkspace` / `deletePageForWorkspace`，由工具與 `/api/agent/execute` **共用同一份**——確認後執行的參數不可能繞過工具層的 guard

## AI 破壞性操作確認（Phase 14）

使用者偏好存 Supabase auth `user_metadata.ai_confirm_destructive`（**預設 true = 需確認**；Web `components/settings/ai-permissions.tsx`、Android 設定頁 FilterChip，兩端共用同一個欄位）。

需確認模式下：
1. `deletePage` / `deleteWorkspace` 工具**不執行**，改經 `onProposal` 收集 proposal，串流尾端以 `\x00ACTIONS\x00[...]` 送出
2. 前端渲染確認卡片（Web chat 訊息下方 / Android `ChatBubble` 下方）
3. 使用者按確認 → `POST /api/agent/execute` `{ action, workspace_id, slug? }` → server 重新驗 owner + 重跑同一份 core 函式
4. **參數竄改防護**：execute route 用 zod discriminatedUnion 只收白名單欄位（`name` 之類顯示用欄位被丟掉），owner 檢查 + core 函式內的 zone/lock/protected guard 全部重跑一次

`gateDestructive` 只在 `confirmDestructive: true` 時生效。對話流程預設 true（有 `onProposal` → 確認卡片）；**ingest pipeline 也固定 true 且無 onProposal → 直接拒絕 deletePage**（來源是不可信輸入，prompt injection 不可永久刪頁，2026-07 掃描修）；維護 job 走 `confirmDestructive: false`（按鈕 confirm = 授權），刪除直接執行。


## 對話上下文（Phase 14）

`POST /api/query` body 除了 `messages` / `workspace_id` / `profile_id`，另收：
- `current_slug`：使用者**正在看的頁面**。server 讀該頁內容注入 context，並明講「使用者沒特別指定時，問題就是在問這一頁」——這是「AI 預設讀取當前頁面」的實作
- `context_workspace_ids`（上限 5）：`@` 標記的其他工作區。server 逐一驗 owner 後注入各自 `index.md`，並把 workspace_id 告訴模型，讓工具可以直接操作它們

前端：Web 輸入框偵測結尾 `@xxx` 片段 → 浮動工作區選單（↑↓ + Enter / Tab 選取）→ 選中變成 chip；Android 同樣邏輯（chip 用 `AssistChip`）。送出後 chip 清空。
系統 prompt 尾端由 server 追加「跨工作區能力說明」（`_schema/query.md` 客製化後仍會補上，確保工具能力永遠有被說明）。

## 效能：Server Component 不可在請求路徑上打 Drive

`app/w/[wid]/page.tsx` 與 `app/settings/page.tsx` 的 `ensureWorkspaceSystemPages()`（Google Drive API 呼叫）已移進 `after()`。
**切換工作區/進設定頁變慢的根因就是這個同步 Drive 呼叫**；新增 server component 邏輯時，任何外部 API 呼叫都要先問「這個非得在渲染前完成嗎」。工作區查詢與 pages 查詢也已併進同一個 `Promise.all`。

## 工作區刪除（migration 0018，勿回退）

`bump_workspace_sync_revision()` 是 `pages` 的 AFTER DELETE trigger，會 INSERT 進 `workspace_sync_state`。刪工作區時 pages 被 CASCADE 刪除 → trigger 對**已經不存在的** `workspace_id` 做 INSERT → FK 違規 → 整筆交易回滾。**結果是任何工作區都刪不掉**（Web/Android 刪除鍵 500、AI 的 `deleteWorkspace` 一直失敗，只好把工作區改名成「【準備刪除】…」繞路）。修法：trigger 在 workspace 已不存在時直接 `RETURN NULL`。

`deleteWorkspaceForUser` 是「先 trash Drive 資料夾 → 再刪 DB row」（順序不可反，避免 DB 沒了 Drive 還在）。DB 刪除失敗時**必須把資料夾從垃圾桶還原**，否則使用者會留著一個內容躺在垃圾桶的工作區。

## 資料庫 Migration

`supabase/migrations/0004_fulltext_search.sql`：
- `ALTER TABLE pages ADD COLUMN search_text TEXT`
- `CREATE INDEX pages_fts_idx USING GIN (...)`
- `CREATE OR REPLACE FUNCTION search_pages(p_workspace_id UUID, p_query TEXT)`

`supabase/migrations/0015_agent_jobs.sql`（已套用 production）：跨工作區 AI job 表（`organize`）。`ingest_jobs` 綁 workspace + `source_id NOT NULL`，裝不下跨工作區任務，故另開 owner-scoped 表。GRANT 緊接 CREATE TABLE、再 enable RLS（`owner_id = auth.uid()`）。

### Data API GRANT 規範（參考全域 CLAUDE.md Supabase 資料庫規範）

本專案已統一透過 migration `0011_data_api_grants.sql` 為所有表補上 Data API GRANT，並設置 `ALTER DEFAULT PRIVILEGES` 預防未來疏漏。往後新增表或 function 時請同步補上 GRANT，否則 PostgREST 會回 `42501`。

## 其他注意事項

- **Markdown 渲染**：`page-viewer.tsx` 用 `react-markdown` + `remark-gfm`。YAML frontmatter 以 `stripFrontmatterAndWikilinks()` 手動 strip（不用 `remark-frontmatter`，那個不自動隱藏內容）。`[[slug]]` 轉成 `[slug](wiki://slug)` 供自訂 `<a>` renderer 攔截；ReactMarkdown 必須設定 `urlTransform` 放行 `wiki:`，否則預設 sanitizer 會把 href 清空。
- **`.env.vercel.tmp`**：`vercel env pull` 輸出的暫存檔，已加入 `.gitignore`，不應提交。
- Lucide v3 已移除 icon 的 `title` prop，改用 `aria-label`
- `packages/prompts` 的 `.md` import 需要 `markdown.d.ts` 宣告 + next.config webpack `asset/source` loader
- TypeScript target 需 ES2023（`Array.prototype.findLast`）
- Google Drive scope 用 `drive.file`（只看到 App 建立的檔案）
- i18n 採 cookie-based（`NEXT_LOCALE`），支援 `zh-TW`（預設）和 `en`
