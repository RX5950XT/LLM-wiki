import { describe, expect, it } from 'bun:test';
import { isLiveIntake } from './ingest-intake';

describe('isLiveIntake', () => {
  const now = Date.parse('2026-11-07T12:00:00Z');
  const job = (status: string, started_at: string | null, next_attempt_at: string | null) => ({ status, started_at, next_attempt_at });

  it('waits for a run in progress and a job about to start', () => {
    expect(isLiveIntake(job('running', '2026-11-07T11:59:00Z', null), now)).toBe(true);
    expect(isLiveIntake(job('pending', null, null), now)).toBe(true);
    expect(isLiveIntake(job('pending', null, '2026-11-07T12:01:00Z'), now)).toBe(true);
  });

  it('does not wait for a dead run or a job parked until the quota resets', () => {
    expect(isLiveIntake(job('running', '2026-11-07T11:50:00Z', null), now)).toBe(false);
    expect(isLiveIntake(job('pending', null, '2026-11-08T04:53:00Z'), now)).toBe(false);
  });
});
