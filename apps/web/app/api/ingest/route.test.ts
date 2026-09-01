import { describe, expect, it } from 'bun:test';
import { checkIngestContentLength, parseIngestJobAction, parseMultipartIngestFields } from './route';

describe('ingest content-length guard', () => {
  it('requires a numeric content length before parsing either body format', () => {
    expect(checkIngestContentLength(new Headers(), 'json')).toMatchObject({
      ok: false,
      status: 411,
      code: 'CONTENT_LENGTH_REQUIRED',
    });
    expect(checkIngestContentLength(new Headers({ 'content-length': 'chunked' }), 'multipart')).toMatchObject({
      ok: false,
      status: 400,
      code: 'INVALID_CONTENT_LENGTH',
    });
  });

  it('allows a small browser/Ktor body and rejects excess overhead', () => {
    expect(checkIngestContentLength(new Headers({ 'content-length': '2048' }), 'json')).toEqual({ ok: true, bytes: 2048 });
    expect(checkIngestContentLength(new Headers({ 'content-length': String(2 * 1024 * 1024 + 64 * 1024 + 1) }), 'json')).toMatchObject({
      ok: false,
      status: 413,
      code: 'INGEST_REQUEST_TOO_LARGE',
    });
    expect(checkIngestContentLength(new Headers({ 'content-length': String(2 * 1024 * 1024 + 64 * 1024) }), 'multipart')).toMatchObject({
      ok: true,
    });
    expect(checkIngestContentLength(new Headers({ 'content-length': String(2 * 1024 * 1024 + 64 * 1024 + 1) }), 'multipart')).toMatchObject({
      ok: false,
      status: 413,
    });
  });
});

describe('multipart ingest request helper', () => {
  it('parses the file and owner-scoped routing fields', () => {
    const form = new FormData();
    form.set('file', new File(['# Notes'], 'notes.md', { type: 'text/markdown' }));
    form.set('workspace_id', '11111111-1111-4111-8111-111111111111');
    form.set('auto_route', 'true');
    const parsed = parseMultipartIngestFields(form);
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.data.file.name).toBe('notes.md');
      expect(parsed.data.auto_route).toBe(true);
      expect(parsed.data.workspace_id).toBe('11111111-1111-4111-8111-111111111111');
    }
  });

  it('rejects missing files and oversized files before parsing', () => {
    expect(parseMultipartIngestFields(new FormData())).toEqual({ ok: false, message: 'file is required' });
    const form = new FormData();
    form.set('file', new File(['x'.repeat(2 * 1024 * 1024 + 1)], 'large.txt', { type: 'text/plain' }));
    expect(parseMultipartIngestFields(form)).toEqual({ ok: false, message: 'file is too large' });
  });
});

describe('ingest job action request helper', () => {
  const jobId = '11111111-1111-4111-8111-111111111111';

  it('accepts the Android-compatible body job_id without a query parameter', () => {
    expect(parseIngestJobAction({ job_id: jobId, action: 'pause' })).toEqual({
      ok: true,
      data: { jobId, action: 'pause' },
    });
  });

  it('keeps the query parameter as a compatibility fallback', () => {
    expect(parseIngestJobAction({ action: 'retry' }, jobId)).toEqual({
      ok: true,
      data: { jobId, action: 'retry' },
    });
  });

  it('rejects an invalid body job_id instead of trusting a valid query id', () => {
    expect(parseIngestJobAction({ job_id: 'not-a-uuid', action: 'pause' }, jobId)).toEqual({
      ok: false,
      code: 'INVALID_JOB_ID',
      message: 'Invalid job_id',
    });
  });
});
