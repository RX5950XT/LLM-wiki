import { describe, expect, it } from 'bun:test';

function runProbe(mode: 'responsive' | 'search' | 'maintenance') {
  const result = Bun.spawnSync({
    cmd: [process.execPath, `${import.meta.dir}/workspace-shell.probe.mjs`, mode],
    cwd: process.cwd(),
    timeout: 10_000,
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const stderr = new TextDecoder().decode(result.stderr);
  if (result.exitCode !== 0) throw new Error(stderr || `probe exited ${result.exitCode}`);
  return JSON.parse(new TextDecoder().decode(result.stdout)) as Record<string, unknown>;
}

describe('WorkspaceShell state boundaries', () => {
  it('uses the mobile panel defaults and keeps the manual sidebar toggle', () => {
    expect(runProbe('responsive')).toEqual({
      leftInitiallyOpen: false,
      rightInitiallyOpen: false,
      leftAfterManualToggle: true,
    });
  });

  it('resets the active search row when a new result set arrives', () => {
    expect(runProbe('search')).toEqual({
      requests: ['ab', 'abc'],
      selectedBeforeNewQuery: 'second.md',
      selectedAfterNewQuery: 'only.md',
    });
  });

  it('does not restart maintenance polling after progress state updates', () => {
    expect(runProbe('maintenance')).toEqual({ organizePollCalls: 1 });
  });
});
