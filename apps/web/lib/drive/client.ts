import { google } from 'googleapis';
import type { drive_v3 } from 'googleapis';
import { getRequiredEnv } from '@/lib/env';
import { DriveReadError } from '@/lib/drive/errors';

/** Build a Drive v3 client authenticated with a short-lived access token. */
export function createDriveClient(accessToken: string): drive_v3.Drive {
  const auth = new google.auth.OAuth2(
    getRequiredEnv('GOOGLE_OAUTH_CLIENT_ID'),
    getRequiredEnv('GOOGLE_OAUTH_CLIENT_SECRET'),
  );
  auth.setCredentials({ access_token: accessToken });
  return google.drive({ version: 'v3', auth });
}

/**
 * Exchange a long-lived refresh token for a new access token.
 * Used by server-side ingest jobs that run after the user session has expired.
 */
export async function getAccessToken(refreshToken: string): Promise<string> {
  const oauth2Client = new google.auth.OAuth2(
    getRequiredEnv('GOOGLE_OAUTH_CLIENT_ID'),
    getRequiredEnv('GOOGLE_OAUTH_CLIENT_SECRET'),
  );
  oauth2Client.setCredentials({ refresh_token: refreshToken });
  const { credentials } = await oauth2Client.refreshAccessToken();
  if (!credentials.access_token) throw new Error('Failed to obtain Google access token');
  return credentials.access_token;
}

/** Read a file's full text content from Drive. */
export async function readDriveFile(
  drive: drive_v3.Drive,
  fileId: string,
): Promise<string> {
  const meta = await getDriveFileMetadata(drive, fileId);

  if (meta.trashed) {
    throw new DriveReadError(
      'DRIVE_FILE_TRASHED',
      410,
      'Drive file is trashed',
      {},
      { fileId },
    );
  }

  switch (meta.mimeType) {
    case 'text/markdown':
    case 'text/plain':
      return readMediaAsText(drive, fileId, meta.mimeType);
    case 'application/octet-stream':
      return readOctetStreamWithGuard(drive, fileId, Number(meta.size ?? 0));
    case 'application/vnd.google-apps.document':
      if (process.env.NODE_ENV !== 'production') {
        console.warn('[Drive] Google Docs detected; exporting as text/plain', {
          fileId,
          size: meta.size,
        });
      }
      return exportGoogleDocAsText(drive, fileId);
    default:
      throw new DriveReadError(
        'UNSUPPORTED_MIME_TYPE',
        415,
        'Unsupported Drive MIME type',
        {},
        { fileId, mimeType: meta.mimeType },
      );
  }
}

/** Create or overwrite a markdown file in Drive. */
export async function writeDriveFile(
  drive: drive_v3.Drive,
  content: string,
  opts: { fileId?: string; name: string; parentId: string },
): Promise<string> {
  const { Readable } = await import('stream');
  const media = { mimeType: 'text/markdown', body: Readable.from(content) };

  if (opts.fileId) {
    const res = await drive.files.update({
      fileId: opts.fileId,
      media,
      fields: 'id',
    });
    return res.data.id!;
  }

  const res = await drive.files.create({
    requestBody: { name: opts.name, mimeType: 'text/markdown', parents: [opts.parentId] },
    media,
    fields: 'id',
  });
  return res.data.id!;
}

/** Find a file by name within a parent folder, or null if not found. */
export async function findFile(
  drive: drive_v3.Drive,
  name: string,
  parentId: string,
  mimeType?: string,
): Promise<string | null> {
  const mime = mimeType ?? 'text/markdown';
  // Escape single quotes to prevent Drive query injection
  const safeName = name.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
  const q = `name='${safeName}' and '${parentId}' in parents and mimeType='${mime}' and trashed=false`;
  const res = await drive.files.list({ q, fields: 'files(id)', pageSize: 1 });
  return res.data.files?.[0]?.id ?? null;
}

/**
 * Ensure a sub-folder exists inside a parent; creates it if missing.
 * Returns the folder ID.
 */
export async function ensureFolder(
  drive: drive_v3.Drive,
  name: string,
  parentId: string,
): Promise<string> {
  const existing = await findFile(
    drive,
    name,
    parentId,
    'application/vnd.google-apps.folder',
  );
  if (existing) return existing;

  const res = await drive.files.create({
    requestBody: {
      name,
      mimeType: 'application/vnd.google-apps.folder',
      parents: [parentId],
    },
    fields: 'id',
  });
  return res.data.id!;
}

