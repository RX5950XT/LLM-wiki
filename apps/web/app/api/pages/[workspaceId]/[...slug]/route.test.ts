import { describe, expect, it } from 'bun:test';

function runProbe(mode: 'replace' | 'same') {
  const result = Bun.spawnSync({
    cmd: [process.execPath, `${import.meta.dir}/route.probe.mjs`, mode],
    cwd: process.cwd(),
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const stderr = new TextDecoder().decode(result.stderr);
  if (result.exitCode !== 0) throw new Error(stderr || `probe exited ${result.exitCode}`);
  return JSON.parse(new TextDecoder().decode(result.stdout)) as {
    status: number;
    etag: string | null;
    body: Record<string, unknown>;
  };
}

describe('page GET copy-on-write race', () => {
  it('reloads the replacement pointer after the old Drive file is trashed', () => {
    const result = runProbe('replace');

    expect(result.status).toBe(200);
    expect(result.body).toMatchObject({
      drive_file_id: 'new-file',
      version: 2,
      content: '# Replacement',
    });
    expect(result.etag).toBe('"entities/page.md:2"');
  });

  it('keeps a real trashed-file error when the DB pointer did not change', () => {
    const result = runProbe('same');

    expect(result.status).toBe(410);
    expect(result.body).toMatchObject({ error: { code: 'DRIVE_FILE_TRASHED' } });
  });
});
