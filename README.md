# LLM Wiki

> 把你讀過的東西交給 AI，它會整理成一套互相連結、會持續更新的 Markdown 知識庫。網頁與 Android 都能用，內容存在你自己的 Google Drive。

靈感來自 Andrej Karpathy 的做法：不是每次提問才臨時翻資料，而是讓 LLM 把每個來源**編譯**進 wiki——寫摘要、建立人物與概念頁、補上交叉連結、標出互相矛盾的說法。wiki 本身就是成品，會越用越完整。

## 能做什麼

**匯入**
- 貼上網址或文字，或上傳 PDF、DOCX、PPTX、EPUB、純文字／Markdown 與圖片（單檔 2 MiB 內）。
- AI 自動判斷該放進哪個工作區，主題都不合時會自己開新的工作區。
- 送出後立即存檔，之後在伺服器背景處理；關掉網頁或 App 也不會中斷。額度用完或供應商出錯會自動重試，進度在「匯入佇列」查看。

**對話**
- 預設以你正在看的頁面為上下文，輸入 `@` 可以帶入其他工作區。
- 「事實模式」只讀原始來源作答，並標出引用的行數。
- 好的回答可以一鍵存成綜合頁；刪除類操作會先跳出確認卡片。

**整理與瀏覽**
- 多個工作區，可切換、改名、刪除與拖曳排序。
- 全文搜尋、知識圖譜與圖譜洞察（孤立頁、群組、橋接頁、失效連結）。
- 「整理知識庫」讓 AI 跨全部工作區合併重複頁、重新分類、修好失效連結，直接改 wiki，不另寫報告。
- 來源清單保留每一份原始來源，可以重新整合。

**資料歸你**
- 頁面是純 Markdown，放在你 Google Drive 的 `Apps/LLM Wiki/`，用 Obsidian、VS Code 或任何編輯器都能打開。
- LLM 自備金鑰：任何 OpenAI 相容端點（OpenRouter、OpenAI、Ollama…），或直接用 ChatGPT 帳號登入使用方案額度。

**Android**
- 離線快取、從其他 App 分享網址進來匯入、在前景時自動同步。
- 側邊欄可左右滑開，不會和上下捲動打架。

## 核心原則

1. **匯入是編譯，不是建索引**：一個來源通常會改到 10 個以上既有頁面。
2. **提問的結果可以存回 wiki**：你的探索過程也會變成知識。
3. **LLM 負責寫 wiki，你負責導演**：你挑來源、提問題。
4. **原始來源不可修改**：每一頁都能追溯回來源。
5. **AI 的 wiki 與你的筆記分開存放**：`wiki/` 由 AI 寫，`notes/` 與 `_schema/` AI 不能動。
6. **規則一起演化**：匯入、查詢、整理的提示詞放在 `_schema/`，可以在設定頁修改。
7. **對話與即時更新的 wiki 是主要體驗**。

## 架構

```
 Web（Next.js）   Android（Compose）
        │               │
        └───── Web API（Vercel，sin1）─────┬──── LLM 供應商（自備金鑰／ChatGPT）
                                          ├──── Google Drive（頁面內容）
                                          └──── Supabase（帳號、metadata、Realtime、
                                                 pg_cron 每分鐘喚醒匯入 worker）
```

- 頁面內容只存在 Google Drive（`drive.file` 權限，只看得到本 App 建立的檔案）；Supabase 只存 metadata、連結與工作狀態。
- Android 呼叫與網頁相同的 API，另外用 Room 快取頁面，可離線閱讀。

## 專案結構

```
LLM-wiki/
├── apps/
│   ├── web/                    Next.js 16 App Router（介面＋全部 API）
│   │   ├── app/api/            ingest、query、organize、pages、workspaces、sources、search、graph…
│   │   ├── app/w/[wid]/        工作區主畫面（workspace-shell.tsx）
│   │   ├── components/wiki/    對話、匯入、頁面、圖譜、來源清單
│   │   ├── lib/ai/             LLM client、工具、匯入與整理 pipeline
│   │   ├── lib/drive/          Google Drive 讀寫
│   │   └── messages/           介面文字（zh-TW、en）
│   └── android/                Kotlin + Jetpack Compose
│       └── app/src/main/java/com/llmwiki/
│           ├── ui/wiki/        主畫面、側邊欄（SwipeDrawer）、圖譜、Markdown 顯示
│           ├── data/           API／Supabase／Drive 存取與 Room 快取
│           └── sync/           背景同步與匯入上傳（WorkManager）
├── packages/
│   ├── prompts/                預設的匯入／查詢／整理提示詞
│   ├── shared-types/           共用 TypeScript 型別
│   ├── drive-schema/           Drive 資料夾路徑常數
│   └── ui/                     共用色票與樣式
└── supabase/migrations/        資料庫 schema 與 pg_cron 排程
```

