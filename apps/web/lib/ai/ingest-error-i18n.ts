import type { UiLocale } from '@llm-wiki/drive-schema';
import { FIRST_DATA_TIMEOUT_MESSAGE } from './client';

/**
 * Job rows keep the English text (logs, tests, any locale); clients get it in the
 * UI language. Unknown messages pass through unchanged.
 */
const ZH_TW: Array<[RegExp, (match: RegExpMatchArray) => string]> = [
  [/^Ingest ran out of time after (\d+) of (\d+) planned pages\./, (m) => `單次執行時間用完：已完成 ${m[1]}/${m[2]} 頁，會自動從這裡接著做。`],
  [/^Ingest ran out of time\./, () => '單次執行時間用完，會自動從已完成的頁面接著做。'],
  [/^Model usage limit reached\.$/, () => '模型額度已用完。'],
  [/^ChatGPT sign-in expired/, () => 'ChatGPT 登入已過期，請到設定頁重新登入。'],
  [/^Stored ChatGPT sign-in is invalid/, () => 'ChatGPT 登入資料無效，請到設定頁重新登入。'],
  [/^The image could not be described\.$/, () => '無法辨識這張圖片。'],
  [/^The document has no readable text\.$/, () => '這份文件沒有可讀取的文字。'],
  [/^The source content could not be found\.$/, () => '找不到來源內容，請重新匯入。'],
  [/^The site refused the request \(HTTP (\d+)\)\./, (m) => `網站拒絕了伺服器的讀取（HTTP ${m[1]}），請改為直接貼上文章內容。`],
  [/^Unable to read content from this URL\./, () => '無法讀取這個網址的內容，請改為直接貼上文章內容。'],
  [/^This URL cannot be imported\.$/, () => '這個網址不允許匯入。'],
  [/^The URL content is too large to import\.$/, () => '網址內容太大，無法匯入。'],
  [/^Model call failed(?: \((\d+)\))?: (.*)$/s, (m) => `模型呼叫失敗${m[1] ? `（${m[1]}）` : ''}：${m[2]}`],
  [/^The model wrote no pages for this source\.$/, () => '模型沒有寫入任何頁面。'],
  [/^SUSPECTED_TRUNCATION$/, () => '偵測到頁面內容被大幅刪減，已拒絕寫入。'],
  [/^Ingest review incomplete$/, () => '匯入複查未通過：有計畫中的頁面沒有寫完。'],
  [/^Ingest plan contains an invalid page target$/, () => '匯入計畫包含無效的頁面。'],
  [/^Ingest plan contains too many page targets$/, () => '匯入計畫的頁面太多。'],
  [/^No LLM profile configured$/, () => '尚未設定模型。'],
  [/^Google Drive authorization required$/, () => '需要重新授權 Google Drive。'],
  [/^Ingest timed out$/, () => '匯入逾時。'],
  [/^Ingest failed$/, () => '匯入失敗。'],
];

export function localizeIngestError(message: string | null, locale: UiLocale): string | null {
  if (!message || locale !== 'zh-TW') return message;
  if (message === FIRST_DATA_TIMEOUT_MESSAGE) return '模型供應商沒有回應（卡住）。請稍後重試，或換一個模型。';
  for (const [pattern, render] of ZH_TW) {
    const match = message.match(pattern);
    if (match) return render(match);
  }
  return message;
}
