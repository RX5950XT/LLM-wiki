import { describe, expect, it } from 'bun:test';
import { localizeIngestError } from './ingest-error-i18n';
import { budgetExhaustedError } from './ingest-pipeline';
import { toPublicUrlFetchFailure } from '@/lib/fetch/url-to-markdown';

describe('localizeIngestError', () => {
  it('translates the messages the server actually produces', () => {
    expect(localizeIngestError(budgetExhaustedError(11, 16).message, 'zh-TW')).toBe(
      '匯入時間用完：已完成 11/16 頁，按「重試」會從這裡接著做。',
    );
    const refused = toPublicUrlFetchFailure(new Error('Failed to fetch https://x.test: HTTP 403')).message;
    expect(localizeIngestError(refused, 'zh-TW')).toContain('HTTP 403');
    expect(localizeIngestError('Model call failed (404): no such model', 'zh-TW')).toBe('模型呼叫失敗（404）：no such model');
  });

  it('leaves English and unknown messages alone', () => {
    expect(localizeIngestError('Ingest failed', 'en')).toBe('Ingest failed');
    expect(localizeIngestError('something new', 'zh-TW')).toBe('something new');
    expect(localizeIngestError(null, 'zh-TW')).toBeNull();
  });
});
