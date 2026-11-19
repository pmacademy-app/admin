import { maskEmailAddress } from '@/lib/monitoring/redaction'
import { SECURITY_EVENT_TYPES, type SecurityEventType } from '@/lib/security/security-events'

import type {
  AuditEntry,
  CountEntry,
  DayData,
  DigestSeverity,
  DigestSummary,
  EventTotal,
  Finding,
  FindingSeverity,
  RuleId,
} from './types'

/*
 * Deterministic rules for the daily security summary. No AI, no free text: every
 * sentence below is a fixed template filled with counts. Thresholds are named
 * constants so the README and the tests can quote them.
 */

// credential_stuffing: one network failing logins against many accounts.
export const STUFFING_MIN_FAILURES = 30
export const STUFFING_MIN_DISTINCT_SUBJECTS = 10
// brute_force_account: one account failing many times, from any networks.
export const BRUTE_FORCE_MIN_FAILURES = 20
// admin_login_attack
export const ADMIN_ATTACK_MIN_FAILURES = 10
// non_admin_probing
export const NON_ADMIN_PROBING_MIN = 3
// secret_probing
export const SECRET_PROBING_MEDIUM = 5
export const SECRET_PROBING_HIGH = 50
// csrf_attempts
export const CSRF_LOW = 20
export const CSRF_MEDIUM = 200
// reset_spam
export const RESET_PER_SUBJECT_MIN = 5
export const RESET_SPIKE_MULTIPLIER = 3
export const RESET_SPIKE_MIN_TOTAL = 20
// bot_signups
export const BOT_SIGNUP_BLOCKED_MIN = 20
export const SIGNUP_SPIKE_MULTIPLIER = 3
export const SIGNUP_SPIKE_MIN = 20
// quiz_abuse
export const QUIZ_ABUSE_MIN = 20
// error_spike
export const ERROR_CRITICAL_MIN = 1
export const ERROR_NEW_FINGERPRINTS_MIN = 10
export const ERROR_REGRESSIONS_MIN = 1

/** Entries shown in evidence tables and in the summary's top lists. */
export const TOP_N = 5

export const LOGIN_FAILURE_TYPES: readonly SecurityEventType[] = ['login_failed', 'admin_login_failed']
export const SECRET_FAILURE_TYPES: readonly SecurityEventType[] = [
  'webhook_auth_failed',
  'email_hook_auth_failed',
  'cron_auth_failed',
  'internal_revalidate_auth_failed',
]
/** Event types that count toward "top networks by failures". */
export const FAILURE_TYPES: readonly SecurityEventType[] = [
  ...LOGIN_FAILURE_TYPES,
  'admin_login_non_admin',
  'turnstile_failed',
  ...SECRET_FAILURE_TYPES,
]
export const RATE_LIMITED_TYPES: readonly SecurityEventType[] = SECURITY_EVENT_TYPES.filter((t) =>
  t.endsWith('_rate_limited')
)

/** Audit actions that change who is an admin. */
export const PRIVILEGE_GRANT_ACTIONS: readonly string[] = ['grant_admin_role']
/** Other audit actions worth a second look. */
export const SENSITIVE_AUDIT_ACTIONS: readonly string[] = [
  'revoke_admin_role',
  'admin_user_deleted',
  'admin_reset_progress',
  'admin_reset_module',
  'system_error_ignored',
  'system_error_unignored',
  'email_digest_schedule_updated',
]

export const SEVERITY_RANK: Record<DigestSeverity, number> = { none: 0, low: 1, medium: 2, high: 3 }

const RULE_ORDER: readonly RuleId[] = [
  'credential_stuffing',
  'brute_force_account',
  'admin_login_attack',
  'non_admin_probing',
  'secret_probing',
  'csrf_attempts',
  'reset_spam',
  'bot_signups',
  'client_error_flood',
  'quiz_abuse',
  'privilege_changes',
  'error_spike',
  'rate_limit_trips',
]

