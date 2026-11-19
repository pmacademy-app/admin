import type { SupabaseClient } from '@supabase/supabase-js'
import { CAPSTONE_DEFINITIONS } from '@/config/capstones'
import type { Database } from '@/lib/supabase'
import { revalidateLearner } from '@/lib/learner-revalidate'

/**
 * Admin copy (split from the web repo). Purges the cached public portfolio pages of one learner
 * on the learner site through `revalidateLearner`.
 *
 * /p/[username] and /p/[username]/capstones/[moduleSlug] are ISR pages on the learner site, served
 * only under the trimmed lowercase username, and paths are case-sensitive. Best effort: a failed
 * purge must never fail the write that triggered it.
 */

/** The one spelling of a username the public pages are served and cached under. */
function canonicalUsername(username: string): string {
  return username.trim().toLowerCase()
}

/** Every cached public path of a learner: the portfolio and one page per capstone slug. */
export function publicPortfolioPaths(
  username: string,
  moduleSlugs: readonly string[] = Object.keys(CAPSTONE_DEFINITIONS),
): string[] {
  const handle = canonicalUsername(username)
  if (!handle) return []
  return [`/p/${handle}`, ...moduleSlugs.map((slug) => `/p/${handle}/capstones/${slug}`)]
}

/** Purges a learner's public portfolio pages. A null or empty username is a no-op. */
export async function revalidatePublicPortfolio(
  username: string | null | undefined,
  moduleSlugs?: readonly string[],
): Promise<void> {
  if (!username) return
  const paths = publicPortfolioPaths(username, moduleSlugs)
  if (paths.length === 0) return
  await revalidateLearner({ paths })
}

/**
 * Looks the learner's username up by id, then purges their public pages. For write paths that
 * know only the user id. One primary-key read; never throws.
 */
export async function revalidatePublicPortfolioForUser(
  supabase: SupabaseClient<Database>,
  userId: string,
  moduleSlugs?: readonly string[],
): Promise<void> {
  try {
    const { data } = await supabase.from('users').select('username').eq('id', userId).maybeSingle()
    await revalidatePublicPortfolio(data?.username ?? null, moduleSlugs)
  } catch {
    // Best-effort: the hourly revalidate is the backstop.
  }
}
