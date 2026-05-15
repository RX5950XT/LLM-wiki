# LLM Wiki

> 一個由 LLM 持續維護的知識庫，橫跨 Web 與 Android，所有內容儲存在你自己的 Google Drive。

靈感來自 Andrej Karpathy、Lex Fridman 和 tobi 的工作方式——讓 LLM 讀取你的資料來源，將其整合進一個互相連結的 Markdown wiki，並持續保持更新，而不需要你手動整理。

## 為何存在

大多數「與文件對話」的工具在每次查詢時只是片段式地撈取資料，兩次對話之間什麼都不記得。LLM Wiki 不同：LLM 會將每一個新來源增量地**編譯**進結構化的 wiki（摘要、實體頁面、交叉引用、矛盾標記）。**Wiki 是持久存在的成品。** 資料歸你所有——以純 Markdown 格式存放在你的 Google Drive，可以直接用 Obsidian、VS Code 或任何文字編輯器開啟。

## 核心原則

1. **Ingest 是編譯，不是索引** — 一個來源會觸及 10 個以上既有頁面
2. **查詢結果可存回 wiki** — 你的探索過程本身也成為知識
3. **LLM 主導 wiki 層，使用者負責導演** — 你策展來源、提問
4. **原始來源不可變更** — 完整可追溯
5. **使用者筆記與 AI wiki 實體分離**（Steph Ango 原則）
6. **Schema 共同演化** — 你可以調整引導 LLM 的 Prompt
7. **對話 + 即時 wiki 是核心體驗** — 一側聊天，另一側 wiki 即時更新

## 技術棧

| 層級 | 技術 |
|------|------|
| Web 前端 | Next.js 16 App Router + Tailwind CSS v4，部署於 Vercel |
| Android | Kotlin + Jetpack Compose |
| Metadata | Supabase（Postgres + Auth + Realtime） |
| 儲存 | 你自己的 Google Drive（我們只存 metadata） |
| LLM | BYO key，支援 OpenAI-compatible endpoint（OpenRouter / OpenAI / Anthropic / Ollama / 任意） |

## 開發進度

| 階段 | 狀態 | 說明 |
|------|------|------|
| 0 — 骨架 | ✅ | Monorepo、Next.js 16、Android 骨架、Supabase schema |
| 1 — Web MVP | ✅ | Google OAuth + Drive 初始化、來源整合、wiki 瀏覽、Realtime |
| 2 — 查詢與存回 | ✅ | 對話介面、Citation chips、Synthesis 頁面、鎖定切換 |
| 3 — Android | ✅ | Kotlin + Compose、Room 離線快取、分享意圖、WorkManager 同步 |
| 4 — Lint + Graph | ✅ | 力導向圖視圖、LLM wiki 健檢、每週定期任務 |
| 5 — 介面優化 | ✅ | 完整繁體中文 i18n、可拖移側邊欄、個人資料頁、任意格式 ingest |
| 6 — 多工作區 | ✅ | 多工作區切換、新建工作區、Drive token 失效重授權 |
| 7 — Android 對齊 | ✅ | Android Chat/Query 串流、citations、synthesis、lock toggle、登出 |
| 8 — 安全強化 | ✅ | P0/P1 安全漏洞修復、Android 帳號 Room cache 隔離 |
| 9 — 批次攝取 + 搜尋 | ✅ | 多檔上傳/拖曳、PostgreSQL tsvector 全文搜尋、模型選擇器 |
| 10 — AI 檔案操控 | ✅ | deletePage / movePage 工具（自動重寫 backlink）、工作區排序 |

## 快速開始

### 前置需求
- Node.js 22 / Bun
- Supabase 專案（免費方案即可）
- Google Cloud 專案，已啟用 OAuth client 與 Drive API

### Web

