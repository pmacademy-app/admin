import {
  fetchAllPages,
  MissingRelationError,
  rowsOrThrow,
  type DigestDb,
} from './db'
import { addDays, dayBounds, getAdminTimezone } from './time'
import type { AuditEntry, BaselineDay, DayData, ErrorStats, SecurityEventCountRow } from './types'

/** Number of days before the summarized day used for averages. */
export const BASELINE_DAYS = 7

/** Audit rows read for one day. A day with more admin actions than this is itself unusual. */
export const MAX_AUDIT_ROWS = 500
/** system_errors rows read for one day. */
export const MAX_ERROR_ROWS = 2000
/** Fingerprints checked for "seen before" per query. */
const FINGERPRINT_CHUNK = 100

const EVENT_COLUMNS =
  'day, event_type, app, ip_bucket, subject_hash, subject_hint, sample_path, count, first_seen, last_seen'

export const EMPTY_ERROR_STATS: ErrorStats = {
  total: 0,
  bySeverity: { critical: 0, error: 0, warning: 0 },
  byCategory: { auth: 0, webhook: 0 },
  newFingerprints: 0,
  regressions: 0,
}

interface Outcome<T> {
  value: T
  missing?: string
  gap?: string
}

async function guard<T>(source: string, fallback: T, run: () => Promise<T>): Promise<Outcome<T>> {
  try {
    return { value: await run() }
  } catch (err) {
    if (err instanceof MissingRelationError) return { value: fallback, missing: err.table }
    return { value: fallback, gap: source }
  }
}

function toNumber(value: unknown): number {
  const n = Number(value)
  return Number.isFinite(n) ? n : 0
}

async function readEvents(db: DigestDb, day: string): Promise<SecurityEventCountRow[]> {
  const rows = await fetchAllPages<SecurityEventCountRow>('security_event_counts', () =>
    db.from('security_event_counts').select(EVENT_COLUMNS).eq('day', day).order('event_type')
  )
  return rows.map((row) => ({
    ...row,
    ip_bucket: row.ip_bucket ?? '',
    subject_hash: row.subject_hash ?? '',
    count: toNumber(row.count),
  }))
}

async function readBaseline(db: DigestDb, day: string): Promise<BaselineDay[]> {
  const from = addDays(day, -BASELINE_DAYS)
  const rows = await fetchAllPages<{ day: string; event_type: string; count: unknown }>('security_event_counts', () =>
    db
      .from('security_event_counts')
      .select('day, event_type, count')
      .gte('day', from)
      .lt('day', day)
      .order('day')
  )
  const days: BaselineDay[] = []
  for (let i = BASELINE_DAYS; i >= 1; i--) days.push({ day: addDays(day, -i), totals: {} })
  const byDay = new Map(days.map((d) => [d.day, d]))
  for (const row of rows) {
    const bucket = byDay.get(String(row.day).slice(0, 10))
    if (!bucket) continue
    bucket.totals[row.event_type] = (bucket.totals[row.event_type] ?? 0) + toNumber(row.count)
  }
  return days
}

async function readAudit(db: DigestDb, startIso: string, endIso: string): Promise<AuditEntry[]> {
  const result = await db
    .from('admin_audit_logs')
    .select('action, target_resource, target_id, admin_email, created_at')
    .gte('created_at', startIso)
    .lt('created_at', endIso)
    .order('created_at', { ascending: true })
    .limit(MAX_AUDIT_ROWS)
  return rowsOrThrow<AuditEntry>('admin_audit_logs', result)
}

