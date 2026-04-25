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

/**
 * Fetch a URL, extract the main article, and return clean markdown.
 * Throws on network errors or if no article content is found.
 */
export async function urlToMarkdown(url: string): Promise<FetchedArticle> {
  const response = await fetch(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (compatible; LLMWiki/1.0)',
      Accept: 'text/html,application/xhtml+xml',
    },
    redirect: 'follow',
  });

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