async function getDriveFileMetadata(
  drive: drive_v3.Drive,
  fileId: string,
): Promise<drive_v3.Schema$File> {
  try {
    const res = await drive.files.get({
      fileId,
      fields: 'id,mimeType,trashed,size',
    });
    return res.data;
  } catch (error) {
    throw mapDriveError(error, fileId, 'metadata');
  }
}

async function readMediaAsText(
  drive: drive_v3.Drive,
  fileId: string,
  mimeType: string,
): Promise<string> {
  try {
    const res = await drive.files.get(
      { fileId, alt: 'media' },
      { responseType: 'text' },
    );
    return coerceToString(res.data, fileId, `media:${mimeType}`);
  } catch (error) {
    throw mapDriveError(error, fileId, `media:${mimeType}`);
  }
}

async function exportGoogleDocAsText(
  drive: drive_v3.Drive,
  fileId: string,
): Promise<string> {
  try {
    const res = await drive.files.export(
      { fileId, mimeType: 'text/plain' },
      { responseType: 'text' },
    );
    return coerceToString(res.data, fileId, 'export:gdoc');
  } catch (error) {
    throw mapDriveError(error, fileId, 'export:gdoc');
  }
}

async function readOctetStreamWithGuard(
  drive: drive_v3.Drive,
  fileId: string,
  size: number,
): Promise<string> {
  if (size > 5 * 1024 * 1024) {
    throw new DriveReadError(
      'UNSUPPORTED_MIME_TYPE',
      415,
      'Binary file too large',
      {},
      { fileId, size },
    );
  }

  const text = await readMediaAsText(drive, fileId, 'application/octet-stream');
  if (looksBinary(text)) {
    throw new DriveReadError(
      'UNSUPPORTED_MIME_TYPE',
      415,
      'Binary content not supported',
      {},
      { fileId, mimeType: 'application/octet-stream', reason: 'binary-detected' },
    );
  }
  return text;
}

function coerceToString(data: unknown, fileId: string, source: string): string {
  if (typeof data === 'string') return data;
  if (data == null) {
    throw new DriveReadError(
      'EMPTY_DRIVE_RESPONSE',
      502,
      'Drive returned empty response',
      {},
      { fileId, source },
    );
  }
  if (Buffer.isBuffer(data)) return data.toString('utf8');
  if (typeof (data as { pipe?: unknown }).pipe === 'function') {
    throw new DriveReadError(
      'EMPTY_DRIVE_RESPONSE',
      502,
      'Drive returned stream when text expected',
      {},
      { fileId, source },
    );
  }
  throw new DriveReadError(
    'EMPTY_DRIVE_RESPONSE',
    502,
    'Drive returned unexpected response type',
    {},
    { fileId, source, dataType: typeof data },
  );
}

function looksBinary(text: string): boolean {
  const sample = text.slice(0, 4096);
  let nonPrintable = 0;
  for (let index = 0; index < sample.length; index += 1) {
    const code = sample.charCodeAt(index);
    if (code === 0) return true;
    if (code < 0x09 || (code > 0x0d && code < 0x20)) nonPrintable += 1;
  }
  return nonPrintable / Math.max(sample.length, 1) > 0.1;
}

function mapDriveError(error: unknown, fileId: string, source: string): Error {
  if (error instanceof DriveReadError) return error;

  const status =
    (error as { code?: number }).code ??
    (error as { response?: { status?: number } }).response?.status;

  if (status === 404) {
    return new DriveReadError(
      'DRIVE_FILE_NOT_FOUND',
      404,
      'Drive file not found',
      {},
      { fileId, source },
    );
  }
  if (status === 403) {
    return new DriveReadError(
      'DRIVE_PERMISSION_DENIED',
      403,
      'Permission denied',
      {},
      { fileId, source },
    );
  }
  if (status === 401) {
    return new DriveReadError(
      'DRIVE_RECONNECT_REQUIRED',
      403,
      'Reconnect Google Drive required',
      { reconnectRequired: true },
      { fileId, source },
    );
  }
  if (status === 429) {
    return new DriveReadError(
      'DRIVE_RATE_LIMITED',
      429,
      'Drive rate limit reached',
      {},
      { fileId, source },
    );
  }

  return error instanceof Error ? error : new Error('Unknown Drive error');
}