// ---------------------------------------------------------------------------
// Aggregation helpers
// ---------------------------------------------------------------------------

function plural(n: number, singular: string, pluralForm = `${singular}s`): string {
  return `${n} ${n === 1 ? singular : pluralForm}`
}

/** Defensive: a hint that still looks like a raw email is masked before display. */
export function safeHint(hint: string | null | undefined): string {
  if (!hint) return 'unknown account'
  if (hint.includes('@') && !hint.includes('*')) return maskEmailAddress(hint)
  return hint
}

function sumTypes(totals: Partial<Record<string, number>>, types: readonly string[]): number {
  return types.reduce((acc, t) => acc + (totals[t] ?? 0), 0)
}

export function totalsByType(data: DayData): Partial<Record<string, number>> {
  const totals: Partial<Record<string, number>> = {}
  for (const row of data.events) totals[row.event_type] = (totals[row.event_type] ?? 0) + row.count
  return totals
}

function baselineAverage(data: DayData, types: readonly string[]): number {
  if (data.baseline.length === 0) return 0
  const sum = data.baseline.reduce((acc, d) => acc + sumTypes(d.totals, types), 0)
  return sum / data.baseline.length
}

/**
 * Days in the baseline window with any recorded security event. The event table starts empty when
 * the migration is applied, so a spike rule built on it only applies once there is some history;
 * otherwise the first week compares every day against a near-zero average.
 */
export const MIN_BASELINE_DAYS_WITH_DATA = 3

function baselineDaysWithData(data: DayData): number {
  return data.baseline.filter((d) => Object.values(d.totals).some((v) => (v ?? 0) > 0)).length
}

function average(values: number[]): number {
  return values.length === 0 ? 0 : values.reduce((a, b) => a + b, 0) / values.length
}

export function changePct(count: number, avg: number): number | null {
  if (avg === 0) return count === 0 ? 0 : null
  return Math.round(((count - avg) / avg) * 100)
}

interface IpGroup {
  ip: string
  count: number
  subjects: Set<string>
}

interface SubjectGroup {
  hash: string
  hint: string | null
  count: number
  adminFailures: number
  ips: Map<string, number>
}

function groupByIp(data: DayData, types: readonly string[]): IpGroup[] {
  const groups = new Map<string, IpGroup>()
  for (const row of data.events) {
    if (!types.includes(row.event_type) || !row.ip_bucket) continue
    const g = groups.get(row.ip_bucket) ?? { ip: row.ip_bucket, count: 0, subjects: new Set<string>() }
    g.count += row.count
    if (row.subject_hash) g.subjects.add(row.subject_hash)
    groups.set(row.ip_bucket, g)
  }
  return sortGroups([...groups.values()], (g) => g.ip)
}

function groupBySubject(data: DayData, types: readonly string[]): SubjectGroup[] {
  const groups = new Map<string, SubjectGroup>()
  for (const row of data.events) {
    if (!types.includes(row.event_type) || !row.subject_hash) continue
    const g =
      groups.get(row.subject_hash) ??
      ({ hash: row.subject_hash, hint: null, count: 0, adminFailures: 0, ips: new Map() } as SubjectGroup)
    g.count += row.count
    if (row.event_type === 'admin_login_failed') g.adminFailures += row.count
    if (!g.hint && row.subject_hint) g.hint = row.subject_hint
    if (row.ip_bucket) g.ips.set(row.ip_bucket, (g.ips.get(row.ip_bucket) ?? 0) + row.count)
    groups.set(row.subject_hash, g)
  }
  return sortGroups([...groups.values()], (g) => g.hash)
}

/** Count descending, then key ascending, so output never depends on row order. */
function sortGroups<T extends { count: number }>(groups: T[], key: (g: T) => string): T[] {
  return groups.sort((a, b) => b.count - a.count || key(a).localeCompare(key(b)))
}

