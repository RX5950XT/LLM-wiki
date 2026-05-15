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

export const SUPPORTED_UI_LOCALES = ['zh-TW', 'en'] as const;
export type UiLocale = (typeof SUPPORTED_UI_LOCALES)[number];

export function normalizeUiLocale(locale?: string | null): UiLocale {
  const value = (locale ?? '').trim().toLowerCase();
  return value.startsWith('en') ? 'en' : 'zh-TW';
}

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

function resolveCreatedDate(createdAt?: string): string {
  return createdAt ?? new Date().toISOString().slice(0, 10);
}

export function parseCreatedDate(content: string): string | null {
  const match = content.match(/^created:\s*([0-9]{4}-[0-9]{2}-[0-9]{2})$/m);
  return match?.[1] ?? null;
}

export function getSystemPageTitle(
  key: 'index' | 'log' | 'notes-guide' | 'schema-ingest' | 'schema-query' | 'schema-lint',
  locale?: string | null,
): string {
  const normalized = normalizeUiLocale(locale);
  const table: Record<UiLocale, Record<typeof key, string>> = {
    'zh-TW': {
      index: 'Wiki 索引',
      log: '更新日誌',
      'notes-guide': '筆記使用說明',
      'schema-ingest': '匯入規則',
      'schema-query': '查詢規則',
      'schema-lint': '健康檢查規則',
    },
    en: {
      index: 'Wiki Index',
      log: 'Update Log',
      'notes-guide': 'Notes Guide',
      'schema-ingest': 'Ingest Rules',
      'schema-query': 'Query Rules',
      'schema-lint': 'Lint Rules',
    },
  };
  return table[normalized][key];
}

export function getInitialIndexContent(locale?: string | null, createdAt?: string): string {
  const created = resolveCreatedDate(createdAt);
  if (normalizeUiLocale(locale) === 'en') {
    return `---
title: "Wiki Index"
kind: index
created: ${created}
---

# Wiki Index

This wiki is still empty. Add a source from the right panel to start building it.

## Entities

## Concepts

## Summaries

## Synthesis
`;
  }

  return `---
title: "Wiki 索引"
kind: index
created: ${created}
---

# Wiki 索引

此知識庫尚無內容。請在右側面板新增來源，開始建立你的 Wiki。

## 實體

## 概念

## 摘要

## 綜合
`;
}

export function getInitialLogContent(locale?: string | null, createdAt?: string): string {
  const created = resolveCreatedDate(createdAt);
  if (normalizeUiLocale(locale) === 'en') {
    return `---
title: "Update Log"
kind: log
created: ${created}
---

# Update Log

This page records ingest, chat, and lint activity in chronological order. Append new entries only; do not rewrite history.
`;
  }

  return `---
title: "更新日誌"
kind: log
created: ${created}
---

# 更新日誌

依時間順序記錄每次匯入、對話與健康檢查的結果。僅供追加，不可修改歷史記錄。
`;
}

export function getInitialNotesGuideContent(locale?: string | null, createdAt?: string): string {
  const created = resolveCreatedDate(createdAt);
  if (normalizeUiLocale(locale) === 'en') {
    return `---
title: "Notes Guide"
kind: note
created: ${created}
---

# Notes Guide

The Notes zone is your own writing space. The LLM may read it for context, but it will not edit it.

## What belongs here

- Meeting notes
- Temporary ideas
- Personal judgement
- Drafts that are not ready for the formal wiki

## How to create, rename, and delete notes

In the left sidebar, find the **Notes** section and click **+** to create a new note.
Each custom note shows a pencil (rename) and trash (delete) icon next to its title.
This guide page (notes/guide.md) is a system page and cannot be renamed or deleted.

## How to edit

Click a note to open it, then click the pencil icon in the top-right of the viewer to edit it with a Markdown toolbar.

## The lock icon

Every page has a lock icon in the top-right corner.
- **Locked (filled)**: the LLM will not overwrite this page — safe for personal notes.
- **Unlocked (outlined)**: the LLM may update this page during ingest or health checks.

Click the lock icon to toggle. Notes are locked by default.

## How notes differ from the wiki

- \`wiki/\`: LLM-maintained knowledge pages
- \`notes/\`: Your own personal notes (LLM read-only)
- \`_schema/\`: Rules and prompts that steer the LLM
`;
  }

  return `---
title: "筆記使用說明"
kind: note
created: ${created}
---

# 筆記使用說明

「筆記」區是給你自己寫的內容，LLM 只會讀，不會改。

## 適合放什麼

- 會議紀錄
- 臨時想法
- 個人判斷
- 尚未整理完成的草稿

## 如何新建、重新命名、刪除筆記

在左側欄「筆記」區標題旁，點「+」可新建筆記。
每一個自訂筆記旁邊會顯示鉛筆（重新命名）與垃圾桶（刪除）按鈕。
這份說明頁（notes/guide.md）是系統頁，無法重新命名或刪除。

## 如何編輯

點選筆記開啟後，按右上角的鉛筆按鈕即可用內建 Markdown 工具列編輯。

## 鎖頭是什麼

每個頁面右上角都有一個鎖頭圖示：
- **鎖定（實心鎖）**：LLM 不會覆寫這個頁面，適合個人筆記。
- **未鎖定（空心鎖）**：LLM 在匯入或健康檢查時可能更新這個頁面。

點鎖頭即可切換。筆記預設為鎖定狀態。

## 與 Wiki 的差別

- \`wiki/\`：由 LLM 維護的知識頁
- \`notes/\`：由你維護的個人筆記（LLM 唯讀）
- \`_schema/\`：控制 LLM 行為的規則與提示詞
`;
}

export const INITIAL_INDEX_CONTENT = getInitialIndexContent('zh-TW');
export const INITIAL_LOG_CONTENT = getInitialLogContent('zh-TW');
export const INITIAL_NOTES_GUIDE_CONTENT = getInitialNotesGuideContent('zh-TW');
