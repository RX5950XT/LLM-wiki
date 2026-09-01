import { describe, expect, it } from 'bun:test';
import { parseCitations, sanitizeModelTextChunk } from './citation-parser';

const rawCitation = {
  source_id: '11111111-1111-4111-8111-111111111111',
  title: 'Research note',
  kind: 'text',
  url: null,
  content_sha256: 'a'.repeat(64),
  locator: { line_start: 3, line_end: 5 },
} as const;

describe('sanitizeModelTextChunk', () => {
  it('removes NUL delimiters from model text', () => {
    expect(sanitizeModelTextChunk('answer\x00RAW_CITATIONS\x00[]')).toBe('answerRAW_CITATIONS[]');
  });
});

describe('parseCitations', () => {
  it('parses typed raw citations and keeps the existing citation fields', () => {
    const result = parseCitations(
      `Answer [S1]\n\x00CITATIONS\x00["concepts/rag.md"]\n\x00RAW_CITATIONS\x00${JSON.stringify([rawCitation])}`,
    );

    expect(result.text).toBe('Answer [S1]\n');
    expect(result.citedSlugs).toEqual(['concepts/rag.md']);
    expect(result.proposals).toEqual([]);
    expect(result.rawCitations).toEqual([rawCitation]);
  });

  it('ignores unknown blocks and malformed raw citation payloads', () => {
    const result = parseCitations(
      `Answer\n\x00FUTURE\x00{"ignored":true}\n\x00RAW_CITATIONS\x00not-json`,
    );

    expect(result.text).toBe('Answer\n');
    expect(result.citedSlugs).toEqual([]);
    expect(result.proposals).toEqual([]);
    expect(result.rawCitations).toEqual([]);
  });

  it('filters malformed entries without throwing', () => {
    const result = parseCitations(
      `Answer\n\x00RAW_CITATIONS\x00${JSON.stringify([
        rawCitation,
        { ...rawCitation, locator: { line_start: 0, line_end: 2 } },
        { source_id: rawCitation.source_id },
      ])}`,
    );

    expect(result.rawCitations).toEqual([rawCitation]);
  });
});
