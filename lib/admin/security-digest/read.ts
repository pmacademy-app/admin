import { isMissingRelationError, type DigestDb } from './db'
import type { DigestSeverity, SecurityDigestRow } from './types'

/** Digests listed on the console page. */
export const DIGEST_HISTORY_LIMIT = 30

export interface DigestListItem {
  day: string
  severity: DigestSeverity
  generated_at: string
}

export type DigestPageData =
  | { status: 'not_set_up' }
  | { status: 'error' }
  | { status: 'ok'; history: DigestListItem[]; selected: SecurityDigestRow | null }

/**
 * Loads the console page data: the last 30 digests and the selected one (the
 * requested day, else the newest). A missing table is reported as not set up.
 */
export async function loadDigestPageData(db: DigestDb, day?: string | null): Promise<DigestPageData> {
  try {
    const history = await db
      .from('security_digests')
      .select('day, severity, generated_at')
      .order('day', { ascending: false })
      .limit(DIGEST_HISTORY_LIMIT)
    if (history.error) return isMissingRelationError(history.error) ? { status: 'not_set_up' } : { status: 'error' }
    const items = (Array.isArray(history.data) ? history.data : []) as DigestListItem[]

    const target = day ?? items[0]?.day ?? null
    if (!target) return { status: 'ok', history: items, selected: null }

    const selected = await db
      .from('security_digests')
      .select('day, generated_at, severity, summary, findings')
      .eq('day', target)
      .maybeSingle()
    if (selected.error) return isMissingRelationError(selected.error) ? { status: 'not_set_up' } : { status: 'error' }
    return { status: 'ok', history: items, selected: (selected.data as SecurityDigestRow | null) ?? null }
  } catch {
    return { status: 'error' }
  }
}