```bash
git clone https://github.com/your-org/llm-wiki
cd llm-wiki
bun install
cp apps/web/.env.example apps/web/.env.local
# 填入 SUPABASE_URL、SUPABASE_ANON_KEY、SUPABASE_SERVICE_ROLE_KEY
#       ENCRYPTION_KEY（openssl rand -base64 32）
#       GOOGLE_OAUTH_CLIENT_ID、GOOGLE_OAUTH_CLIENT_SECRET
#       NEXT_PUBLIC_SITE_URL（部署後改為 Vercel URL）
bun run dev
```

### Android

1. 用 Android Studio 開啟 `apps/android`
2. 建立 `apps/android/local.properties`（參考 `local.properties.example`）：
   ```
   SUPABASE_URL=https://your-project.supabase.co
   SUPABASE_ANON_KEY=your-anon-key
   # 必須填 Web OAuth client ID（不是 Android client ID）
   GOOGLE_CLIENT_ID=xxx-yyy.apps.googleusercontent.com
   WEB_API_BASE_URL=https://your-app.vercel.app
   ```
   - `GOOGLE_CLIENT_ID` 在 Google Cloud Console → APIs & Services → Credentials → **Web client**（`requestIdToken` 需要）
   - `WEB_API_BASE_URL` 是 Vercel 部署後的 URL，本機測試時改為 `http://10.0.2.2:3000`（模擬器）
3. 在裝置或模擬器上執行（API 26+）

## 如何使用

1. **登入** — 使用 Google 帳號登入，系統自動在 Google Drive 建立 `Apps/LLM Wiki/` 資料夾結構
2. **設定 LLM Profile** — 前往設定頁，新增 OpenAI-compatible endpoint（OpenRouter、OpenAI、本地 Ollama 等）
3. **Ingest 來源** — 在右側面板貼上 URL、純文字或 Markdown，點「整合」，LLM 自動更新 wiki 頁面
4. **查詢 Wiki** — 在對話欄輸入問題，回答底部顯示引用頁面，可一鍵存成 Synthesis 頁面
5. **瀏覽 Wiki** — 左側頁面樹瀏覽知識頁與筆記，鎖定圖示可防止 LLM 覆寫特定頁面
6. **搜尋** — 頂列 Search 按鈕展開搜尋框，輸入 2 字元以上自動全文搜尋，點擊結果直接跳轉
7. **知識圖譜** — 頂列 GitFork 按鈕開啟力導向圖視圖：
   - 每個圓點代表一個頁面（紫色 = 目前頁面、藍色 = entity、綠色 = concept、琥珀色 = synthesis、灰色 = 其他）
   - 連線代表頁面間的 `[[wikilink]]` 引用關係；中心密集區 = wiki 核心知識群
   - 四周孤立的灰點 = 尚未被引用的孤立頁面，可作為「待整合」清單
   - 點任一節點可直接跳轉至該頁面
8. **Wiki 健康檢查** — 頂列燒杯按鈕觸發 LLM 健檢：
   - LLM 從 `index.md` 出發，最多執行 20 個步驟巡視整個 wiki
   - 自動偵測並修復：孤立頁面、斷連 wikilink、概念重疊、缺漏交叉引用等問題
   - 完成後自動跳轉至當日 lint 報告（`_lint/YYYY-MM-DD.md`），列出所有發現與修正
   - 可透過設定頁編輯 `_schema/lint.md` 自訂健檢規則
9. **批次匯入** — 拖曳或多選 `.md` / `.txt` 檔案到對話輸入框，即可批次上傳
10. **理解頁面分工** — `wiki/` 是 LLM 維護的知識頁；`notes/` 是你自己寫的筆記；`_schema/` 是設定內的規則檔
11. **管理筆記** — Web 與 Android 都可新增、重新命名、刪除 `notes/*.md` 頁面，並用內建 Markdown 工具列編輯
12. **編輯規則** — 規則入口已搬到設定頁；若 `_schema/*.md` 仍是預設模板，切換語言時會跟著本地化
13. **調整工作區順序** — Web 可直接拖移排序，Android 可在工作區選單調整上下順序

## 貢獻

請參考 [CONTRIBUTING.md](CONTRIBUTING.md) 了解開發環境設定、專案結構與 PR 規範。

## 授權

MIT
