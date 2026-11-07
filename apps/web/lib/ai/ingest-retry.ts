import { APICallError, NoObjectGeneratedError, RetryError } from 'ai';
import { isGoogleDriveAuthError } from '@/lib/google/drive-auth';
import { FIRST_DATA_TIMEOUT_MESSAGE } from './client';

/**
 * Vercel kills an invocation at 300s without running any cleanup, so a job still
 * `running` past this cannot have a live runner.
 */
export const RUNNER_LEASE_MS = 330_000;

/** Waits between automatic retries; one more failure after the last ends the job. */
const RETRY_BACKOFF_MINUTES = [1, 3, 10, 30, 60, 120] as const;
export const MAX_AUTO_RETRIES = RETRY_BACKOFF_MINUTES.length;

/** Gives a run that overran its budget time to die before the next one starts. */
const CONTINUE_DELAY_MS = 30_000;
const NO_PAGES_MESSAGE = 'The model wrote no pages for this source.';
export const USAGE_LIMIT_MESSAGE = 'Model usage limit reached.';
export const OUT_OF_TIME_MESSAGE = 'Ingest ran out of time.';

/** The source itself cannot be imported; retrying without a change will not help. */
export class IntakeRejectedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'IntakeRejectedError';
  }
}

export type IngestFailure =
  /** The model account is out of quota; try again when it resets. */
  | { kind: 'usage_limit'; message: string; resumeAt: number | null }
  /** A run that simply needs another invocation; committed pages are kept. */
  | { kind: 'continue'; message: string }
  /** Provider, network or Drive trouble that normally passes. */
  | { kind: 'transient'; message: string }
  /** Needs the user: bad model id, expired sign-in, unreadable source. */
  | { kind: 'permanent'; message: string };

/** The AI SDK wraps its own exhausted retries; the provider's answer is inside. */
function unwrap(error: unknown): unknown {
  return RetryError.isInstance(error) ? (error.lastError ?? error) : error;
}

