/** Parsing helpers for the link checker: sitemaps, feeds and link targets. */

export const SITE_ORIGIN = 'https://usewraith.xyz';

function decodeXml(value: string): string {
  return value
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&')
    .trim();
}

/** Returns the `<loc>` URLs of a sitemap. */
export function parseSitemap(xml: string): string[] {
  if (!/<urlset[\s>]/.test(xml)) throw new Error('not a sitemap: <urlset> is missing');
  return [...xml.matchAll(/<loc>([\s\S]*?)<\/loc>/g)].map((match) => decodeXml(match[1] ?? ''));
}

export interface ParsedFeed {
  /** The channel's own <link>. */
  channelLink?: string;
  /** <link> of every item. */
  itemLinks: string[];
}

/** Reads an RSS 2.0 feed's channel link and item links. */
export function parseRssFeed(xml: string): ParsedFeed {
  if (!/<rss[\s>]/.test(xml) || !/<channel[\s>]/.test(xml)) {
    throw new Error('not an RSS feed: <rss> or <channel> is missing');
  }
  const items = [...xml.matchAll(/<item[\s>]([\s\S]*?)<\/item>/g)].map((match) => match[1] ?? '');
  const linkOf = (block: string) => {
    const link = /<link>([\s\S]*?)<\/link>/.exec(block)?.[1];
    return link === undefined ? undefined : decodeXml(link);
  };
  const channel = xml.replace(/<item[\s>][\s\S]*?<\/item>/g, '');
  return {
    channelLink: linkOf(channel),
    itemLinks: items.map(linkOf).filter((link): link is string => link !== undefined),
  };
}

export type LinkTarget =
  | { kind: 'internal'; path: string; fragment?: string }
  | { kind: 'external'; url: string }
  | { kind: 'ignored'; reason: string }
  | { kind: 'invalid'; reason: string };

/**
 * Classifies an href found on a page. Links to the checked base URL and to the
 * production origin are internal; other http(s) links are external.
 */
export function classifyLink(href: string, pageUrl: string, baseOrigin: string): LinkTarget {
  const trimmed = href.trim();
  if (trimmed === '') return { kind: 'invalid', reason: 'empty href' };
  if (/^(mailto|tel|sms):/i.test(trimmed)) return { kind: 'ignored', reason: 'not a web link' };
  if (/^javascript:/i.test(trimmed)) return { kind: 'invalid', reason: 'javascript: link' };

  let url: URL;
  try {
    url = new URL(trimmed, pageUrl);
  } catch {
    return { kind: 'invalid', reason: `unparseable href ${JSON.stringify(href)}` };
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return { kind: 'invalid', reason: `unsupported scheme ${url.protocol}` };
  }
  if (url.origin === baseOrigin || url.origin === SITE_ORIGIN) {
    const fragment = url.hash ? decodeURIComponent(url.hash.slice(1)) : undefined;
    return { kind: 'internal', path: url.pathname, ...(fragment ? { fragment } : {}) };
  }
  url.hash = '';
  return { kind: 'external', url: url.href };
}

/** Paths with an extension (other than .html) are files, not app routes. */
export function isAssetPath(path: string): boolean {
  const last = path.split('/').pop() ?? '';
  return /\.[a-z0-9]+$/i.test(last) && !/\.html?$/i.test(last);
}

/** Collapses `/about/` to `/about` so a route is checked once. */
export function normalizeRoute(path: string): string {
  return path.length > 1 && path.endsWith('/') ? path.slice(0, -1) : path;
}
