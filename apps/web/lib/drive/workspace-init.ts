import {
  APP_ROOT_NAME,
  WIKI_SUBDIRS,
  SPECIAL_PAGES,
  SCHEMA_FILES,
  INITIAL_INDEX_CONTENT,
  INITIAL_LOG_CONTENT,
} from '@llm-wiki/drive-schema';
import { DEFAULT_PROMPTS } from '@llm-wiki/prompts';
import type { drive_v3 } from 'googleapis';
import { writeDriveFile } from './client';

interface InitResult {
  /** The workspace root folder ID in Drive. */
  driveFolderId: string;
  /** File IDs for the seeded pages keyed by slug. */
  pageFileIds: Record<string, string>;
}

async function findOrCreateFolder(
  drive: drive_v3.Drive,
  name: string,
  parentId: string,
): Promise<string> {
  // Drive API query requires escaping single quotes with \'
  const escapedName = name.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
  const q = `name='${escapedName}' and '${parentId}' in parents and mimeType='application/vnd.google-apps.folder' and trashed=false`;
  const res = await drive.files.list({ q, fields: 'files(id)', pageSize: 1 });
  if (res.data.files?.length) return res.data.files[0]?.id ?? '';

  const folder = await drive.files.create({
    requestBody: { name, mimeType: 'application/vnd.google-apps.folder', parents: [parentId] },
    fields: 'id',
  });
  return folder.data.id!;
}

// drive.file scope cannot access 'root' — create at Drive root by omitting parents.
async function findOrCreateRootFolder(
  drive: drive_v3.Drive,
  name: string,
): Promise<string> {
  const escapedName = name.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
  const q = `name='${escapedName}' and mimeType='application/vnd.google-apps.folder' and trashed=false`;
  const res = await drive.files.list({ q, fields: 'files(id)', pageSize: 1 });
  if (res.data.files?.length) return res.data.files[0]?.id ?? '';

  const folder = await drive.files.create({
    requestBody: { name, mimeType: 'application/vnd.google-apps.folder' },
    fields: 'id',
  });
  return folder.data.id!;
}

/**
 * Creates the canonical Drive folder tree for a new workspace and seeds initial files.
 *
 *   My Drive/Apps/LLM Wiki/{workspaceId}/
 *     sources/
 *     wiki/  → index.md, log.md, entities/, concepts/, summaries/, synthesis/, _lint/
 *     notes/
 *     _schema/ → ingest.md, query.md, lint.md
 */
export async function initWorkspaceDrive(
  drive: drive_v3.Drive,
  workspaceId: string,
): Promise<InitResult> {
  // drive.file scope forbids accessing 'root'; create top-level folder without a parent
  // so Drive places it in My Drive automatically.
  const appsId = await findOrCreateRootFolder(drive, 'Apps');
  const appRootId = await findOrCreateFolder(drive, APP_ROOT_NAME, appsId);
  const wsRootId = await findOrCreateFolder(drive, workspaceId, appRootId);

  // Create top-level zones
  await findOrCreateFolder(drive, 'sources', wsRootId);
  const wikiId = await findOrCreateFolder(drive, 'wiki', wsRootId);
  await findOrCreateFolder(drive, 'notes', wsRootId);
  const schemaId = await findOrCreateFolder(drive, '_schema', wsRootId);

  // Create wiki subdirectories
  for (const subdir of WIKI_SUBDIRS) {
    await findOrCreateFolder(drive, subdir, wikiId);
  }

  // Seed wiki/index.md and wiki/log.md
  const pageFileIds: Record<string, string> = {};

  pageFileIds[SPECIAL_PAGES.index] = await writeDriveFile(drive, INITIAL_INDEX_CONTENT, {
    name: SPECIAL_PAGES.index,
    parentId: wikiId,
  });

  pageFileIds[SPECIAL_PAGES.log] = await writeDriveFile(drive, INITIAL_LOG_CONTENT, {
    name: SPECIAL_PAGES.log,
    parentId: wikiId,
  });

  // Seed _schema prompts (user-editable)
  for (const [kind, filename] of Object.entries(SCHEMA_FILES)) {
    const content = DEFAULT_PROMPTS[kind as keyof typeof DEFAULT_PROMPTS];
    await writeDriveFile(drive, content, { name: filename, parentId: schemaId });
  }

  return { driveFolderId: wsRootId, pageFileIds };
}
