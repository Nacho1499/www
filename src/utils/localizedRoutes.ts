/**
 * Routes that exist under the locale prefixes (/es/*, /pt/*).
 *
 * Shared by the router helpers in src/hooks/useLocalePath.ts and by
 * scripts/og.ts, which must only emit hreflang alternates for these routes.
 * Keep it in sync with the locale-prefixed routes in App.tsx.
 */
export const LOCALIZED_BASE_PATHS = new Set<string>([
  '/',
  '/stellar',
  '/grants',
  '/blog',
  '/case-studies',
]);

/**
 * Checks if a given path has a localized version.
 * Only routes defined in the locale-prefixed routes in App.tsx should return true.
 * This includes base paths and their sub-routes (e.g., /blog, /blog/:slug, /blog/author/:id).
 */
export function hasLocalizedRoute(path: string): boolean {
  if (!path.startsWith('/')) return false;
  if (path === '/') return true;

  const segments = path.split('/').filter(Boolean);
  if (segments.length === 0) return false;

  return LOCALIZED_BASE_PATHS.has(`/${segments[0]}`);
}
