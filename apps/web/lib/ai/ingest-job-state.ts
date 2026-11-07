import type { IngestStatus } from '@llm-wiki/shared-types';

export type IngestJobAction = 'pause' | 'resume' | 'retry';

export const INGEST_JOB_ERROR_CODES = {
  invalidAction: 'INVALID_INGEST_JOB_ACTION',
  invalidTransition: 'INVALID_INGEST_JOB_STATE',
  notFound: 'INGEST_JOB_NOT_FOUND',
  lookupFailed: 'INGEST_JOB_LOOKUP_FAILED',
  updateFailed: 'INGEST_JOB_UPDATE_FAILED',
} as const;

export type IngestJobErrorCode =
  (typeof INGEST_JOB_ERROR_CODES)[keyof typeof INGEST_JOB_ERROR_CODES];

export interface StateTransition {
  ok: true;
  status: IngestStatus;
}

export interface InvalidStateTransition {
  ok: false;
  code: typeof INGEST_JOB_ERROR_CODES.invalidTransition;
}

export function transitionIngestJob(
  status: IngestStatus,
  action: IngestJobAction,
): StateTransition | InvalidStateTransition {
  const next: Partial<Record<IngestJobAction, Partial<Record<IngestStatus, IngestStatus>>>> = {
    pause: { pending: 'paused', running: 'paused' },
    resume: { paused: 'pending' },
    // A job waiting out a retry delay or quota window can be retried right now.
    retry: { failed: 'pending', pending: 'pending' },
  };
  const target = next[action]?.[status];
  return target ? { ok: true, status: target } : { ok: false, code: INGEST_JOB_ERROR_CODES.invalidTransition };
}

/**
 * Keep the failure update deliberately progress-free. The checkpoint and
 * touched_pages already committed by the pipeline must survive provider/Drive
 * errors, including a job that wrote zero pages.
 */
export function failureUpdate(error: string, finishedAt: string): Record<string, string> {
  return { status: 'failed', error, finished_at: finishedAt };
}

export function nextAttemptCount(value: unknown): number {
  const count = Number(value);
  return (Number.isFinite(count) ? Math.max(0, count) : 0) + 1;
}

/** A run cannot outlive its Vercel invocation; past the lease it was killed. */
export function isDeadRunning(
  status: IngestStatus,
  startedAt: string | null | undefined,
  now = Date.now(),
  leaseMs = 330_000,
): boolean {
  if (status !== 'running' || !startedAt) return false;
  const timestamp = Date.parse(startedAt);
  return Number.isFinite(timestamp) && now - timestamp > leaseMs;
}
