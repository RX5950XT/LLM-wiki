export type FrontmatterValue =
  | string
  | number
  | boolean
  | null
  | string[]
  | Record<string, unknown>;

export interface ParsedFrontmatter {
  frontmatter: Record<string, unknown>;
  body: string;
  hasFrontmatter: boolean;
}

export interface FrontmatterMergeResult extends ParsedFrontmatter {
  content: string;
}

interface FrontmatterBlock {
  key: string;
  lines: string[];
  value: unknown;
}

const FRONTMATTER_START = /^(?:\uFEFF)?---\n/;
const TOP_LEVEL_KEY = /^([A-Za-z0-9_-]+):(?:\s?(.*))?$/;
const ARRAY_KEYS = new Set(['sources', 'tags', 'related']);

function splitDocument(content: string): {
  blocks: FrontmatterBlock[];
  body: string;
  hasFrontmatter: boolean;
} {
  const normalized = content.replace(/\r\n/g, '\n');
  if (!FRONTMATTER_START.test(normalized)) {
    return { blocks: [], body: normalized, hasFrontmatter: false };
  }

  const close = normalized.indexOf('\n---', 4);
  if (close < 0) return { blocks: [], body: normalized, hasFrontmatter: false };

  const closingEnd = close + 4;
  const raw = normalized.slice(4, close);
  const body = normalized.slice(closingEnd).replace(/^\n/, '');
  const lines = raw.split('\n');
  const blocks: FrontmatterBlock[] = [];
  let current: FrontmatterBlock | null = null;

  for (const line of lines) {
    const match = line.match(TOP_LEVEL_KEY);
    if (match && !/^\s/.test(line)) {
      current = { key: match[1]!, lines: [line], value: parseScalar(match[2] ?? '') };
      blocks.push(current);
      continue;
    }
    if (current) {
      current.lines.push(line);
      current.value = parseBlockValue(current.lines);
    }
  }

  return { blocks, body, hasFrontmatter: true };
}

function parseBlockValue(lines: string[]): unknown {
  const first = lines[0]!.match(TOP_LEVEL_KEY);
  const inline = first?.[2]?.trim() ?? '';
  const continuations = lines.slice(1).map((line) => line.trim()).filter(Boolean);
  if (!inline && continuations.length > 0 && continuations.every((line) => line.startsWith('- '))) {
    return continuations.map((line) => parseScalar(line.slice(2).trim()));
  }
  if (inline) return parseScalar(inline);
  return null;
}

function parseScalar(value: string): unknown {
  const trimmed = value.trim();
  if (!trimmed) return null;
  if (trimmed === 'true') return true;
  if (trimmed === 'false') return false;
  if (trimmed === 'null') return null;
  if (/^-?\d+(?:\.\d+)?$/.test(trimmed)) return Number(trimmed);
  if (trimmed.startsWith('[') && trimmed.endsWith(']')) return parseInlineArray(trimmed);
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1).replace(/\\([\\'"nrt])/g, (_match, escaped: string) => {
      if (escaped === 'n') return '\n';
      if (escaped === 'r') return '\r';
      if (escaped === 't') return '\t';
      return escaped;
    });
  }
  return trimmed;
}

function parseInlineArray(value: string): unknown[] {
  const inner = value.slice(1, -1).trim();
  if (!inner) return [];
  const values: unknown[] = [];
  let token = '';
  let quote: string | null = null;
  for (const character of inner) {
    if ((character === '"' || character === "'") && (quote === null || quote === character)) {
      quote = quote === null ? character : null;
    }
    if (character === ',' && quote === null) {
      values.push(parseScalar(token));
      token = '';
    } else {
      token += character;
    }
  }
  values.push(parseScalar(token));
  return values;
}

function toStringArray(value: unknown): string[] {
  if (Array.isArray(value)) return value.filter((item): item is string => typeof item === 'string');
  return typeof value === 'string' ? [value] : [];
}