## 快速開始

### 需要準備

- Bun 1.x（或 Node.js 22）
- Supabase 專案（免費方案即可）
- Google Cloud 專案：建立 Web OAuth client，啟用 Drive API
- 一把 LLM API 金鑰，或 ChatGPT 帳號

### 1. 資料庫

依序套用 `supabase/migrations/` 內的 migration（`supabase db push` 或在 Dashboard 執行）。匯入 worker 需要另外在 Vault 寫入網址：

```sql
select vault.create_secret('https://<你的網域>/api/ingest/worker', 'ingest_worker_url');
```

沒有這一筆時，匯入仍可運作，但要有網頁或 App 開著才會往下跑。

### 2. Web

```bash
bun install
cp apps/web/.env.example apps/web/.env.local
bun run dev
```

`.env.local` 需要填：

| 變數 | 說明 |
|---|---|
| `NEXT_PUBLIC_SUPABASE_URL`、`NEXT_PUBLIC_SUPABASE_ANON_KEY` | Supabase 專案網址與 anon key |
| `SUPABASE_SERVICE_ROLE_KEY` | 只在伺服器使用 |
| `ENCRYPTION_KEY` | 加密 API 金鑰用，`openssl rand -base64 32` 產生 |
| `GOOGLE_OAUTH_CLIENT_ID`、`GOOGLE_OAUTH_CLIENT_SECRET` | Google Web OAuth client |

Google OAuth 同意畫面要發布為「正式版」，否則 refresh token 7 天就會失效，使用者每週都得重新授權 Drive。

### 3. Android

1. 用 Android Studio 開啟 `apps/android`。
2. 依 `local.properties.example` 建立 `apps/android/local.properties`：
   ```properties
   SUPABASE_URL=https://your-project.supabase.co
   SUPABASE_ANON_KEY=your-anon-key
   # 要填 Web OAuth client ID，不是 Android client ID
   GOOGLE_CLIENT_ID=xxx.apps.googleusercontent.com
   WEB_API_BASE_URL=https://your-app.vercel.app
   ```
   在模擬器上連本機開發伺服器時，`WEB_API_BASE_URL` 改成 `http://10.0.2.2:3000`。
3. 建置：`.\gradlew.bat :app:assembleDebug`（需要 Android Studio 內附的 JDK 17）。支援 Android 8.0（API 26）以上。

### 下載 Android 版

到 [最新 Release](https://github.com/RX5950XT/LLM-wiki/releases/latest) 下載 APK。

## 使用方式

1. 用 Google 帳號登入，App 會在 Drive 建立 `Apps/LLM Wiki/`。
2. 到設定頁新增 LLM 設定檔，或用 ChatGPT 登入。
3. 在對話輸入框按「＋」→「導入內容」，貼上網址、文字或選檔案。
4. 在對話中提問；回答會附上引用的頁面，可存成綜合頁。
5. 網頁版的「更多」選單、Android 側邊欄上方的捷徑，可以打開來源清單、知識圖譜與整理知識庫；匯入佇列在「＋」裡。

## 開發

```bash
bun run dev          # 啟動網頁開發伺服器（http://localhost:3000）
bun run typecheck    # 全部套件型別檢查
bun run test         # 單元測試
bun run build        # 正式建置
```

| 文件 | 內容 |
|---|---|
| [CLAUDE.md](CLAUDE.md)／[AGENTS.md](AGENTS.md) | 開發規範、架構決策與「不要回退」的實測紀錄 |
| [CONTEXT.md](CONTEXT.md) | 最近做了什麼、還缺什麼 |
| [CONTRIBUTING.md](CONTRIBUTING.md) | 開發環境與 PR 規範 |

## 授權

MIT