function ipEntries(groups: IpGroup[]): CountEntry[] {
  return groups.slice(0, TOP_N).map((g) => ({ label: g.ip, count: g.count }))
}

function subjectEntries(groups: SubjectGroup[]): CountEntry[] {
  return groups.slice(0, TOP_N).map((g) => ({ label: safeHint(g.hint), count: g.count }))
}

function ipsOfSubjects(groups: SubjectGroup[]): CountEntry[] {
  const merged = new Map<string, number>()
  for (const g of groups) for (const [ip, n] of g.ips) merged.set(ip, (merged.get(ip) ?? 0) + n)
  return sortGroups(
    [...merged.entries()].map(([label, count]) => ({ label, count })),
    (e) => e.label
  ).slice(0, TOP_N)
}

function finding(
  id: RuleId,
  severity: FindingSeverity,
  title: string,
  detail: string,
  phrase: string,
  evidence: Partial<Finding['evidence']> = {}
): Finding {
  return {
    id,
    severity,
    title,
    detail,
    phrase,
    evidence: {
      counts: evidence.counts ?? {},
      topIpBuckets: evidence.topIpBuckets ?? [],
      maskedSubjects: evidence.maskedSubjects ?? [],
      ...(evidence.items ? { items: evidence.items } : {}),
    },
  }
}

function describeAudit(entry: AuditEntry): string {
  const target = entry.target_id ? `${entry.target_resource ?? 'item'} ${entry.target_id}` : entry.target_resource ?? 'item'
  const by = entry.admin_email ? safeHint(entry.admin_email) : 'unknown admin'
  return `${entry.action} on ${target} by ${by} at ${entry.created_at}`
}

function isSensitiveAudit(entry: AuditEntry): boolean {
  if (SENSITIVE_AUDIT_ACTIONS.includes(entry.action)) return true
  if (entry.action.includes('bulk') || entry.target_resource === 'bulk') return true
  // Settings sections are written as update_<section>_settings against target 'settings'.
  return entry.target_resource === 'settings' && entry.action.startsWith('update_')
}

// ---------------------------------------------------------------------------
// Rules
// ---------------------------------------------------------------------------

type Rule = (data: DayData, totals: Partial<Record<string, number>>) => Finding | null

const credentialStuffing: Rule = (data) => {
  const offenders = groupByIp(data, LOGIN_FAILURE_TYPES).filter(
    (g) => g.count >= STUFFING_MIN_FAILURES && g.subjects.size >= STUFFING_MIN_DISTINCT_SUBJECTS
  )
  if (offenders.length === 0) return null
  const failures = offenders.reduce((a, g) => a + g.count, 0)
  const accounts = offenders.reduce((a, g) => a + g.subjects.size, 0)
  return finding(
    'credential_stuffing',
    'high',
    'Possible credential stuffing',
    `${plural(offenders.length, 'network')} failed ${plural(failures, 'login')} across ${plural(accounts, 'account')} (threshold: ${STUFFING_MIN_FAILURES} failures over ${STUFFING_MIN_DISTINCT_SUBJECTS} accounts from one network).`,
    `possible credential stuffing from ${plural(offenders.length, 'network')}`,
    {
      counts: { networks: offenders.length, failures, accounts },
      topIpBuckets: offenders.slice(0, TOP_N).map((g) => ({ label: `${g.ip} (${plural(g.subjects.size, 'account')})`, count: g.count })),
    }
  )
}

