import { describe, expect, it } from 'bun:test';
import { readDriveFile } from './client';
import { DriveReadError } from './errors';

function driveForStream(chunks: Buffer[]) {
  let destroyed = false;
  const drive = {
    files: {
      get: async (params: { fields?: string }) => {
        if (params.fields) return { data: { mimeType: 'text/plain', trashed: false } };
        const stream = {
          destroy: () => {
            destroyed = true;
          },
          async *[Symbol.asyncIterator]() {
            for (const chunk of chunks) {
              if (destroyed) return;
              yield chunk;
            }
          },
        };
        return { data: stream };
      },
    },
  };
  return { drive, wasDestroyed: () => destroyed };
}

describe('readDriveFile bounded reads', () => {
  it('destroys a Drive stream immediately after the byte limit is crossed', async () => {
    const fixture = driveForStream([Buffer.from('123'), Buffer.from('456')]);

    await expect(readDriveFile(fixture.drive as never, 'file-id', { maxBytes: 5 })).rejects.toMatchObject({
      code: 'DRIVE_FILE_TOO_LARGE',
      statusCode: 413,
    } satisfies Partial<DriveReadError>);
    expect(fixture.wasDestroyed()).toBe(true);
  });

  it('keeps bounded content when the stream fits', async () => {
    const fixture = driveForStream([Buffer.from('123'), Buffer.from('456')]);
    await expect(readDriveFile(fixture.drive as never, 'file-id', { maxBytes: 6 })).resolves.toBe('123456');
    expect(fixture.wasDestroyed()).toBe(false);
  });

  it('bounds Google Docs export streams too', async () => {
    let destroyed = false;
    const drive = {
      files: {
        get: async () => ({ data: { mimeType: 'application/vnd.google-apps.document', trashed: false } }),
        export: async () => ({
          data: {
            destroy: () => {
              destroyed = true;
            },
            async *[Symbol.asyncIterator]() {
              yield Buffer.from('123');
              yield Buffer.from('456');
            },
          },
        }),
      },
    };

    await expect(readDriveFile(drive as never, 'doc-id', { maxBytes: 5 })).rejects.toMatchObject({
      code: 'DRIVE_FILE_TOO_LARGE',
    });
    expect(destroyed).toBe(true);
  });
});
