import {
  INITIAL_INDEX_CONTENT,
  INITIAL_LOG_CONTENT,
  INITIAL_NOTES_GUIDE_CONTENT,
  SCHEMA_FILES,
} from '@llm-wiki/drive-schema';
import { DEFAULT_PROMPTS } from '@llm-wiki/prompts';
import type { drive_v3 } from 'googleapis';
import { createAdminClient } from '@/lib/supabase/admin';
import { ensureFolder, findFile, readDriveFile, writeDriveFile } from './client';

type PageSeed = {
  slug: string;
  title: string;
  kind: 'index' | 'log' | 'note' | 'schema';
  zone: 'wiki' | 'notes' | 'schema';
  folderName: 'wiki' | 'notes' | '_schema';
  fileName: string;
  content?: string;
  promptKey?: keyof typeof DEFAULT_PROMPTS;
  updatedBy: 'llm' | 'human';
  lockedByHuman: boolean;
};

const SYSTEM_PAGE_SEEDS: PageSeed[] = [
  {
    slug: 'index.md',
    title: 'Wiki 索引',
    kind: 'index',
    zone: 'wiki',
    folderName: 'wiki',
    fileName: 'index.md',
    content: INITIAL_INDEX_CONTENT,
    updatedBy: 'llm',
    lockedByHuman: false,
  },
  {
    slug: 'log.md',
    title: '更新日誌',
    kind: 'log',
    zone: 'wiki',
    folderName: 'wiki',
    fileName: 'log.md',
    content: INITIAL_LOG_CONTENT,
    updatedBy: 'llm',
    lockedByHuman: false,
  },
  {
    slug: 'notes/guide.md',
    title: '筆記使用說明',
    kind: 'note',
    zone: 'notes',
    folderName: 'notes',
    fileName: 'guide.md',
    content: INITIAL_NOTES_GUIDE_CONTENT,
    updatedBy: 'human',
    lockedByHuman: true,
  },
  {
    slug: '_schema/ingest.md',
    title: '匯入規則',
    kind: 'schema',
    zone: 'schema',
    folderName: '_schema',
    fileName: SCHEMA_FILES.ingest,
    promptKey: 'ingest',
    updatedBy: 'human',
    lockedByHuman: true,
  },
  {
    slug: '_schema/query.md',
    title: '查詢規則',
    kind: 'schema',
    zone: 'schema',
    folderName: '_schema',
    fileName: SCHEMA_FILES.query,
    promptKey: 'query',
    updatedBy: 'human',
    lockedByHuman: true,
  },
  {
    slug: '_schema/lint.md',
    title: '健康檢查規則',
    kind: 'schema',
    zone: 'schema',
    folderName: '_schema',
    fileName: SCHEMA_FILES.lint,
    promptKey: 'lint',
    updatedBy: 'human',
    lockedByHuman: true,
  },
];

const LEGACY_DEFAULT_CONTENT: Record<string, string[]> = {
  'index.md': ['# Wiki Index', 'This knowledge base is empty.'],
  'log.md': ['# Change Log', '# Log', 'Chronological record'],
};

async function maybeNormalizeLegacySystemPage(
  drive: drive_v3.Drive,
  fileId: string,
  slug: string,
  content: string,
) {
  const legacyMarkers = LEGACY_DEFAULT_CONTENT[slug];
  if (!legacyMarkers) return;

  const current = await readDriveFile(drive, fileId);
  if (!legacyMarkers.some((marker) => current.includes(marker))) return;

  await writeDriveFile(drive, content, {
    fileId,
    name: slug.split('/').at(-1) ?? slug,
    parentId: '',
  });
}

export async function ensureWorkspaceSystemPages(
  drive: drive_v3.Drive,
  workspaceId: string,
  workspaceRootId: string,
) {
  const admin = createAdminClient();
  const folderIds = {
    wiki: await ensureFolder(drive, 'wiki', workspaceRootId),
    notes: await ensureFolder(drive, 'notes', workspaceRootId),
    _schema: await ensureFolder(drive, '_schema', workspaceRootId),
  } as const;

  const { data: existingPages, error } = await admin
    .from('pages')
    .select('slug, drive_file_id')
    .eq('workspace_id', workspaceId);
  if (error) {
    throw new Error(`Failed to load existing system pages: ${error.message}`);
  }

  const existingMap = new Map(
    (existingPages ?? []).map((page) => [page.slug, page.drive_file_id]),
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
    const existingFileId =
      existingMap.get(seed.slug) ??
      await findFile(drive, seed.fileName, folderId);

    const content = seed.content ?? DEFAULT_PROMPTS[seed.promptKey!];
    const driveFileId =
      existingFileId ??
      await writeDriveFile(drive, content, {
        name: seed.fileName,
        parentId: folderId,
      });

    if (seed.content && existingFileId) {
      await maybeNormalizeLegacySystemPage(drive, driveFileId, seed.slug, content);
    }

    if (!existingMap.has(seed.slug)) {
      rowsToInsert.push({
        workspace_id: workspaceId,
        slug: seed.slug,
        title: seed.title,
        kind: seed.kind,
        zone: seed.zone,
        drive_file_id: driveFileId,
        updated_by: seed.updatedBy,
        locked_by_human: seed.lockedByHuman,
      });
    }
  }

  if (rowsToInsert.length > 0) {
    const { error: insertError } = await admin.from('pages').insert(rowsToInsert);
    if (insertError) {
      throw new Error(`Failed to insert system pages: ${insertError.message}`);
    }
  }
}
