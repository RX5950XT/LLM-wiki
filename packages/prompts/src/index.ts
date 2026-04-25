import ingestTemplate from '../templates/ingest.md' with { type: 'text' };
import queryTemplate from '../templates/query.md' with { type: 'text' };
import lintTemplate from '../templates/lint.md' with { type: 'text' };

export const DEFAULT_INGEST_PROMPT = ingestTemplate as unknown as string;
export const DEFAULT_QUERY_PROMPT = queryTemplate as unknown as string;
export const DEFAULT_LINT_PROMPT = lintTemplate as unknown as string;

export type PromptKind = 'ingest' | 'query' | 'lint';

export const DEFAULT_PROMPTS: Record<PromptKind, string> = {
  ingest: DEFAULT_INGEST_PROMPT,
  query: DEFAULT_QUERY_PROMPT,
  lint: DEFAULT_LINT_PROMPT,
};
