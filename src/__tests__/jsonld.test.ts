import { describe, expect, it } from 'vitest';
import {
  article,
  breadcrumbList,
  faqPage,
  howTo,
  organization,
  serializeJsonLd,
  type JsonLdObject,
} from '../utils/jsonld';

/**
 * Regression coverage for the inline-injection sink (issue #157).
 *
 * These blobs end up inside `<script type="application/ld+json">` via
 * `dangerouslySetInnerHTML`, where the HTML parser ends the script element at the
 * first `</script` sequence no matter which JSON string it sits in. The fixtures
 * below are hostile on purpose: each one would break out of the element if it
 * were passed through `JSON.stringify` unchanged.
 */

/** Inputs that must never survive serialization in their raw form. */
const HOSTILE_FIXTURES: Array<[string, string]> = [
  ['closing script tag', '</script>'],
  ['script break-out with payload', '</script><script>alert(1)</script>'],
  ['closing script tag, mixed case', '</ScRiPt>'],
  ['closing script tag with whitespace', '</script >'],
  ['html comment opener', '<!--'],
  ['html comment plus script', '<!--<script>'],
  ['cdata closer', ']]>'],
  ['raw ampersand entity', '&lt;script&gt;'],
  ['event-handler markup', '<img src=x onerror=alert(1)>'],
  ['bare angle brackets', '< >'],
  ['line separator', 'before\u2028after'],
  ['paragraph separator', 'before\u2029after'],
];

const EXPECTED_ESCAPES = ['\\u003c', '\\u003e', '\\u0026'];

function hostileArticle(payload: string): JsonLdObject {
  return article({
    headline: payload,
    description: payload,
    datePublished: '2026-01-01',
    authorName: payload,
    url: `https://www.usewraith.xyz/blog/${encodeURIComponent(payload)}`,
  });
}

describe('serializeJsonLd - script-breaking sequences', () => {
  it.each(HOSTILE_FIXTURES)('neutralizes %s', (_label, payload) => {
    const blob = hostileArticle(payload);
    const out = serializeJsonLd(blob);

    // The two sequences the HTML parser actually acts on.
    expect(out).not.toContain('</script');
    expect(out.toLowerCase()).not.toContain('</script');
    expect(out).not.toContain('<!--');

    // No raw character that could open a tag or an entity survives.
    expect(out).not.toMatch(/[<>&]/);
    expect(out).not.toMatch(/\u2028|\u2029/);
  });

  it('emits the escape sequences instead of stripping the content', () => {
    // Input must contain every character the serializer escapes (<, >, &)
    // so each expected escape sequence is actually exercised.
    const out = serializeJsonLd(hostileArticle('</script>&'));

    for (const escape of EXPECTED_ESCAPES) {
      expect(out).toContain(escape);
    }
  });
});

describe('serializeJsonLd - output stays valid JSON-LD', () => {
  it.each(HOSTILE_FIXTURES)('round-trips %s unchanged', (_label, payload) => {
    const blob = hostileArticle(payload);
    const out = serializeJsonLd(blob);

    // Valid JSON, and semantically identical to the input: escaping is not
    // lossy, it is the same characters expressed differently.
    expect(() => JSON.parse(out)).not.toThrow();
    expect(JSON.parse(out)).toEqual(blob);
  });

  it('preserves the schema.org fields a crawler reads', () => {
    const parsed = JSON.parse(serializeJsonLd(hostileArticle('</script>'))) as JsonLdObject;

    expect(parsed['@context']).toBe('https://schema.org');
    expect(parsed['@type']).toBe('Article');
    expect(parsed.headline).toBe('</script>');
  });

  it('escapes nested structures, not just top-level strings', () => {
    const blob = faqPage([{ question: '</script>', answer: '<b>x</b> & </script>' }]);
    const parsed = JSON.parse(serializeJsonLd(blob)) as JsonLdObject;

    expect(serializeJsonLd(blob)).not.toMatch(/[<>&]/);
    expect(parsed).toEqual(blob);
  });

  it('escapes every element of an array of blobs', () => {
    const out = serializeJsonLd([
      breadcrumbList([{ name: '</script>', url: 'https://www.usewraith.xyz/' }]),
      howTo({ name: '<script>', steps: [{ name: '</script>', text: '&' }] }),
    ]);

    expect(out).not.toMatch(/[<>&]/);
    expect(out.startsWith('[')).toBe(true);
  });
});

describe('serializeJsonLd - unchanged behaviour for ordinary values', () => {
  it('leaves a clean blob byte-identical to JSON.stringify', () => {
    const blob = organization();

    expect(serializeJsonLd(blob)).toBe(JSON.stringify(blob));
  });

  it('does not quote numbers or booleans', () => {
    const out = serializeJsonLd(
      breadcrumbList([{ name: 'Home', url: 'https://www.usewraith.xyz/' }]),
    );

    expect(out).toContain('"position":1');
    expect(out).not.toContain('"position":"1"');
  });

  it('is idempotent for already-escaped input', () => {
    const once = serializeJsonLd(hostileArticle('</script>'));
    const twice = serializeJsonLd(JSON.parse(once) as JsonLdObject);

    expect(twice).toBe(once);
  });
});
