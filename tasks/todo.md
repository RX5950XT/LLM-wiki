# LLM-wiki todo
最後更新：2026-11-27

## 現況（交接）
- Web（Next.js on Vercel）＋ Android 的對話驅動知識庫；功能、架構、建置見 `README.md`，規範、協定與「勿回退」紀錄見 `CLAUDE.md`／`AGENTS.md`。
- 最新 Android：`0.8.9`（versionCode `21`，GitHub Release `v0.8.9`，新增 Grok 登入），簽章與 0.8.6 起相同可覆蓋安裝；README 下載連 `releases/latest`。
- 環境：Supabase production `mjuciqffwayydobpxzcz`（ap-southeast-1）；Vercel 跑 `sin1`、Fluid Compute、無 cron（`vercel.json` 與 `CRON_SECRET` 已於 Phase 16 移除）。
- 匯入持久化（Phase 18）：POST 只存檔回 202，pg_cron `ingest-worker` 每分鐘喚醒 worker，失敗分類＋自動重試；Android 用 WorkManager 上傳。Vault 的 `ingest_worker_url` 是手動寫入，不在 migration 內。
- 預設模型為 OpenRouter `google/gemini-3.8-flash`（走 Google Vertex BYOK，實付 $0；OpenRouter「僅限 BYOK」沒開，Vertex 失敗時理論上會改扣 OpenRouter 餘額）。
- Android 抽屜：工作區名稱下一排「來源／佇列／圖譜／整理」、最底一排「設定／說明／登出」，共用 `DrawerShortcut`；網頁同樣功能放在「更多」選單（刻意不同的只有版面）。
- Grok 登入（2026-11-27）：與 ChatGPT 同契約，`/api/settings/grok`，推論走 `cli-chat-proxy.grok.com` chat completions（真 token 實測工具呼叫可用）。MCP 伺服器 `/api/mcp`（唯讀、Bearer 權杖、`mcp_tokens` 已套用 production），權杖管理 Web-only。細節見 CLAUDE.md。
- 同步：沒有手動同步，`syncIfChanged` 在前景每 30 秒、回前景、對話結束時查 revision；開頁用 ETag 條件請求。

## 關鍵決策
- 機械判斷交給程式、語意判斷交給模型（掃空工作區、找重複、死連結清單都由程式先算好再給模型）。
- 維護（整理知識庫）是單一 pipeline、單一按鈕；模型拿不到 `deleteWorkspace`；不產生報告頁。
- 匯入是加法：ingest 固定 `confirmDestructive: true`，不刪頁；去重交給維護。
- Drive → DB → `page_links` 不是單一交易，靠新檔＋DB version／lock CAS＋補償降低衝突與孤兒。
- ChatGPT 暫緩（使用者決定）：`strict:false` 驗證先不做，OpenRouter 設定不動。
- production migration history 只記到 0010（0004／0005／0011 是手動套用），不要整批 `db push`。

## 測試陷阱
- `GET /api/ingest` 也會啟動到期的 job：測 cron 時只要有 client 開著，任務可能是 client 推動的，要看 `net._http_response` 才算數。
- 暫停 intake 擋不住 Drive 寫入（`runIntake` 寫來源檔前不檢查 job 狀態）。要清得乾淨的測試請用解析必敗的網址（如 `https://x.invalid/`），不碰 Drive、不花模型費用。
- 測批次匯入開新工作區前，先確認工作區數量低於 12（`MAX_AUTO_WORKSPACES`），否則不會開新工作區，測試會假通過。
- PDF 要用真檔測：假 PDF 的失敗訊息剛好一樣，曾蓋住 production 全部 PDF 解析失敗的 bug。
- 實機自動化腳本每一步都要先確認 App 在前景（曾有腳本在 App 退出後繼續在桌面滑 10 分鐘）。
- 右邊緣約 105px 是系統返回手勢區，從那裡慢拖會關抽屜，屬系統行為。
- Android `assembleDebug` 偶爾 `checkDebugAarMetadata` 的 Gradle 快取搬移失敗（`Could not move temporary workspace`），與程式無關，重跑即過。
- 查 DB 一定要按 `owner_id` 過濾（另外兩個空的「My Wiki」屬於別的帳號，不是 bug）。

## 待辦
- [ ] Grok token 自動續期（access token 6 小時）尚未實際發生過；2026-11-27 已在 production 用真帳號完成 device code 登入並建立 profile。若續期失敗，設定頁會顯示「Grok 登入已失效」。
- [ ] （暫緩）ChatGPT 額度重置後確認 `strict:false` 真的解決 0 頁：job `a45d5c4f-b5f5-4ec0-86bc-52066137cf7a` 看 `touched_pages`，仍 0 頁就讀 `checkpoint.diagnostics`。
- [ ] 手機接電腦一直響（Windows 裝置連線音，手機確實反覆斷線）：已排除「每小時固定斷線」；靜置時不斷線，多數疑似手拿時接頭晃動，「充飽才斷」只有一次反例未證實。`+cellular_high_tx_power` 與斷線重合不是證據，別再走這條。
- [ ] Drive 留有兩個測試殘檔待刪：`187pJPuE1lxXzPMsQoZH_ynuBIucQJGjI`（沒被任何資料列引用）、`1c9vSDFgDVc5vzR3QY6ZpI9_26GD7OAgB`（離線重送測試留下的 AI/sources 來源檔）。

## 已知問題／刻意不處理
- Android `lintDebug` 既有 3 個 Error：`DriveClient.kt:33`、`DriveReconnect.kt:20`（NewApi）、`GraphView.kt:201`（produceState）。
- Web lint 剩 38 warnings（37 個刻意保留的診斷 console、1 個 export 格式）；build 有既有 `experimental.turbo` warning。
- next-intl 不升 v4（大遷移，接受現狀）；build 工具鏈 3 個 high 不進 runtime。
- Supabase advisor「Leaked Password Protection」需手動在 Dashboard 開；只用 Google OAuth，不影響。
- 矛盾（contradiction）只記在 `log.md`，沒有專門 UI。
- Web／Android 小差異沒改：網頁頁首有「AI／使用者」標記、網頁編輯器有格式工具列、網頁有「此頁面已更新」橫幅（手機靠自動同步＋ETag）。
- 掃描檔與 Web 上傳 PDF 在 production 只部分實測；桌面版真實輸入法（注音選字時按 Enter）沒測過，只有手機實測與桌面模擬事件。
- 大檔競態修正（`next_attempt_at`）只做過低強度測試（輪詢 2 次）。
- Android 0.8.6 離線橫幅新文字沒在真正離線時重測（走同一個 `ingestLoading` 狀態）。

## 驗證指令
```bash
bun run typecheck && bun run test && bun run build
cd apps/android && ./gradlew.bat :app:assembleDebug :app:testDebugUnitTest
```
