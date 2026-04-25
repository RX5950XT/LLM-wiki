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

/** Returns true if the hostname resolves to a private / loopback address. */
function isPrivateHostname(hostname: string): boolean {
  return /^(localhost|127\.|10\.|172\.(1[6-9]|2\d|3[01])\.|192\.168\.|::1|0\.0\.0\.0)/i.test(
    hostname,
  );
}

/**
 * Fetch a URL, extract the main article, and return clean markdown.
 * Throws on network errors, SSRF-blocked targets, or if no article content is found.
 */
export async function urlToMarkdown(url: string): Promise<FetchedArticle> {
  const parsed = new URL(url);

  if (!['http:', 'https:'].includes(parsed.protocol)) {
    throw new Error(`URL protocol not allowed: ${parsed.protocol}`);
  }
  if (isPrivateHostname(parsed.hostname)) {
    throw new Error('URL targets a private address');
  }

  const response = await fetch(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (compatible; LLMWiki/1.0)',
      Accept: 'text/html,application/xhtml+xml',
    },
    redirect: 'follow',
  });

  // Guard against open-redirect to private IPs
  if (response.url && response.url !== url) {
    const finalHostname = new URL(response.url).hostname;
    if (isPrivateHostname(finalHostname)) {
      throw new Error('URL redirected to a private address');
    }
  }

  if (!response.ok) {
    throw new Error(`Failed to fetch ${url}: HTTP ${response.status}`);
  }

  const html = await response.text();
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
