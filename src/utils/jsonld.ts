export const SITE_URL = 'https://www.usewraith.xyz';

export type JsonLdObject = Record<string, unknown> & { '@context': string; '@type': string };

export interface OrganizationInput {
  name?: string;
  url?: string;
  logo?: string;
  sameAs?: string[];
}

export function organization(input: OrganizationInput = {}): JsonLdObject {
  return {
    '@context': 'https://schema.org',
    '@type': 'Organization',
    '@id': `${SITE_URL}/#organization`,
    name: input.name ?? 'Wraith Protocol',
    url: input.url ?? SITE_URL,
    logo: input.logo ?? `${SITE_URL}/logo.png`,
    sameAs: input.sameAs ?? [
      'https://github.com/wraith-protocol',
      'https://twitter.com/wraith_protocol',
    ],
  };
}

export interface ArticleInput {
  headline: string;
  description: string;
  datePublished: string;
  authorName: string;
  url: string;
  publisherName?: string;
}

export function article(input: ArticleInput): JsonLdObject {
  return {
    '@context': 'https://schema.org',
    '@type': 'Article',
    headline: input.headline,
    description: input.description,
    datePublished: input.datePublished,
    author: {
      '@type': 'Organization',
      name: input.authorName,
    },
    publisher: {
      '@type': 'Organization',
      name: input.publisherName ?? 'Wraith Protocol',
      logo: {
        '@type': 'ImageObject',
        url: `${SITE_URL}/logo.png`,
      },
    },
    mainEntityOfPage: {
      '@type': 'WebPage',
      '@id': input.url,
    },
  };
}

export interface FaqItem {
  question: string;
  answer: string;
}

export function faqPage(entries: FaqItem[]): JsonLdObject {
  return {
    '@context': 'https://schema.org',
    '@type': 'FAQPage',
    mainEntity: entries.map((entry) => ({
      '@type': 'Question',
      name: entry.question,
      acceptedAnswer: {
        '@type': 'Answer',
        text: entry.answer,
      },
    })),
  };
}

export interface HowToStep {
  name: string;
  text: string;
  url?: string;
}

export interface HowToInput {
  name: string;
  description?: string;
  steps: HowToStep[];
  url?: string;
  totalTime?: string;
}

export function howTo(input: HowToInput): JsonLdObject {
  const step = input.steps.map((s, index) => ({
    '@type': 'HowToStep',
    position: index + 1,
    name: s.name,
    text: s.text,
    ...(s.url ? { url: s.url } : {}),
  }));

  return {
    '@context': 'https://schema.org',
    '@type': 'HowTo',
    name: input.name,
    ...(input.description ? { description: input.description } : {}),
    ...(input.totalTime ? { totalTime: input.totalTime } : {}),
    step,
    ...(input.url ? { mainEntityOfPage: { '@type': 'WebPage', '@id': input.url } } : {}),
  };
}

export interface BreadcrumbItem {
  name: string;
  url: string;
}

export function breadcrumbList(items: BreadcrumbItem[]): JsonLdObject {
  return {
    '@context': 'https://schema.org',
    '@type': 'BreadcrumbList',
    itemListElement: items.map((item, index) => ({
      '@type': 'ListItem',
      position: index + 1,
      name: item.name,
      item: item.url,
    })),
  };
}

/**
 * Characters that can terminate the surrounding `<script>` element, or break
 * a JavaScript/JSON parser, mapped to their JSON escape sequences.
 *
 * `JSON.stringify` does not escape any of these: it emits `<`, `>`, `&`, U+2028
 * and U+2029 literally. Injected into an inline `<script type="application/ld+json">`
 * that matters, because the HTML parser ends the script element at the first
 * `</script` sequence — regardless of the JavaScript/JSON string it appears in.
 * Any content that reaches a JSON-LD field can therefore break out of the
 * script element, and a value like `</script><script>…</script>` becomes markup.
 */
const SCRIPT_SAFE_ESCAPES: Record<string, string> = {
  '<': '\\u003c',
  '>': '\\u003e',
  '&': '\\u0026',
  '\u2028': '\\u2028',
  '\u2029': '\\u2029',
};

/** Any value this module serializes: a single blob or an array of blobs. */
export type JsonLdValue = JsonLdObject | JsonLdObject[];

/**
 * Serializes a JSON-LD blob for safe inline injection into a `<script>` element.
 *
 * This is the single place JSON-LD reaches the DOM: every page renders
 * `dangerouslySetInnerHTML={{ __html: serializeJsonLd(blob) }}` instead of
 * `JSON.stringify(blob)`, so the escaping rule cannot drift between pages.
 *
 * Escaping is semantically transparent. `<`, `>`, `&` and the two line
 * separators are never JSON structural characters, so they only ever appear
 * inside string literals, where replacing them with their `\uXXXX` form is
 * exactly equivalent: `JSON.parse(serializeJsonLd(x))` deep-equals `x`. The
 * emitted text stays valid JSON and therefore valid JSON-LD for crawlers, while
 * `</script`, `<!--` and raw `&` can no longer appear in the output.
 */
export function serializeJsonLd(value: JsonLdValue): string {
  return JSON.stringify(value).replace(
    /[<>&\u2028\u2029]/g,
    (char) => SCRIPT_SAFE_ESCAPES[char] ?? char,
  );
}