function stableUnion(...values: unknown[]): string[] {
  const result: string[] = [];
  const seen = new Set<string>();
  for (const value of values) {
    for (const item of toStringArray(value)) {
      if (!seen.has(item)) {
        seen.add(item);
        result.push(item);
      }
    }
  }
  return result;
}

function formatScalar(value: unknown): string {
  if (typeof value === 'string') return JSON.stringify(value);
  if (value === null) return 'null';
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return JSON.stringify(value);
}

function formatKnownBlock(key: string, value: unknown): string[] {
  if (ARRAY_KEYS.has(key)) {
    return [`${key}: [${toStringArray(value).map(formatScalar).join(', ')}]`];
  }
  return [`${key}: ${formatScalar(value)}`];
}

function blockMap(blocks: FrontmatterBlock[]): Map<string, FrontmatterBlock> {
  return new Map(blocks.map((block) => [block.key, block]));
}

function buildFrontmatter(
  oldBlocks: FrontmatterBlock[],
  newBlocks: FrontmatterBlock[],
  sourceId?: string,
): { blocks: string[]; frontmatter: Record<string, unknown> } {
  const oldMap = blockMap(oldBlocks);
  const newMap = blockMap(newBlocks);
  const keys = [...oldBlocks.map((block) => block.key), ...newBlocks.map((block) => block.key)]
    .filter((key, index, all) => all.indexOf(key) === index);
  const frontmatter: Record<string, unknown> = {};
  const output: string[] = [];

  for (const key of keys) {
    const oldBlock = oldMap.get(key);
    const newBlock = newMap.get(key);
    if (ARRAY_KEYS.has(key)) {
      const values = stableUnion(oldBlock?.value, newBlock?.value, key === 'sources' ? sourceId : undefined);
      if (values.length > 0 || oldBlock || newBlock || (key === 'sources' && sourceId)) {
        output.push(...formatKnownBlock(key, values));
        frontmatter[key] = values;
      }
      continue;
    }

    const block = newBlock ?? oldBlock;
    if (!block) continue;
    output.push(...block.lines);
    frontmatter[key] = block.value;
  }

  if (sourceId && !newMap.has('sources') && !oldMap.has('sources')) {
    output.push(...formatKnownBlock('sources', [sourceId]));
    frontmatter.sources = [sourceId];
  }

  return { blocks: output, frontmatter };
}

export function parseFrontmatter(content: string): ParsedFrontmatter {
  const parsed = splitDocument(content);
  const frontmatter: Record<string, unknown> = {};
  for (const block of parsed.blocks) frontmatter[block.key] = block.value;
  return { frontmatter, body: parsed.body, hasFrontmatter: parsed.hasFrontmatter };
}

/** Merge protected metadata without throwing away unknown user-defined keys. */
export function mergePageFrontmatter(
  currentContent: string,
  proposedContent: string,
  sourceId?: string,
): FrontmatterMergeResult {
  const current = splitDocument(currentContent);
  const proposed = splitDocument(proposedContent);
  const { blocks, frontmatter } = buildFrontmatter(current.blocks, proposed.blocks, sourceId);

  if (blocks.length === 0) {
    return {
      content: proposed.body,
      frontmatter,
      body: proposed.body,
      hasFrontmatter: false,
    };
  }

  const content = `---\n${blocks.join('\n')}\n---\n${proposed.body}`;
  return { content, frontmatter, body: proposed.body, hasFrontmatter: true };
}

export function markdownBody(content: string): string {
  return splitDocument(content).body;
}

export function hasSuspiciousShortening(
  previousContent: string,
  nextContent: string,
  minimumPreviousBodyLength = 500,
  ratio = 0.7,
): boolean {
  const previousLength = markdownBody(previousContent).trim().length;
  const nextLength = markdownBody(nextContent).trim().length;
  return previousLength >= minimumPreviousBodyLength && nextLength < previousLength * ratio;
}
