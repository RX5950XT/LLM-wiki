import type { ActionProposal } from '@/lib/ai/tools';
import type { RawSourceCitation, SourceKind } from '@/lib/ai/source-tools';

/** Model text cannot create a metadata delimiter; only the server may append one. */
export function sanitizeModelTextChunk(chunk: string): string {
  return chunk.replaceAll('\x00', '');
}

/**
 * Parse trailing NUL-delimited metadata blocks appended to a streamed query
 * response. The query API may append, in order:
 *   \x00CITATIONS\x00["entities/karpathy.md","concepts/rag.md"]
 *   \x00ACTIONS\x00[{"action":"delete_page","params":{...},"label":"..."}]
 *   \x00RAW_CITATIONS\x00[{"source_id":"…","locator":{"line_start":1,"line_end":4}}]
 *
 * Unknown \x00NAME\x00 blocks are stripped and ignored so older clients keep
 * working when new blocks are introduced.
 *
 * Returns `{ text, citedSlugs, proposals }` — `text` has all markers stripped.
 */
export function parseCitations(raw: string): {
  text: string;
  citedSlugs: string[];
  proposals: ActionProposal[];
  rawCitations: RawSourceCitation[];
} {
  let text = raw;
  let citedSlugs: string[] = [];
  let proposals: ActionProposal[] = [];
  let rawCitations: RawSourceCitation[] = [];

  // Blocks are appended at the end; peel them off back-to-front.
  const blockPattern = /\x00([A-Z_]+)\x00/g;
  const markers: { name: string; index: number; length: number }[] = [];
  for (const m of raw.matchAll(blockPattern)) {
    markers.push({ name: m[1]!, index: m.index!, length: m[0].length });
  }
  if (markers.length === 0) return { text, citedSlugs, proposals, rawCitations };

  text = raw.slice(0, markers[0]!.index);

  for (let i = 0; i < markers.length; i++) {
    const marker = markers[i]!;
    const start = marker.index + marker.length;
    const end = i + 1 < markers.length ? markers[i + 1]!.index : raw.length;
    const jsonPart = raw.slice(start, end).trim();

    try {
      const parsed = JSON.parse(jsonPart);
      if (marker.name === 'CITATIONS' && Array.isArray(parsed)) {
        citedSlugs = parsed.filter((s): s is string => typeof s === 'string');
      } else if (marker.name === 'ACTIONS' && Array.isArray(parsed)) {
        // params must be an object — the confirm card dereferences params.slug /
        // params.name, so a truncated block missing it would throw in render.
        proposals = parsed.filter(
          (p): p is ActionProposal =>
            p &&
            typeof p === 'object' &&
            (p.action === 'delete_page' || p.action === 'delete_workspace') &&
            typeof p.label === 'string' &&
            p.params != null &&
            typeof p.params === 'object',
        );
      } else if (marker.name === 'RAW_CITATIONS' && Array.isArray(parsed)) {
        rawCitations = parsed.filter(isRawSourceCitation);
      }
      // unknown block names: parsed but ignored
    } catch {
      // malformed JSON — ignore this block
    }
  }

  return { text, citedSlugs, proposals, rawCitations };
}

function isRawSourceCitation(value: unknown): value is RawSourceCitation {
  if (!value || typeof value !== 'object') return false;
  const citation = value as Partial<RawSourceCitation> & {
    locator?: Partial<RawSourceCitation['locator']>;
  };
  const locator = citation.locator;
  return (
    typeof citation.source_id === 'string' &&
    citation.source_id.length > 0 &&
    (typeof citation.title === 'string' || citation.title === null) &&
    isSourceKind(citation.kind) &&
    (typeof citation.url === 'string' || citation.url === null) &&
    typeof citation.content_sha256 === 'string' &&
    citation.content_sha256.length > 0 &&
    !!locator &&
    Number.isInteger(locator.line_start) &&
    Number.isInteger(locator.line_end) &&
    locator.line_start >= 1 &&
    locator.line_end >= locator.line_start
  );
}

function isSourceKind(value: unknown): value is SourceKind {
  return value === 'url' || value === 'file' || value === 'text';
}