const bruteForceAccount: Rule = (data) => {
  const offenders = groupBySubject(data, LOGIN_FAILURE_TYPES).filter((g) => g.count >= BRUTE_FORCE_MIN_FAILURES)
  if (offenders.length === 0) return null
  const adminTargeted = offenders.some((g) => g.adminFailures > 0)
  const failures = offenders.reduce((a, g) => a + g.count, 0)
  return finding(
    'brute_force_account',
    adminTargeted ? 'high' : 'medium',
    adminTargeted ? 'Brute force against an admin login' : 'Brute force against accounts',
    `${plural(offenders.length, 'account')} had ${BRUTE_FORCE_MIN_FAILURES} or more failed logins (${failures} in total)${adminTargeted ? ', including attempts on the admin console' : ''}.`,
    `${plural(offenders.length, 'account')} under brute force`,
    {
      counts: { accounts: offenders.length, failures },
      topIpBuckets: ipsOfSubjects(offenders),
      maskedSubjects: subjectEntries(offenders),
    }
  )
}

const adminLoginAttack: Rule = (data, totals) => {
  const rateLimited = totals.admin_login_rate_limited ?? 0
  const failed = totals.admin_login_failed ?? 0
  if (rateLimited === 0 && failed < ADMIN_ATTACK_MIN_FAILURES) return null
  return finding(
    'admin_login_attack',
    'high',
    'Admin login under attack',
    `The admin console saw ${plural(failed, 'failed login')} and ${plural(rateLimited, 'rate limited attempt')} (threshold: any rate limiting or ${ADMIN_ATTACK_MIN_FAILURES} failures).`,
    'admin login attempts blocked',
    {
      counts: { admin_login_failed: failed, admin_login_rate_limited: rateLimited },
      topIpBuckets: ipEntries(groupByIp(data, ['admin_login_failed', 'admin_login_rate_limited'])),
      maskedSubjects: subjectEntries(groupBySubject(data, ['admin_login_failed', 'admin_login_rate_limited'])),
    }
  )
}

const nonAdminProbing: Rule = (data, totals) => {
  const count = totals.admin_login_non_admin ?? 0
  if (count < NON_ADMIN_PROBING_MIN) return null
  return finding(
    'non_admin_probing',
    'medium',
    'Non-admin accounts probing the admin console',
    `${plural(count, 'valid non-admin sign-in')} reached the admin console (threshold: ${NON_ADMIN_PROBING_MIN}).`,
    `${plural(count, 'non-admin sign-in')} on the admin console`,
    {
      counts: { admin_login_non_admin: count },
      topIpBuckets: ipEntries(groupByIp(data, ['admin_login_non_admin'])),
      maskedSubjects: subjectEntries(groupBySubject(data, ['admin_login_non_admin'])),
    }
  )
}

const secretProbing: Rule = (data, totals) => {
  const total = sumTypes(totals, SECRET_FAILURE_TYPES)
  if (total < SECRET_PROBING_MEDIUM) return null
  const counts = Object.fromEntries(SECRET_FAILURE_TYPES.map((t) => [t, totals[t] ?? 0]))
  return finding(
    'secret_probing',
    total >= SECRET_PROBING_HIGH ? 'high' : 'medium',
    'Requests with a wrong shared secret',
    `${plural(total, 'request')} to webhook, email hook, cron or internal endpoints presented a wrong secret (medium at ${SECRET_PROBING_MEDIUM}, high at ${SECRET_PROBING_HIGH}).`,
    `${plural(total, 'wrong-secret request')}`,
    { counts, topIpBuckets: ipEntries(groupByIp(data, SECRET_FAILURE_TYPES)) }
  )
}

const csrfAttempts: Rule = (data, totals) => {
  const count = totals.origin_rejected ?? 0
  if (count < CSRF_LOW) return null
  return finding(
    'csrf_attempts',
    count >= CSRF_MEDIUM ? 'medium' : 'low',
    'Cross-origin writes refused',
    `${plural(count, 'cookie-bearing request')} from another origin was refused (low at ${CSRF_LOW}, medium at ${CSRF_MEDIUM}).`,
    `${plural(count, 'cross-origin write')} refused`,
    { counts: { origin_rejected: count }, topIpBuckets: ipEntries(groupByIp(data, ['origin_rejected'])) }
  )
}

