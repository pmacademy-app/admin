import { CAPSTONE_DEFINITIONS } from '@/config/capstones'
import { capstoneOgCardPath, portfolioOgCardPath } from '@/lib/og/card-paths'
import { revalidateLearner } from '@/lib/learner-revalidate'

/**
 * Admin copy (split from the web repo). The OG card routes live on the learner site, so the
 * purge goes through `revalidateLearner` instead of a local `revalidatePath`.
 *
 * Paths are case-sensitive and the card routes only ever render under the lowercase username
 * (lib/og/card-paths.ts), so that path is the one that matters. The stored-case path is purged
 * as well when it differs, for entries cached before the routes started redirecting.
 */
function cardPaths(canonicalPath: string, storedCasePath: string): string[] {
  return [...new Set([canonicalPath, storedCasePath])]
}

/** Every capstone OG card path for a learner. */
export function capstoneOgCardPaths(
  username: string,
  moduleSlugs: readonly string[] = Object.keys(CAPSTONE_DEFINITIONS),
): string[] {
  return moduleSlugs.flatMap((slug) =>
    cardPaths(capstoneOgCardPath(username, slug), `/api/og/portfolio/${username}/capstones/${slug}`),
  )
}

/** The portfolio OG card path(s) for a learner. */
export function portfolioOgCardPaths(username: string): string[] {
  return cardPaths(portfolioOgCardPath(username), `/api/og/portfolio/${username}`)
}

/** Drops cached capstone OG cards for a learner on the learner site. Best effort, never throws. */
export async function revalidateCapstoneOgCards(
  username: string,
  moduleSlugs?: readonly string[],
): Promise<void> {
  await revalidateLearner({ paths: capstoneOgCardPaths(username, moduleSlugs) })
}

/** Drops a learner's cached portfolio OG card on the learner site. Best effort, never throws. */
export async function revalidatePortfolioOgCard(username: string): Promise<void> {
  await revalidateLearner({ paths: portfolioOgCardPaths(username) })
}