function errorBody(error: APICallError): Record<string, unknown> {
  try {
    const parsed = JSON.parse(error.responseBody ?? '') as { error?: unknown };
    return parsed?.error && typeof parsed.error === 'object' ? (parsed.error as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/** Codex: `{ type: 'usage_limit_reached', resets_at, resets_in_seconds }`. */
function usageLimitResume(error: APICallError, now: number): { resumeAt: number | null } | null {
  if (error.statusCode !== 429) return null;
  const body = errorBody(error);
  const type = typeof body.type === 'string' ? body.type : '';
  if (!/usage_limit/i.test(type) && !/usage limit/i.test(error.message)) return null;
  if (typeof body.resets_at === 'number') return { resumeAt: body.resets_at * 1000 };
  if (typeof body.resets_in_seconds === 'number') return { resumeAt: now + body.resets_in_seconds * 1000 };
  return { resumeAt: null };
}

function isChatGPTSignInError(error: unknown): boolean {
  return error instanceof Error && error.name === 'ChatGPTAuthError';
}

/** Public job-row text: the provider's message only, never its URL/body/keys. */
export function publicIngestError(raw: unknown): string {
  const error = unwrap(raw);
  const message = error instanceof Error ? error.message : '';
  if (error instanceof IntakeRejectedError) return message;
  if (isChatGPTSignInError(error)) return message;
  if (message === NO_PAGES_MESSAGE) return message;
  if (message === 'SUSPECTED_TRUNCATION') return message;
  if (message.startsWith('Ingest ran out of time')) return message;
  if (message === FIRST_DATA_TIMEOUT_MESSAGE) return message;
  // A non-streaming call (plan/review) that hit the whole-request cap is the same stall.
  if (error instanceof Error && error.name === 'TimeoutError') return FIRST_DATA_TIMEOUT_MESSAGE;
  if (message.startsWith('Ingest review incomplete')) return 'Ingest review incomplete';
  if (message.startsWith('Invalid ingest target page slug')) return 'Ingest plan contains an invalid page target';
  if (message.startsWith('Ingest plan exceeds')) return 'Ingest plan contains too many page targets';
  if (/No LLM profile configured/i.test(message)) return 'No LLM profile configured';
  if (isGoogleDriveAuthError(error) || /Google Drive.*(authori[sz]|reauthor|access)/i.test(message)) {
    return 'Google Drive authorization required';
  }
  // A bad model id or provider outage fails every retry identically. Showing the
  // provider's own words is the only way the user can tell retrying is pointless.
  if (APICallError.isInstance(error)) {
    if (usageLimitResume(error, Date.now())) return USAGE_LIMIT_MESSAGE;
    const status = error.statusCode ? ` (${error.statusCode})` : '';
    return `Model call failed${status}: ${message.slice(0, 200)}`;
  }
  return 'Ingest failed';
}

export function classifyIngestFailure(raw: unknown, now = Date.now()): IngestFailure {
  const error = unwrap(raw);
  const message = publicIngestError(error);

  if (APICallError.isInstance(error)) {
    const usage = usageLimitResume(error, now);
    if (usage) return { kind: 'usage_limit', message, resumeAt: usage.resumeAt };
    const status = error.statusCode ?? 0;
    // insufficient_quota is a 429 that no amount of waiting fixes.
    if (status === 429 && errorBody(error).type !== 'insufficient_quota') return { kind: 'transient', message };
    if (status >= 400 && status < 500 && status !== 408 && status !== 409 && status !== 425) {
      return { kind: 'permanent', message };
    }
    return { kind: 'transient', message };
  }
  if (error instanceof IntakeRejectedError || isChatGPTSignInError(error) || isGoogleDriveAuthError(error)) {
    return { kind: 'permanent', message };
  }
  if (message === 'No LLM profile configured' || message === 'Google Drive authorization required') {
    return { kind: 'permanent', message };
  }
  if (error instanceof Error && error.message.startsWith('Ingest ran out of time')) {
    return { kind: 'continue', message };
  }
  // Everything else (a bad model reply, a Drive or database hiccup) is worth another run.
  if (NoObjectGeneratedError.isInstance(error)) return { kind: 'transient', message };
  return { kind: 'transient', message };
}

/** True when another model call right now cannot succeed, so the caller should stop and let the job wait. */
export function isModelUnavailable(raw: unknown): boolean {
  const failure = classifyIngestFailure(raw);
  return failure.kind === 'usage_limit' || failure.kind === 'permanent';
}

export type RetryDecision =
  | {
      requeue: true;
      message: string;
      waitReason: 'usage_limit' | 'retry' | 'continue';
      nextAttemptAt: string;
      retryCount: number;
    }
  | { requeue: false; message: string };

/**
 * What to do with an attempt that did not finish. `retryCount` only counts runs
 * without progress: the pipeline resets it whenever a page commits, so a large
 * source can take as many invocations as it needs.
 */
export function decideRetry(failure: IngestFailure, retryCount: number, now = Date.now()): RetryDecision {
  if (failure.kind === 'permanent') return { requeue: false, message: failure.message };
  const nextCount = retryCount + 1;
  const backoffMs = (RETRY_BACKOFF_MINUTES[retryCount] ?? 0) * 60_000;

  if (failure.kind === 'usage_limit') {
    // Waiting out a quota window is not a failed run, so it never uses up the retries.
    const resumeAt = failure.resumeAt && failure.resumeAt > now ? failure.resumeAt : now + 60 * 60_000;
    return {
      requeue: true,
      message: failure.message,
      waitReason: 'usage_limit',
      nextAttemptAt: new Date(resumeAt).toISOString(),
      retryCount,
    };
  }
  if (nextCount > MAX_AUTO_RETRIES) return { requeue: false, message: failure.message };
  if (failure.kind === 'continue') {
    return {
      requeue: true,
      message: failure.message,
      waitReason: 'continue',
      nextAttemptAt: new Date(now + CONTINUE_DELAY_MS).toISOString(),
      retryCount: nextCount,
    };
  }
  return {
    requeue: true,
    message: failure.message,
    waitReason: 'retry',
    nextAttemptAt: new Date(now + backoffMs).toISOString(),
    retryCount: nextCount,
  };
}