async function readErrors(db: DigestDb, startIso: string, endIso: string): Promise<ErrorStats> {
  const rows = rowsOrThrow<{
    severity: string | null
    category: string | null
    fingerprint: string | null
    first_seen_at: string | null
    details: unknown
  }>(
    'system_errors',
    await db
      .from('system_errors')
      .select('severity, category, fingerprint, first_seen_at, details')
      .gte('timestamp', startIso)
      .lt('timestamp', endIso)
      .limit(MAX_ERROR_ROWS)
  )

  const stats: ErrorStats = {
    total: rows.length,
    bySeverity: { critical: 0, error: 0, warning: 0 },
    byCategory: { auth: 0, webhook: 0 },
    newFingerprints: 0,
    regressions: 0,
  }
  const firstSeenToday = new Set<string>()
  for (const row of rows) {
    if (row.severity === 'critical' || row.severity === 'error' || row.severity === 'warning') {
      stats.bySeverity[row.severity] += 1
    }
    if (row.category === 'auth' || row.category === 'webhook') stats.byCategory[row.category] += 1
    const details = row.details && typeof row.details === 'object' ? (row.details as Record<string, unknown>) : null
    if (details?.regression === true) stats.regressions += 1
    const firstSeen = row.first_seen_at ?? ''
    if (row.fingerprint && firstSeen >= startIso && firstSeen < endIso) firstSeenToday.add(row.fingerprint)
  }

  // A fingerprint is new when no row for it was recorded before the day began.
  const candidates = [...firstSeenToday]
  const seenBefore = new Set<string>()
  for (let i = 0; i < candidates.length; i += FINGERPRINT_CHUNK) {
    const chunk = candidates.slice(i, i + FINGERPRINT_CHUNK)
    const prior = rowsOrThrow<{ fingerprint: string }>(
      'system_errors',
      await db.from('system_errors').select('fingerprint').in('fingerprint', chunk).lt('timestamp', startIso).limit(1000)
    )
    for (const row of prior) seenBefore.add(row.fingerprint)
  }
  stats.newFingerprints = candidates.filter((fp) => !seenBefore.has(fp)).length
  return stats
}

async function countSignups(db: DigestDb, day: string, tz: string): Promise<number> {
  const { startIso, endIso } = dayBounds(day, tz)
  const result = await db
    .from('users')
    .select('id', { count: 'exact', head: true })
    .gte('created_at', startIso)
    .lt('created_at', endIso)
  rowsOrThrow('users', result)
  return toNumber(result.count)
}

async function readSignups(db: DigestDb, day: string, tz: string): Promise<{ count: number; baselineDaily: number[] }> {
  const baselineDays: string[] = []
  for (let i = BASELINE_DAYS; i >= 1; i--) baselineDays.push(addDays(day, -i))
  const [count, ...baselineDaily] = await Promise.all([day, ...baselineDays].map((d) => countSignups(db, d, tz)))
  return { count, baselineDaily }
}

/**
 * Reads everything the rules need for one calendar day.
 *
 * Never throws for a data problem: a table that does not exist yet is listed in
 * `missingTables`, any other failed source in `dataGaps`, and its data is empty.
 *
 * `security_event_counts.day` is already an Asia/Kolkata calendar day (the RPC
 * computes it). The audit log, system errors and signups are bounded by local
 * midnight in ADMIN_TIMEZONE (default Asia/Kolkata).
 */
export async function collectDayData(
  db: DigestDb,
  day: string,
  options: { timezone?: string } = {}
): Promise<DayData> {
  const timezone = options.timezone ?? getAdminTimezone()
  const { startIso, endIso } = dayBounds(day, timezone)

  const emptyBaseline: BaselineDay[] = []
  for (let i = BASELINE_DAYS; i >= 1; i--) emptyBaseline.push({ day: addDays(day, -i), totals: {} })

  const [events, baseline, audit, errors, signups] = await Promise.all([
    guard('security_event_counts', [] as SecurityEventCountRow[], () => readEvents(db, day)),
    guard('security_event_counts', emptyBaseline, () => readBaseline(db, day)),
    guard('admin_audit_logs', [] as AuditEntry[], () => readAudit(db, startIso, endIso)),
    guard('system_errors', EMPTY_ERROR_STATS, () => readErrors(db, startIso, endIso)),
    guard('users', { count: 0, baselineDaily: new Array(BASELINE_DAYS).fill(0) as number[] }, () =>
      readSignups(db, day, timezone)
    ),
  ])

  const outcomes = [events, baseline, audit, errors, signups]
  const missingTables = [...new Set(outcomes.map((o) => o.missing).filter((t): t is string => Boolean(t)))]
  const dataGaps = [...new Set(outcomes.map((o) => o.gap).filter((t): t is string => Boolean(t)))]

  return {
    day,
    timezone,
    events: events.value,
    baseline: baseline.value,
    audit: audit.value,
    errors: errors.value,
    signups: signups.value,
    missingTables,
    dataGaps,
  }
}
