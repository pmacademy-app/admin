import { log } from '@/lib/monitoring/log'

/**
 * Cross-app cache refresh for the learner site.
 *
 * The admin console runs as its own Vercel project, so `revalidatePath` and `revalidateTag`
 * here only reach the admin app's own cache. Anything the learner site caches (system settings,
 * the weekly leaderboard, testimonials, learner pages, public portfolios and OG cards) has to be
 * purged by the learner app itself. This helper asks it to, through
 * `POST ${LEARNER_SITE_URL}/api/internal/revalidate` with a shared bearer secret.
 *
 * Best effort by design: a failed purge must never fail the admin write that triggered it. The
 * learner caches all have their own revalidate windows as a backstop. It never throws, logs a
 * warning without the secret or the URL query, and is a no-op when either env var is missing.
 */

export interface LearnerRevalidateTag {
  tag: string
  /** Seconds. `0` expires the entry at once; omitted means the learner app's default profile. */
  expire?: number
}

export interface LearnerRevalidateInput {
  tags?: LearnerRevalidateTag[]
  paths?: string[]
}

export type LearnerRevalidateResult = 'sent' | 'skipped' | 'failed'

export const LEARNER_REVALIDATE_PATH = '/api/internal/revalidate'
export const LEARNER_REVALIDATE_TIMEOUT_MS = 5000

// Warn once per process when unconfigured (local dev, tests), not on every write.
let warnedNotConfigured = false

function learnerBaseUrl(): string | null {
  const raw = process.env.LEARNER_SITE_URL?.trim()
  if (!raw) return null
  try {
    const url = new URL(raw)
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return null
    return url.origin
  } catch {
    return null
  }
}

export async function revalidateLearner(input: LearnerRevalidateInput): Promise<LearnerRevalidateResult> {
  try {
    const tags = (input.tags ?? []).filter((t) => t && typeof t.tag === 'string' && t.tag.length > 0)
    const paths = [...new Set((input.paths ?? []).filter((p) => typeof p === 'string' && p.startsWith('/')))]
    if (tags.length === 0 && paths.length === 0) return 'skipped'

    const base = learnerBaseUrl()
    const secret = process.env.INTERNAL_REVALIDATE_SECRET?.trim()
    if (!base || !secret) {
      if (warnedNotConfigured) return 'skipped'
      warnedNotConfigured = true
      log.warn('learner_revalidate.not_configured', {
        hasUrl: Boolean(base),
        hasSecret: Boolean(secret),
      })
      return 'skipped'
    }

    const body: LearnerRevalidateInput = {}
    if (tags.length > 0) body.tags = tags.map((t) => (t.expire === undefined ? { tag: t.tag } : { tag: t.tag, expire: t.expire }))
    if (paths.length > 0) body.paths = paths

    const res = await fetch(`${base}${LEARNER_REVALIDATE_PATH}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${secret}`,
      },
      body: JSON.stringify(body),
      cache: 'no-store',
      signal: AbortSignal.timeout(LEARNER_REVALIDATE_TIMEOUT_MS),
    })
    if (!res.ok) {
      log.warn('learner_revalidate.rejected', { status: res.status, tags: tags.length, paths: paths.length })
      return 'failed'
    }
    return 'sent'
  } catch (err) {
    const name = err instanceof Error ? err.name : 'Error'
    log.warn('learner_revalidate.failed', { reason: name })
    return 'failed'
  }
}
