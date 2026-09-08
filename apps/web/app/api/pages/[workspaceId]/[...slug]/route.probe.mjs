import { mock } from 'bun:test';
import { DriveReadError } from '@/lib/drive/errors';

const mode = process.argv[2];
const oldPage = {
  slug: 'entities/page.md',
  title: 'Page',
  kind: 'entity',
  zone: 'wiki',
  drive_file_id: 'old-file',
  updated_by: 'llm',
  locked_by_human: false,
  version: 1,
};
const replacementPage = { ...oldPage, drive_file_id: 'new-file', version: 2 };
const builder = {
  select() { return builder; },
  eq() { return builder; },
  single: async () => ({ data: oldPage, error: null }),
  maybeSingle: async () => ({ data: mode === 'replace' ? replacementPage : oldPage, error: null }),
};

mock.module('@/lib/supabase/request', () => ({
  getRequestUser: async () => ({ supabase: { from: () => builder }, user: { id: 'user-1' } }),
}));
mock.module('@/lib/google/drive-auth', () => ({
  createDriveClientForUser: async () => ({}),
  GOOGLE_DRIVE_REAUTH_MESSAGE: 'Reconnect Google Drive required',
  isGoogleDriveAuthError: () => false,
}));
mock.module('@/lib/drive/client', () => ({
  readDriveFile: async (_drive, fileId) => {
    if (fileId === 'old-file') {
      throw new DriveReadError('DRIVE_FILE_TRASHED', 410, 'Drive file is trashed');
    }
    return '# Replacement';
  },
  writeDriveFile: async () => 'unused',
}));

const { GET } = await import('./route');
const response = await GET(
  new Request('https://example.test/api/pages/ws/entities/page.md'),
  { params: Promise.resolve({ workspaceId: 'ws', slug: ['entities', 'page.md'] }) },
);
console.log(JSON.stringify({ status: response.status, etag: response.headers.get('etag'), body: await response.json() }));
