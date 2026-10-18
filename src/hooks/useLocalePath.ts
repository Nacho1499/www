/**
 * useLocalePath
 *
 * Returns a helper that prefixes internal paths with the active locale
 * for non-English locales, and leaves them unprefixed for English.
 *
 * Usage:
 *   const lp = useLocalePath();
 *   <Link to={lp('/grants')}>Grants</Link>
 *   // → '/es/grants'  when locale is 'es'
 *   // → '/pt/grants'  when locale is 'pt'
 *   // → '/grants'     when locale is 'en'
 */

import { useTranslation } from 'react-i18next';
import { type Locale } from '../i18n';
import { hasLocalizedRoute } from '../utils/localizedRoutes';

const LOCALE_PREFIX: Partial<Record<Locale, string>> = {
  es: '/es',
  pt: '/pt',
};

export { hasLocalizedRoute } from '../utils/localizedRoutes';

export function useLocalePath(): (path: string) => string {
  const { i18n } = useTranslation();
  const locale = ((i18n.language ?? 'en').split('-')[0] ?? 'en') as Locale;
  const prefix = LOCALE_PREFIX[locale] ?? '';

  return (path: string) => {
    // External URLs, hash-only links, or already-prefixed paths pass through.
    if (!path.startsWith('/') || path.startsWith(`/es`) || path.startsWith(`/pt`)) {
      return path;
    }
    return `${prefix}${path}`;
  };
}

/**
 * useLocalizedPath
 *
 * Like useLocalePath, but only prefixes routes that have localized versions.
 * Routes without localized versions (e.g., /privacy, /about, /vitals) are
 * returned unprefixed even for non-English locales.
 */
export function useLocalizedPath(): (path: string) => string {
  const { i18n } = useTranslation();
  const locale = ((i18n.language ?? 'en').split('-')[0] ?? 'en') as Locale;
  const prefix = LOCALE_PREFIX[locale] ?? '';

  return (path: string) => {
    if (!path.startsWith('/') || path.startsWith(`/es`) || path.startsWith(`/pt`)) {
      return path;
    }
    if (!hasLocalizedRoute(path)) {
      return path;
    }
    return `${prefix}${path}`;
  };
}