const resetSpam: Rule = (data, totals) => {
  const total = totals.password_reset_requested ?? 0
  const avg = baselineAverage(data, ['password_reset_requested'])
  const targeted = groupBySubject(data, ['password_reset_requested']).filter((g) => g.count >= RESET_PER_SUBJECT_MIN)
  const spike =
    baselineDaysWithData(data) >= MIN_BASELINE_DAYS_WITH_DATA &&
    total >= RESET_SPIKE_MIN_TOTAL &&
    total > avg * RESET_SPIKE_MULTIPLIER
  if (targeted.length === 0 && !spike) return null
  const reasons: string[] = []
  if (targeted.length > 0) reasons.push(`${plural(targeted.length, 'account')} got ${RESET_PER_SUBJECT_MIN} or more reset requests`)
  if (spike) reasons.push(`${total} resets is more than ${RESET_SPIKE_MULTIPLIER}x the 7-day average of ${avg.toFixed(1)}`)
  return finding(
    'reset_spam',
    'medium',
    'Password reset spam',
    `${reasons.join('; ')}.`,
    `${plural(total, 'password reset')} requested`,
    {
      counts: { password_reset_requested: total, avg7: Math.round(avg * 10) / 10 },
      topIpBuckets: ipEntries(groupByIp(data, ['password_reset_requested'])),
      maskedSubjects: subjectEntries(targeted.length > 0 ? targeted : groupBySubject(data, ['password_reset_requested'])),
    }
  )
}

const botSignups: Rule = (data, totals) => {
  const blocked = (totals.signup_blocked ?? 0) + (totals.turnstile_failed ?? 0)
  const signups = data.signups.count
  const avg = average(data.signups.baselineDaily)
  const blockedHit = blocked >= BOT_SIGNUP_BLOCKED_MIN
  const spike = signups >= SIGNUP_SPIKE_MIN && signups > avg * SIGNUP_SPIKE_MULTIPLIER
  if (!blockedHit && !spike) return null
  const reasons: string[] = []
  if (blockedHit) reasons.push(`${plural(blocked, 'signup')} blocked or failed the bot check (threshold: ${BOT_SIGNUP_BLOCKED_MIN})`)
  if (spike) reasons.push(`${plural(signups, 'new signup')} is more than ${SIGNUP_SPIKE_MULTIPLIER}x the 7-day average of ${avg.toFixed(1)} (possible bot wave)`)
  return finding(
    'bot_signups',
    blockedHit ? 'medium' : 'low',
    'Bot signups',
    `${reasons.join('; ')}.`,
    blockedHit ? `${plural(blocked, 'bot signup')} blocked` : 'possible bot signup wave',
    {
      counts: {
        signup_blocked: totals.signup_blocked ?? 0,
        turnstile_failed: totals.turnstile_failed ?? 0,
        signups,
        signups_avg7: Math.round(avg * 10) / 10,
      },
      topIpBuckets: ipEntries(groupByIp(data, ['signup_blocked', 'turnstile_failed'])),
    }
  )
}

const clientErrorFlood: Rule = (data, totals) => {
  const count = totals.client_errors_flood ?? 0
  if (count === 0) return null
  return finding(
    'client_error_flood',
    'medium',
    'Client error report flood',
    `The client error beacon hit its flood cap ${plural(count, 'time')}.`,
    'client error reports flooded',
    { counts: { client_errors_flood: count }, topIpBuckets: ipEntries(groupByIp(data, ['client_errors_flood'])) }
  )
}

const quizAbuse: Rule = (data, totals) => {
  const count = totals.quiz_check_rate_limited ?? 0
  if (count < QUIZ_ABUSE_MIN) return null
  return finding(
    'quiz_abuse',
    'low',
    'Quiz answer checking throttled',
    `${plural(count, 'quiz check')} was rate limited (threshold: ${QUIZ_ABUSE_MIN}).`,
    `${plural(count, 'quiz check')} throttled`,
    {
      counts: { quiz_check_rate_limited: count },
      topIpBuckets: ipEntries(groupByIp(data, ['quiz_check_rate_limited'])),
      maskedSubjects: subjectEntries(groupBySubject(data, ['quiz_check_rate_limited'])),
    }
  )
}

