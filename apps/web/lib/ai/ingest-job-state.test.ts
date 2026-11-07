import { describe, expect, it } from 'bun:test';
import {
  failureUpdate,
  isDeadRunning,
  nextAttemptCount,
  transitionIngestJob,
} from './ingest-job-state';

describe('ingest job state transitions', () => {
  it('allows only the requested cooperative transitions', () => {
    expect(transitionIngestJob('pending', 'pause')).toEqual({ ok: true, status: 'paused' });
    expect(transitionIngestJob('running', 'pause')).toEqual({ ok: true, status: 'paused' });
    expect(transitionIngestJob('paused', 'resume')).toEqual({ ok: true, status: 'pending' });
    expect(transitionIngestJob('failed', 'retry')).toEqual({ ok: true, status: 'pending' });
    expect(transitionIngestJob('done', 'retry')).toEqual({ ok: false, code: 'INVALID_INGEST_JOB_STATE' });
  });

  it('does not include progress fields in a failure update', () => {
    const update = failureUpdate('provider failed', '2026-09-01T00:00:00.000Z');
    expect(update).toEqual({
      status: 'failed',
      error: 'provider failed',
      finished_at: '2026-09-01T00:00:00.000Z',
    });
    expect(update).not.toHaveProperty('checkpoint');
    expect(update).not.toHaveProperty('touched_pages');
  });

  it('treats a run past the invocation lease as dead', () => {
    const now = Date.parse('2026-09-01T12:00:00.000Z');
    expect(isDeadRunning('running', '2026-09-01T11:54:29.000Z', now)).toBe(true);
    expect(isDeadRunning('running', '2026-09-01T11:54:31.000Z', now)).toBe(false);
    expect(isDeadRunning('pending', '2026-09-01T00:00:00.000Z', now)).toBe(false);
  });

  it('lets a waiting job be retried right away', () => {
    expect(transitionIngestJob('pending', 'retry')).toEqual({ ok: true, status: 'pending' });
  });

  it('increments malformed attempt counts from zero', () => {
    expect(nextAttemptCount(undefined)).toBe(1);
    expect(nextAttemptCount('not-a-number')).toBe(1);
    expect(nextAttemptCount(4)).toBe(5);
  });
});
