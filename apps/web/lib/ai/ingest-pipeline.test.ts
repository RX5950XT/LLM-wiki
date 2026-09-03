import { describe, expect, it } from 'bun:test';
import { APICallError } from 'ai';
import { nudgeForRemaining, publicIngestError } from './ingest-pipeline';

describe('publicIngestError', () => {
  it('surfaces the provider message so a doomed retry is visible', () => {
    const text = publicIngestError(
      new APICallError({
        message: 'This model is only available through the Batch API.',
        url: 'https://openrouter.ai/api/v1/chat/completions',
        requestBodyValues: { model: 'google/gemini-3.7-flash:batch' },
        statusCode: 404,
      }),
    );
    expect(text).toBe('Model call failed (404): This model is only available through the Batch API.');
    expect(text).not.toContain('openrouter.ai');
  });

  it('keeps unknown errors generic', () => {
    expect(publicIngestError(new Error('boom'))).toBe('Ingest failed');
  });
});

describe('nudgeForRemaining', () => {
  it('names the pages the model still owes', () => {
    const text = nudgeForRemaining(['concepts/fde.md', 'entities/palantir.md']);
    expect(text).toContain('concepts/fde.md');
    expect(text).toContain('entities/palantir.md');
  });

  it('falls back to the empty-run wording when nothing was planned left', () => {
    expect(nudgeForRemaining([])).toContain('No writePage call has completed yet');
  });
});
