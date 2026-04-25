import { google } from 'googleapis';
import type { drive_v3 } from 'googleapis';

/** Build a Drive v3 client authenticated with a short-lived access token. */
export function createDriveClient(accessToken: string): drive_v3.Drive {
  const auth = new google.auth.OAuth2(
    process.env.GOOGLE_OAUTH_CLIENT_ID,
    process.env.GOOGLE_OAUTH_CLIENT_SECRET,
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
    process.env.GOOGLE_OAUTH_CLIENT_ID,
    process.env.GOOGLE_OAUTH_CLIENT_SECRET,
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
  const res = await drive.files.get(
    { fileId, alt: 'media' },
    { responseType: 'text' },
  );
  return res.data as unknown as string;
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
  const q = `name='${name}' and '${parentId}' in parents and mimeType='${mime}' and trashed=false`;
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
