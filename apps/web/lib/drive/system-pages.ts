import {
  SCHEMA_FILES,
  getInitialIndexContent,
  getInitialLogContent,
  getInitialNotesGuideContent,
  getSystemPageTitle,
  normalizeUiLocale,
  parseCreatedDate,
  type UiLocale,
} from '@llm-wiki/drive-schema';
import { getDefaultPrompt, type PromptKind } from '@llm-wiki/prompts';
import type { drive_v3 } from 'googleapis';
import { createAdminClient } from '@/lib/supabase/admin';
import { ensureFolder, findFile, readDriveFile, writeDriveFile } from './client';

type PageSeed = {
  key: 'index' | 'log' | 'notes-guide' | 'schema-ingest' | 'schema-query' | 'schema-lint';
  slug: string;
  kind: 'index' | 'log' | 'note' | 'schema';
  zone: 'wiki' | 'notes' | 'schema';
  folderName: 'wiki' | 'notes' | '_schema';
  fileName: string;
  updatedBy: 'llm' | 'human';
  lockedByHuman: boolean;
  promptKind?: PromptKind;
};

const SYSTEM_PAGE_SEEDS: PageSeed[] = [
  {
    key: 'index',
    slug: 'index.md',
    kind: 'index',
    zone: 'wiki',
    folderName: 'wiki',
    fileName: 'index.md',
    updatedBy: 'llm',
    lockedByHuman: false,
  },
  {
    key: 'log',
    slug: 'log.md',
    kind: 'log',
    zone: 'wiki',
    folderName: 'wiki',
    fileName: 'log.md',
    updatedBy: 'llm',
    lockedByHuman: false,
  },
  {
    key: 'notes-guide',
    slug: 'notes/guide.md',
    kind: 'note',
    zone: 'notes',
    folderName: 'notes',
    fileName: 'guide.md',
    updatedBy: 'human',
    lockedByHuman: true,
  },
  {
    key: 'schema-ingest',
    slug: '_schema/ingest.md',
    kind: 'schema',
    zone: 'schema',
    folderName: '_schema',
    fileName: SCHEMA_FILES.ingest,
    updatedBy: 'human',
    lockedByHuman: true,
    promptKind: 'ingest',
  },
  {
    key: 'schema-query',
    slug: '_schema/query.md',
    kind: 'schema',
    zone: 'schema',
    folderName: '_schema',
    fileName: SCHEMA_FILES.query,
    updatedBy: 'human',
    lockedByHuman: true,
    promptKind: 'query',
  },
  {
    key: 'schema-lint',
    slug: '_schema/lint.md',
    kind: 'schema',
    zone: 'schema',
    folderName: '_schema',
    fileName: SCHEMA_FILES.lint,
    updatedBy: 'human',
    lockedByHuman: true,
    promptKind: 'lint',
  },
];

const LEGACY_DEFAULT_CONTENT: Record<string, string[]> = {
  'index.md': ['# Wiki Index', 'This knowledge base is empty.'],
  'log.md': ['# Change Log', '# Log', 'Chronological record'],
};

function buildSeedContent(seed: PageSeed, locale: UiLocale, createdAt?: string): string {
  switch (seed.key) {
    case 'index':
      return getInitialIndexContent(locale, createdAt);
    case 'log':
      return getInitialLogContent(locale, createdAt);
    case 'notes-guide':
      return getInitialNotesGuideContent(locale, createdAt);
    case 'schema-ingest':
    case 'schema-query':
    case 'schema-lint':
      return getDefaultPrompt(seed.promptKind!, locale);
  }
}

function buildSeedTitle(seed: PageSeed, locale: UiLocale): string {
  return getSystemPageTitle(seed.key, locale);
}

function getCandidateContents(seed: PageSeed, currentContent: string): string[] {
  const createdAt = parseCreatedDate(currentContent) ?? undefined;
  const localized = ['zh-TW', 'en'].map((locale) =>
    buildSeedContent(seed, locale as UiLocale, createdAt).trim(),
  );
  return localized;
}

