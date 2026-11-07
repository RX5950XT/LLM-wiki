import { describe, expect, it } from 'bun:test';
import { APICallError, RetryError } from 'ai';
import {
  classifyIngestFailure,
  decideRetry,
  IntakeRejectedError,
  isModelUnavailable,
  MAX_AUTO_RETRIES,
  publicIngestError,
  USAGE_LIMIT_MESSAGE,
} from './ingest-retry';
import { budgetExhaustedError } from './ingest-pipeline';

const NOW = Date.parse('2026-11-07T07:00:00.000Z');

function apiError(statusCode: number, responseBody = '', message = 'provider said no'): APICallError {
  return new APICallError({
    message,
    url: 'https://chatgpt.com/backend-api/codex/responses',
    requestBodyValues: {},
    statusCode,
    responseBody,
  });
}

const USAGE_LIMIT = apiError(
  429,
  JSON.stringify({
    error: { type: 'usage_limit_reached', message: 'The usage limit has been reached', plan_type: 'plus', resets_at: 1794113606 },
  }),
  'The usage limit has been reached',
);

describe('classifyIngestFailure', () => {
  it('reads the reset time out of a real Codex usage-limit response', () => {
    const failure = classifyIngestFailure(USAGE_LIMIT, NOW);
    expect(failure).toEqual({ kind: 'usage_limit', message: USAGE_LIMIT_MESSAGE, resumeAt: 1794113606 * 1000 });
  });

  it('sees through the wrapper the AI SDK puts around exhausted retries', () => {
    // Before this, an empty quota reached the user as the text "Ingest failed".
    const wrapped = new RetryError({
      message: 'Failed after 3 attempts. Last error: The usage limit has been reached',
      reason: 'maxRetriesExceeded',
      errors: [USAGE_LIMIT, USAGE_LIMIT, USAGE_LIMIT],
    });
    expect(classifyIngestFailure(wrapped, NOW).kind).toBe('usage_limit');
    expect(publicIngestError(wrapped)).toBe(USAGE_LIMIT_MESSAGE);
  });

  it('retries what normally passes and stops on what needs the user', () => {
    expect(classifyIngestFailure(apiError(500), NOW).kind).toBe('transient');
    expect(classifyIngestFailure(apiError(429), NOW).kind).toBe('transient');
    expect(classifyIngestFailure(new Error('socket hang up'), NOW).kind).toBe('transient');
    expect(classifyIngestFailure(new Error('The model wrote no pages for this source.'), NOW).kind).toBe('transient');
    expect(classifyIngestFailure(apiError(404), NOW).kind).toBe('permanent');
    expect(classifyIngestFailure(apiError(402), NOW).kind).toBe('permanent');
    expect(classifyIngestFailure(apiError(429, JSON.stringify({ error: { type: 'insufficient_quota' } })), NOW).kind).toBe('permanent');
    expect(classifyIngestFailure(new IntakeRejectedError('This URL cannot be imported.'), NOW)).toEqual({
      kind: 'permanent',
      message: 'This URL cannot be imported.',
    });
  });

  it('treats an expired ChatGPT sign-in as needing the user, with its own words', () => {
    const error = new Error('ChatGPT sign-in expired (401). Sign in with ChatGPT again in Settings.');
    error.name = 'ChatGPTAuthError';
    expect(classifyIngestFailure(error, NOW)).toEqual({ kind: 'permanent', message: error.message });
  });

  it('calls a run that ran out of time a continuation, not a failure', () => {
    expect(classifyIngestFailure(budgetExhaustedError(4, 9), NOW).kind).toBe('continue');
  });
});

describe('isModelUnavailable', () => {
  it('is true only when another call cannot succeed', () => {
    expect(isModelUnavailable(USAGE_LIMIT)).toBe(true);
    expect(isModelUnavailable(apiError(401))).toBe(true);
    expect(isModelUnavailable(apiError(503))).toBe(false);
    expect(isModelUnavailable(new Error('Provider returned error'))).toBe(false);
  });
});

describe('decideRetry', () => {
  it('waits for the quota window without using up retries', () => {
    const decision = decideRetry({ kind: 'usage_limit', message: 'm', resumeAt: NOW + 3_600_000 }, 5, NOW);
    expect(decision).toMatchObject({ requeue: true, waitReason: 'usage_limit', retryCount: 5 });
    if (decision.requeue) expect(Date.parse(decision.nextAttemptAt)).toBe(NOW + 3_600_000);
  });

  it('does not wait for a reset time already in the past', () => {
    const decision = decideRetry({ kind: 'usage_limit', message: 'm', resumeAt: NOW - 1 }, 0, NOW);
    if (!decision.requeue) throw new Error('expected a requeue');
    expect(Date.parse(decision.nextAttemptAt)).toBeGreaterThan(NOW);
  });

  it('backs off, then gives up with the last reason', () => {
    const first = decideRetry({ kind: 'transient', message: 'm' }, 0, NOW);
    const later = decideRetry({ kind: 'transient', message: 'm' }, 3, NOW);
    if (!first.requeue || !later.requeue) throw new Error('expected requeues');
    expect(Date.parse(first.nextAttemptAt)).toBe(NOW + 60_000);
    expect(Date.parse(later.nextAttemptAt)).toBe(NOW + 30 * 60_000);
    expect(later.retryCount).toBe(4);
    expect(decideRetry({ kind: 'transient', message: 'last words' }, MAX_AUTO_RETRIES, NOW)).toEqual({
      requeue: false,
      message: 'last words',
    });
  });

  it('continues a timed-out run soon, within the same retry budget', () => {
    const decision = decideRetry({ kind: 'continue', message: 'm' }, 0, NOW);
    expect(decision).toMatchObject({ requeue: true, waitReason: 'continue', retryCount: 1 });
    expect(decideRetry({ kind: 'continue', message: 'm' }, MAX_AUTO_RETRIES, NOW).requeue).toBe(false);
  });

  it('never retries what needs the user', () => {
    expect(decideRetry({ kind: 'permanent', message: 'm' }, 0, NOW)).toEqual({ requeue: false, message: 'm' });
  });
});
