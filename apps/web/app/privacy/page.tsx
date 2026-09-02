import type { Metadata } from 'next';

export const metadata: Metadata = {
  title: '隱私權政策 — LLM Wiki',
  description: 'LLM Wiki 如何處理你的 Google 帳號、Google Drive 內容與 API 金鑰',
};

const sections: Array<{ heading: string; body: string[] }> = [
  {
    heading: '我們存取什麼',
    body: [
      'Google 帳號的 email 與名稱：用來辨識你的帳號並隔離你的資料。',
      'Google Drive（drive.file 權限）：只能看到本服務自己建立的檔案，你 Drive 內的其他檔案一律看不到。你的 wiki 內容存放在你自己的 Drive。',
      '你自行填入的 LLM API 金鑰：用 AES-256-GCM 加密後儲存，只在替你呼叫模型時解密。',
    ],
  },
  {
    heading: '我們儲存什麼',
    body: [
      '資料庫只保存索引用的中繼資料：頁面路徑、標題、連結關係、搜尋文字與工作階段紀錄。',
      'Google 授權憑證與 API 金鑰以加密形式儲存，不以明文留存，也不會回傳到前端。',
    ],
  },
  {
    heading: '資料會送到哪裡',
    body: [
      '匯入的內容與問題會送到你自己設定的 LLM 供應商（例如 OpenRouter），以產生 wiki 內容。除此之外不提供、不販售、不分享給任何第三方。',
    ],
  },
  {
    heading: '如何刪除',
    body: [
      '刪除工作區會一併移除對應的 Google Drive 資料夾與資料庫紀錄。',
      '你可以隨時到 Google 帳戶的「第三方應用程式」設定撤銷本服務的存取權。',
    ],
  },
  {
    heading: '聯絡方式',
    body: ['nico.94624@gmail.com'],
  },
];

export default function PrivacyPage() {
  return (
    <main className="mx-auto max-w-2xl px-6 py-16">
      <h1 className="text-2xl font-semibold">隱私權政策</h1>
      <p className="mt-2 text-sm opacity-60">最後更新：2026-09-03</p>
      <p className="mt-6 text-sm leading-7">
        LLM Wiki 是個人知識庫工具。內容存在你自己的 Google Drive，模型呼叫用你自己的 API 金鑰。
      </p>
      {sections.map((section) => (
        <section key={section.heading} className="mt-8">
          <h2 className="text-base font-medium">{section.heading}</h2>
          <ul className="mt-2 space-y-2 text-sm leading-7 opacity-80">
            {section.body.map((line) => (
              <li key={line}>{line}</li>
            ))}
          </ul>
        </section>
      ))}
    </main>
  );
}
