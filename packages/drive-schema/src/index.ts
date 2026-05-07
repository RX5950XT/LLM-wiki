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

## How to edit

Notes can be edited directly in the app with a simple Markdown editor.

## How notes differ from the wiki

- \`wiki/\`: LLM-maintained knowledge pages
- \`notes/\`: Your own personal notes
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

## 如何編輯

現在可以直接在 App 內用簡單的 Markdown 編輯器修改筆記。

## 與 Wiki 的差別

- \`wiki/\`：由 LLM 維護的知識頁
- \`notes/\`：由你維護的個人筆記
- \`_schema/\`：控制 LLM 行為的規則與提示詞
`;
}

export const INITIAL_INDEX_CONTENT = getInitialIndexContent('zh-TW');
export const INITIAL_LOG_CONTENT = getInitialLogContent('zh-TW');
export const INITIAL_NOTES_GUIDE_CONTENT = getInitialNotesGuideContent('zh-TW');
