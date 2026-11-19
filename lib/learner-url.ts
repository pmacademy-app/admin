import { BRAND } from '@/lib/brand'

/**
 * Absolute URL of a learner-site page (admin split). The console runs on its own host, so a
 * relative link such as `/p/alice` would 404 here. Server code gets LEARNER_SITE_URL through
 * BRAND.siteUrl; client bundles fall back to the production learner URL.
 */
export function learnerUrl(path: string): string {
  return `${BRAND.siteUrl}${path.startsWith('/') ? path : `/${path}`}`
}
