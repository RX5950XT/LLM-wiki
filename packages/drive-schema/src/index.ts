/**
 * Canonical Google Drive folder layout for a workspace.
 *
 * Root: My Drive / Apps / LLM Wiki / {workspace-id}
 */

export const APP_ROOT_NAME = 'LLM Wiki';

export const ZONE = {
  wiki: 'wiki',
  notes: 'notes',
  sources: 'sources',
  schema: '_schema',
} as const;

export type ZoneKey = keyof typeof ZONE;
export type ZoneDir = (typeof ZONE)[ZoneKey];

export const WIKI_SUBDIRS = [
  'entities',
  'concepts',
  'summaries',
  'synthesis',
  '_lint',
] as const;

export type WikiSubdir = (typeof WIKI_SUBDIRS)[number];

export const SPECIAL_PAGES = {
  index: 'index.md',
  log: 'log.md',
} as const;

export const SCHEMA_FILES = {
  ingest: 'ingest.md',
  query: 'query.md',
  lint: 'lint.md',
} as const;

/** Build a path inside a workspace folder: e.g. `wiki/entities/karpathy.md`. */
export function workspacePath(zone: ZoneDir, ...segments: string[]): string {
  return [zone, ...segments].filter(Boolean).join('/');
}

/** Slug → full drive path. Slug is zone-less, e.g. `entities/karpathy.md`. */
export function slugToPath(zone: ZoneDir, slug: string): string {
  const normalized = slug.startsWith('/') ? slug.slice(1) : slug;
  return workspacePath(zone, normalized);
}

/** Validate a slug: must be `<subdir>/<name>.md` or a top-level special file. */
export function isValidWikiSlug(slug: string): boolean {
  if (slug === SPECIAL_PAGES.index || slug === SPECIAL_PAGES.log) return true;
  const match = slug.match(/^([a-z_]+)\/([a-z0-9][a-z0-9-]*)\.md$/);
  if (!match) return false;
  const [, sub] = match;
  return (WIKI_SUBDIRS as readonly string[]).includes(sub!);
}

export const INITIAL_INDEX_CONTENT = `---
title: "Wiki 索引"
kind: index
created: ${new Date().toISOString().slice(0, 10)}
---

# Wiki 索引

此知識庫尚無內容。請在右側面板新增來源，開始建立你的 Wiki。

## 實體

## 概念

## 摘要

## 綜合
`;

export const INITIAL_LOG_CONTENT = `---
title: "更新日誌"
kind: log
created: ${new Date().toISOString().slice(0, 10)}
---

# 更新日誌

依時間順序記錄每次匯入、對話與健康檢查的結果。僅供追加，不可修改歷史記錄。
`;

export const INITIAL_NOTES_GUIDE_CONTENT = `---
title: "筆記使用說明"
kind: note
created: ${new Date().toISOString().slice(0, 10)}
---

# 筆記使用說明

「筆記」區是給你自己寫的內容，LLM 只會讀，不會改。

## 適合放什麼

- 會議紀錄
- 臨時想法
- 個人判斷
- 尚未整理完成的草稿

## 如何編輯

目前 App 內不提供直接編輯筆記。

請到你的 Google Drive：

\`Apps / LLM Wiki / 你的工作區 / notes/\`

用 Google Docs、Obsidian、VS Code 或任何 Markdown 編輯器修改。

## 與 Wiki 的差別

- \`wiki/\`：由 LLM 維護的知識頁
- \`notes/\`：由你維護的個人筆記
- \`_schema/\`：控制 LLM 行為的規則與提示詞
`;
