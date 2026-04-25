/**
 * Parse the citation block appended to a streamed query response.
 *
 * The query API appends a NUL-delimited marker at the end of the text stream:
 *   \x00CITATIONS\x00["entities/karpathy.md","concepts/rag.md"]
 *
 * Returns `{ text, citedSlugs }` — `text` has the marker stripped.
 */
export function parseCitations(raw: string): {
  text: string;
  citedSlugs: string[];
} {
  const marker = '\x00CITATIONS\x00';
  const idx = raw.lastIndexOf(marker);
  if (idx === -1) return { text: raw, citedSlugs: [] };

  const text = raw.slice(0, idx);
  const jsonPart = raw.slice(idx + marker.length);

  let citedSlugs: string[] = [];
  try {
    const parsed = JSON.parse(jsonPart);
    if (Array.isArray(parsed)) {
      citedSlugs = parsed.filter((s): s is string => typeof s === 'string');
    }
  } catch {
    // malformed JSON — ignore citations
  }

  return { text, citedSlugs };
}
