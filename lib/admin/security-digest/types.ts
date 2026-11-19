import type { SecurityEventType } from '@/lib/security/security-events'

export type DigestSeverity = 'none' | 'low' | 'medium' | 'high'
export type FindingSeverity = Exclude<DigestSeverity, 'none'>

/** The migration (in the web repo) that creates the tables this feature reads and writes. */
export const SECURITY_EVENTS_MIGRATION = '20261119000007_security_events.sql'

/** One row of public.security_event_counts. */
export interface SecurityEventCountRow {
  day: string
  event_type: string
  app: string
  ip_bucket: string
  subject_hash: string
  subject_hint: string | null
  sample_path: string | null
  count: number
  first_seen: string | null
  last_seen: string | null
}

export interface AuditEntry {
  action: string
  target_resource: string | null
  target_id: string | null
  admin_email: string | null
  created_at: string
}

export interface ErrorStats {
  total: number
  bySeverity: { critical: number; error: number; warning: number }
  byCategory: { auth: number; webhook: number }
  newFingerprints: number
  regressions: number
}

/** Per-day totals by event type for one baseline day. */
export interface BaselineDay {
  day: string
  totals: Partial<Record<string, number>>
}

/** Everything the rules look at for one day. Produced by collectDayData. */
export interface DayData {
  day: string
  timezone: string
  /** security_event_counts rows for `day`. */
  events: SecurityEventCountRow[]
  /** The 7 days before `day`, oldest first, zero-filled. */
  baseline: BaselineDay[]
  audit: AuditEntry[]
  errors: ErrorStats
  signups: { count: number; baselineDaily: number[] }
  /** Tables that do not exist yet (42P01 / PGRST205). */
  missingTables: string[]
  /** Sources that failed for another reason; their data is empty in this digest. */
  dataGaps: string[]
}

export interface CountEntry {
  label: string
  count: number
}

export interface FindingEvidence {
  counts: Record<string, number>
  topIpBuckets: CountEntry[]
  maskedSubjects: CountEntry[]
  /** Listed items (audit actions, per-type totals) for rules that enumerate. */
  items?: string[]
}

export type RuleId =
  | 'credential_stuffing'
  | 'brute_force_account'
  | 'admin_login_attack'
  | 'non_admin_probing'
  | 'secret_probing'
  | 'csrf_attempts'
  | 'reset_spam'
  | 'bot_signups'
  | 'client_error_flood'
  | 'quiz_abuse'
  | 'privilege_changes'
  | 'error_spike'
  | 'rate_limit_trips'

export interface Finding {
  id: RuleId
  severity: FindingSeverity
  title: string
  detail: string
  /** Short fixed-template phrase used in the headline, e.g. "1 admin role granted". */
  phrase: string
  evidence: FindingEvidence
}

export interface EventTotal {
  type: SecurityEventType
  count: number
  avg7: number
  /** Percent change against the 7-day average; null when the average is 0 and the count is not. */
  changePct: number | null
}

export interface DigestDelivery {
  webhookSentAt: string | null
  notifiedAt: string | null
}

export interface DigestSummary {
  day: string
  timezone: string
  headline: string
  severityCounts: Record<FindingSeverity, number>
  totals: EventTotal[]
  topIpBuckets: CountEntry[]
  topAccounts: CountEntry[]
  signups: { count: number; avg7: number; changePct: number | null }
  errors: ErrorStats
  dataGaps: string[]
  delivery?: DigestDelivery
}

export interface SecurityDigestRow {
  day: string
  generated_at: string
  severity: DigestSeverity
  summary: DigestSummary
  findings: Finding[]
}