const privilegeChanges: Rule = (data) => {
  const grants = data.audit.filter((e) => PRIVILEGE_GRANT_ACTIONS.includes(e.action))
  const sensitive = data.audit.filter((e) => !PRIVILEGE_GRANT_ACTIONS.includes(e.action) && isSensitiveAudit(e))
  if (grants.length === 0 && sensitive.length === 0) return null
  const counts: Record<string, number> = {}
  for (const e of [...grants, ...sensitive]) counts[e.action] = (counts[e.action] ?? 0) + 1
  const items = [...grants, ...sensitive].slice(0, 20).map(describeAudit)
  const phraseParts: string[] = []
  if (grants.length > 0) phraseParts.push(`${plural(grants.length, 'admin role')} granted`)
  if (sensitive.length > 0) phraseParts.push(`${plural(sensitive.length, 'sensitive admin action')}`)
  return finding(
    'privilege_changes',
    grants.length > 0 ? 'high' : 'low',
    grants.length > 0 ? 'Admin role granted' : 'Sensitive admin actions',
    grants.length > 0
      ? `${plural(grants.length, 'admin role grant')} recorded in the audit log. Confirm each one was intended.`
      : `${plural(sensitive.length, 'sensitive admin action')} recorded in the audit log.`,
    phraseParts.join(', '),
    { counts, items }
  )
}

const errorSpike: Rule = (data) => {
  const { bySeverity, newFingerprints, regressions } = data.errors
  const critical = bySeverity.critical
  const isMedium = critical >= ERROR_CRITICAL_MIN
  const isLow = newFingerprints >= ERROR_NEW_FINGERPRINTS_MIN || regressions >= ERROR_REGRESSIONS_MIN
  if (!isMedium && !isLow) return null
  const reasons: string[] = []
  if (isMedium) reasons.push(`${plural(critical, 'critical error')}`)
  if (newFingerprints >= ERROR_NEW_FINGERPRINTS_MIN) reasons.push(`${plural(newFingerprints, 'new error group')}`)
  if (regressions >= ERROR_REGRESSIONS_MIN) reasons.push(`${plural(regressions, 'regression')}`)
  return finding(
    'error_spike',
    isMedium ? 'medium' : 'low',
    'System errors need a look',
    `${reasons.join(', ')} recorded (critical at ${ERROR_CRITICAL_MIN}, new groups at ${ERROR_NEW_FINGERPRINTS_MIN}, regressions at ${ERROR_REGRESSIONS_MIN}).`,
    reasons.join(', '),
    {
      counts: {
        critical,
        error: bySeverity.error,
        warning: bySeverity.warning,
        auth: data.errors.byCategory.auth,
        webhook: data.errors.byCategory.webhook,
        new_fingerprints: newFingerprints,
        regressions,
      },
    }
  )
}

const rateLimitTrips: Rule = (data, totals) => {
  const tripped = RATE_LIMITED_TYPES.filter((t) => (totals[t] ?? 0) > 0)
  if (tripped.length === 0) return null
  const total = sumTypes(totals, tripped)
  return finding(
    'rate_limit_trips',
    'low',
    'Rate limits tripped',
    `${plural(total, 'request')} hit a rate limit across ${plural(tripped.length, 'limiter')}.`,
    `${plural(total, 'rate limit trip')}`,
    {
      counts: Object.fromEntries(tripped.map((t) => [t, totals[t] ?? 0])),
      topIpBuckets: ipEntries(groupByIp(data, tripped)),
      items: tripped.map((t) => `${t}: ${totals[t] ?? 0}`),
    }
  )
}

