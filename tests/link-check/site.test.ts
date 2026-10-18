import { describe, expect, it } from 'vitest';
import {
  classifyLink,
  isAssetPath,
  normalizeRoute,
  parseRssFeed,
  parseSitemap,
} from '../../scripts/link-check/site';

const base = 'http://127.0.0.1:4174';

describe('classifyLink', () => {
  it('treats the checked origin and the production origin as internal', () => {
    expect(classifyLink('/about', `${base}/`, base)).toEqual({ kind: 'internal', path: '/about' });
    expect(classifyLink('https://usewraith.xyz/security#audits', `${base}/`, base)).toEqual({
      kind: 'internal',
      path: '/security',
      fragment: 'audits',
    });
    expect(classifyLink('#compare', `${base}/es`, base)).toEqual({
      kind: 'internal',
      path: '/es',
      fragment: 'compare',
    });
  });

  it('strips fragments from external links', () => {
    expect(classifyLink('https://github.com/wraith-protocol#readme', `${base}/`, base)).toEqual({
      kind: 'external',
      url: 'https://github.com/wraith-protocol',
    });
  });

  it('ignores mail links and rejects script and odd schemes', () => {
    expect(classifyLink('mailto:security@usewraith.xyz', `${base}/`, base).kind).toBe('ignored');
    expect(classifyLink('javascript:void(0)', `${base}/`, base).kind).toBe('invalid');
    expect(classifyLink('ftp://example.com/file', `${base}/`, base).kind).toBe('invalid');
    expect(classifyLink('   ', `${base}/`, base).kind).toBe('invalid');
  });
});

describe('paths', () => {
  it('tells files from routes', () => {
    expect(isAssetPath('/press-kit.zip')).toBe(true);
    expect(isAssetPath('/.well-known/security.txt')).toBe(true);
    expect(isAssetPath('/blog/wave-7-kickoff')).toBe(false);
    expect(isAssetPath('/about.html')).toBe(false);
  });

  it('normalizes trailing slashes', () => {
    expect(normalizeRoute('/about/')).toBe('/about');
    expect(normalizeRoute('/')).toBe('/');
  });
});

describe('parsers', () => {
  it('reads sitemap locations', () => {
    const xml = `<?xml version="1.0"?><urlset><url><loc>https://usewraith.xyz/</loc></url>
      <url><loc>https://usewraith.xyz/blog?a=1&amp;b=2</loc></url></urlset>`;
    expect(parseSitemap(xml)).toEqual([
      'https://usewraith.xyz/',
      'https://usewraith.xyz/blog?a=1&b=2',
    ]);
    expect(() => parseSitemap('<html></html>')).toThrow(/not a sitemap/);
  });

  it('reads the channel link and item links of an RSS feed', () => {
    const xml = `<rss version="2.0"><channel><title>Wraith</title><link>https://usewraith.xyz/blog</link>
      <item><title>A</title><link>https://usewraith.xyz/blog/a</link></item>
      <item><title>B</title><link>https://usewraith.xyz/blog/b</link></item></channel></rss>`;
    expect(parseRssFeed(xml)).toEqual({
      channelLink: 'https://usewraith.xyz/blog',
      itemLinks: ['https://usewraith.xyz/blog/a', 'https://usewraith.xyz/blog/b'],
    });
    expect(() => parseRssFeed('<feed></feed>')).toThrow(/not an RSS feed/);
  });
});