function isKnownDefaultContent(seed: PageSeed, currentContent: string): boolean {
  const trimmed = currentContent.trim();
  if (getCandidateContents(seed, currentContent).includes(trimmed)) return true;
  return (LEGACY_DEFAULT_CONTENT[seed.slug] ?? []).some((marker) => currentContent.includes(marker));
}

function isKnownDefaultTitle(seed: PageSeed, currentTitle?: string | null): boolean {
  if (!currentTitle) return true;
  const titles = ['zh-TW', 'en'].map((locale) => buildSeedTitle(seed, locale as UiLocale));
  return titles.includes(currentTitle);
}

async function maybeLocalizeSystemPage(
  drive: drive_v3.Drive,
  seed: PageSeed,
  fileId: string,
  locale: UiLocale,
) {
  const current = await readDriveFile(drive, fileId);
  if (!isKnownDefaultContent(seed, current)) return false;

  const localized = buildSeedContent(seed, locale, parseCreatedDate(current) ?? undefined);
  if (current.trim() === localized.trim()) return false;

  await writeDriveFile(drive, localized, {
    fileId,
    name: seed.fileName,
    parentId: '',
  });
  return true;
}

type ExistingPageRow = {
  id: string;
  slug: string;
  drive_file_id: string;
  title: string | null;
};

export async function ensureWorkspaceSystemPages(
  drive: drive_v3.Drive,
  workspaceId: string,
  workspaceRootId: string,
  locale?: string | null,
) {
  const normalizedLocale = normalizeUiLocale(locale);
  const admin = createAdminClient();
  const folderIds = {
    wiki: await ensureFolder(drive, 'wiki', workspaceRootId),
    notes: await ensureFolder(drive, 'notes', workspaceRootId),
    _schema: await ensureFolder(drive, '_schema', workspaceRootId),
  } as const;

  const { data: existingPages, error } = await admin
    .from('pages')
    .select('id, slug, drive_file_id, title')
    .eq('workspace_id', workspaceId);
  if (error) {
    throw new Error(`Failed to load existing system pages: ${error.message}`);
  }

  const existingMap = new Map(
    (existingPages ?? []).map((page) => [page.slug, page as ExistingPageRow]),
  );

  const rowsToInsert: Array<{
    workspace_id: string;
    slug: string;
    title: string;
    kind: PageSeed['kind'];
    zone: PageSeed['zone'];
    drive_file_id: string;
    updated_by: PageSeed['updatedBy'];
    locked_by_human: boolean;
  }> = [];

  for (const seed of SYSTEM_PAGE_SEEDS) {
    const folderId = folderIds[seed.folderName];
    const existing = existingMap.get(seed.slug);
    const driveFileId =
      existing?.drive_file_id ??
      await findFile(drive, seed.fileName, folderId) ??
      await writeDriveFile(drive, buildSeedContent(seed, normalizedLocale), {
        name: seed.fileName,
        parentId: folderId,
      });

    const localizedTitle = buildSeedTitle(seed, normalizedLocale);

    if (existing) {
      const localizedContentChanged = await maybeLocalizeSystemPage(
        drive,
        seed,
        driveFileId,
        normalizedLocale,
      );

      if (localizedContentChanged || isKnownDefaultTitle(seed, existing.title)) {
        await admin
          .from('pages')
          .update({ title: localizedTitle })
          .eq('id', existing.id);
      }

      continue;
    }

    rowsToInsert.push({
      workspace_id: workspaceId,
      slug: seed.slug,
      title: localizedTitle,
      kind: seed.kind,
      zone: seed.zone,
      drive_file_id: driveFileId,
      updated_by: seed.updatedBy,
      locked_by_human: seed.lockedByHuman,
    });
  }

  if (rowsToInsert.length > 0) {
    const { error: insertError } = await admin.from('pages').insert(rowsToInsert);
    if (insertError) {
      throw new Error(`Failed to insert system pages: ${insertError.message}`);
    }
  }
}