const RULES: Record<RuleId, Rule> = {
  credential_stuffing: credentialStuffing,
  brute_force_account: bruteForceAccount,
  admin_login_attack: adminLoginAttack,
  non_admin_probing: nonAdminProbing,
  secret_probing: secretProbing,
  csrf_attempts: csrfAttempts,
  reset_spam: resetSpam,
  bot_signups: botSignups,
  client_error_flood: clientErrorFlood,
  quiz_abuse: quizAbuse,
  privilege_changes: privilegeChanges,
  error_spike: errorSpike,
  rate_limit_trips: rateLimitTrips,
}

/**
 * Runs every rule over one day of data. Findings come back highest severity
 * first, then in the fixed rule order, so the same data always gives the same list.
 */
export function evaluateRules(data: DayData): Finding[] {
  const totals = totalsByType(data)
  const found: Finding[] = []
  for (const id of RULE_ORDER) {
    const result = RULES[id](data, totals)
    if (result) found.push(result)
  }
  return found.sort(
    (a, b) => SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity] || RULE_ORDER.indexOf(a.id) - RULE_ORDER.indexOf(b.id)
  )
}

/** Highest finding severity, or 'none'. */
export function overallSeverity(findings: Finding[]): DigestSeverity {
  return findings.reduce<DigestSeverity>(
    (acc, f) => (SEVERITY_RANK[f.severity] > SEVERITY_RANK[acc] ? f.severity : acc),
    'none'
  )
}

export function severityCounts(findings: Finding[]): Record<FindingSeverity, number> {
  const counts: Record<FindingSeverity, number> = { high: 0, medium: 0, low: 0 }
  for (const f of findings) counts[f.severity] += 1
  return counts
}

/** Phrases named in the headline. More than this and the headline says "and N more". */
export const HEADLINE_MAX_PHRASES = 3

/**
 * One plain sentence, e.g.
 * "2 high, 1 medium findings: possible credential stuffing from 1 network, 1 admin role granted".
 */
export function buildHeadline(day: string, findings: Finding[]): string {
  if (findings.length === 0) return `No findings for ${day}.`
  const counts = severityCounts(findings)
  const parts = (['high', 'medium', 'low'] as const).filter((s) => counts[s] > 0).map((s) => `${counts[s]} ${s}`)
  const noun = findings.length === 1 ? 'finding' : 'findings'
  const phrases = findings.slice(0, HEADLINE_MAX_PHRASES).map((f) => f.phrase)
  const rest = findings.length - phrases.length
  const tail = rest > 0 ? `, and ${rest} more` : ''
  return `${parts.join(', ')} ${noun}: ${phrases.join(', ')}${tail}`
}

function eventTotals(data: DayData, totals: Partial<Record<string, number>>): EventTotal[] {
  return SECURITY_EVENT_TYPES.map((type) => {
    const count = totals[type] ?? 0
    const avg7 = baselineAverage(data, [type])
    return { type, count, avg7: Math.round(avg7 * 10) / 10, changePct: changePct(count, avg7) }
  })
}

/** The summary object stored in security_digests.summary. */
export function buildSummary(data: DayData, findings: Finding[]): DigestSummary {
  const totals = totalsByType(data)
  const signupAvg = average(data.signups.baselineDaily)
  const accountTypes: readonly string[] = [...LOGIN_FAILURE_TYPES, 'admin_login_non_admin', 'password_reset_requested']
  return {
    day: data.day,
    timezone: data.timezone,
    headline: buildHeadline(data.day, findings),
    severityCounts: severityCounts(findings),
    totals: eventTotals(data, totals),
    topIpBuckets: ipEntries(groupByIp(data, FAILURE_TYPES)),
    topAccounts: subjectEntries(groupBySubject(data, accountTypes)),
    signups: {
      count: data.signups.count,
      avg7: Math.round(signupAvg * 10) / 10,
      changePct: changePct(data.signups.count, signupAvg),
    },
    errors: data.errors,
    dataGaps: data.dataGaps,
  }
}
