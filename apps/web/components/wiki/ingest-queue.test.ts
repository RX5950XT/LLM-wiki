import { describe, expect, test } from 'bun:test';
import {
  isActiveIngestStatus,
  ingestFileMimeForUpload,
  isSupportedIngestFile,
  mergeIngestQueueJobs,
  parseIngestJobsResponse,
  parseIngestQueueJob,
  parseIngestStartResponse,
} from './ingest-queue';

const job = {
  id: 'job-1',
  workspace_id: 'workspace-1',
  source_id: 'source-1',
  status: 'running',
  phase: 'writing',
  result: null,
  error: null,
  touched_pages: ['entities/a.md'],
  attempt_count: 1,
  updated_at: '2026-09-01T00:00:00.000Z',
};

describe('ingest queue response guards', () => {
  test('rejects an HTML or malformed successful response', () => {
    expect(parseIngestStartResponse({ status: 'running' })).toBeNull();
    expect(parseIngestQueueJob({ ...job, phase: 'unknown' })).toBeNull();
    expect(parseIngestJobsResponse({ workspace_id: 'other', jobs: [job] }, 'workspace-1')).toBeNull();
  });

  test('normalizes valid jobs and preserves the newest merge', () => {
    const parsed = parseIngestQueueJob(job);
    expect(parsed?.touched_pages).toEqual(['entities/a.md']);
    expect(isActiveIngestStatus(parsed!.status)).toBe(true);
    expect(
      mergeIngestQueueJobs(
        [parsed!],
        [{ ...parsed!, status: 'done', phase: 'done', result: 'unchanged', updated_at: '2026-09-01T00:01:00.000Z' }],
      )[0]?.result,
    ).toBe('unchanged');
  });

  test('accepts all supported document and image extensions', () => {
    for (const name of ['a.txt', 'a.md', 'a.pdf', 'a.docx', 'a.pptx', 'a.epub', 'a.png', 'a.jpg', 'a.jpeg', 'a.webp', 'a.gif']) {
      expect(isSupportedIngestFile(name, '')).toBe(true);
    }
    expect(isSupportedIngestFile('a.exe', 'application/octet-stream')).toBe(false);
    expect(ingestFileMimeForUpload('a.epub', '')).toBe('application/epub+zip');
    expect(ingestFileMimeForUpload('a.md', 'text/markdown')).toBe('text/markdown');
  });
});
