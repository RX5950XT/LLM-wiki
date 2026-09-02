import { describe, expect, it } from 'bun:test';
import { APICallError } from 'ai';
import { publicIngestError } from './ingest-pipeline';

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
