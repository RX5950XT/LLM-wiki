import { isIP } from 'net';
import { lookup } from 'dns/promises';
import { Readability } from '@mozilla/readability';
import { JSDOM } from 'jsdom';
import TurndownService from 'turndown';

const turndown = new TurndownService({
  headingStyle: 'atx',
  bulletListMarker: '-',
  codeBlockStyle: 'fenced',
});

export interface FetchedArticle {
  title: string;
  markdown: string;
  byline: string | null;
  url: string;
}

/** True if the literal IP is loopback / private / link-local / CGNAT / ULA. */
export function isPrivateIp(ip: string): boolean {
  const bare = ip.toLowerCase();
  // IPv4-mapped IPv6 (::ffff:127.0.0.1 or ::ffff:7f00:1) — check the mapped part
  if (bare.startsWith('::ffff:')) {
    const tail = bare.slice(7);
    if (isIP(tail) === 4) return isPrivateIp(tail);
    return true; // hex-form mapped address; refuse rather than parse
  }
  if (isIP(bare) === 4) {
    const [a = 0, b = 0] = bare.split('.').map(Number);
    return (
      a === 0 ||
      a === 10 ||
      a === 127 ||
      (a === 100 && b >= 64 && b <= 127) || // CGNAT
      (a === 169 && b === 254) || // link-local / cloud metadata
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168)
    );
  }
  // IPv6
  return (
    bare === '::' ||
    bare === '::1' ||
    bare.startsWith('fe80:') || // link-local
    bare.startsWith('fc') || // ULA fc00::/7
    bare.startsWith('fd')
  );
}

/** Throws if hostname is a private IP literal, or resolves only to private IPs. */
async function assertPublicHost(hostname: string): Promise<void> {
  const bare = hostname.replace(/^\[|\]$/g, ''); // IPv6 URL hostnames keep brackets
  if (isIP(bare)) {
    if (isPrivateIp(bare)) throw new Error('URL targets a private address');
    return;
  }
  if (/^localhost$/i.test(bare) || /\.(local|internal)$/i.test(bare)) {
    throw new Error('URL targets a private address');
  }
  // ponytail: dns pre-check leaves a TOCTOU rebinding window; move to an undici
  // connect interceptor if that ever matters for this deployment
  const records = await lookup(bare, { all: true, verbatim: true }).catch(() => []);
  if (records.length === 0) throw new Error(`Could not resolve host: ${hostname}`);
  if (records.some((record) => isPrivateIp(record.address))) {
    throw new Error('URL resolves to a private address');
  }
}

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const MAX_REDIRECTS = 5;

/** Fetch with per-hop SSRF validation instead of trusting redirect: 'follow'. */
async function fetchWithHostChecks(url: string): Promise<Response> {
  let currentUrl = url;
  for (let hop = 0; ; hop += 1) {
    const parsed = new URL(currentUrl);
    if (!['http:', 'https:'].includes(parsed.protocol)) {
      throw new Error(`URL protocol not allowed: ${parsed.protocol}`);
    }
    await assertPublicHost(parsed.hostname);

    const response = await fetch(currentUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; LLMWiki/1.0)',
        Accept: 'text/html,application/xhtml+xml',
      },
      redirect: 'manual',
      // A hung remote server must not eat the whole serverless budget
      signal: AbortSignal.timeout(20_000),
    }).catch((err) => {
      if (err instanceof Error && err.name === 'TimeoutError') {
        throw new Error(`Timed out fetching ${currentUrl} (20s)`);
      }
      throw err;
    });

    if (REDIRECT_STATUSES.has(response.status)) {
      if (hop >= MAX_REDIRECTS) throw new Error(`Too many redirects: ${url}`);
      const location = response.headers.get('location');
      if (!location) throw new Error(`Redirect without Location header: ${currentUrl}`);
      currentUrl = new URL(location, currentUrl).toString();
      continue;
    }
    return response;
  }
}

/**
 * Fetch a URL, extract the main article, and return clean markdown.
 * Throws on network errors, SSRF-blocked targets, or if no article content is found.
 */
export async function urlToMarkdown(url: string): Promise<FetchedArticle> {
  const response = await fetchWithHostChecks(url);

  if (!response.ok) {
    throw new Error(`Failed to fetch ${url}: HTTP ${response.status}`);
  }

  const html = await response.text();
  if (html.length > 5 * 1024 * 1024) {
    throw new Error(`Page too large to ingest (> 5 MB): ${url}`);
  }
  const dom = new JSDOM(html, { url });
  const reader = new Readability(dom.window.document);
  const article = reader.parse();

  if (!article) {
    throw new Error(`Could not extract article content from ${url}`);
  }

  const markdown = turndown.turndown(article.content);

  return {
    title: article.title,
    markdown: `# ${article.title}\n\n> Source: ${url}\n\n${markdown}`,
    byline: article.byline,
    url,
  };
}
