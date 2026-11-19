import { describe, it, expect } from 'vitest'

import {
  ADMIN_ATTACK_MIN_FAILURES,
  BOT_SIGNUP_BLOCKED_MIN,
  BRUTE_FORCE_MIN_FAILURES,
  CSRF_LOW,
  CSRF_MEDIUM,
  NON_ADMIN_PROBING_MIN,
  QUIZ_ABUSE_MIN,
  RESET_PER_SUBJECT_MIN,
  RESET_SPIKE_MIN_TOTAL,
  SECRET_PROBING_HIGH,
  SECRET_PROBING_MEDIUM,
  SIGNUP_SPIKE_MIN,
  STUFFING_MIN_DISTINCT_SUBJECTS,
  STUFFING_MIN_FAILURES,
  buildHeadline,
  buildSummary,
  evaluateRules,
  overallSeverity,
} from '@/lib/admin/security-digest/rules'
import { buildDigestText, DIGEST_TEXT_MAX_CHARS } from '@/lib/admin/security-digest/text'
import type { AuditEntry, DayData, Finding, SecurityEventCountRow } from '@/lib/admin/security-digest/types'

const DAY = '2026-11-18'

function ev(event_type: string, count: number, over: Partial<SecurityEventCountRow> = {}): SecurityEventCountRow {
  return {
    day: DAY,
    event_type,
    app: 'web',
    ip_bucket: '',
    subject_hash: '',
    subject_hint: null,
    sample_path: null,
    count,
    first_seen: null,
    last_seen: null,
    ...over,
  }
}

function dayData(over: Partial<DayData> = {}): DayData {
  return {
    day: DAY,
    timezone: 'Asia/Kolkata',
    events: [],
    baseline: Array.from({ length: 7 }, (_, i) => ({ day: `2026-11-1${i + 1}`, totals: {} })),
    audit: [],
    errors: {
      total: 0,
      bySeverity: { critical: 0, error: 0, warning: 0 },
      byCategory: { auth: 0, webhook: 0 },
      newFingerprints: 0,
      regressions: 0,
    },
    signups: { count: 0, baselineDaily: [0, 0, 0, 0, 0, 0, 0] },
    missingTables: [],
    dataGaps: [],
    ...over,
  }
}

/** `failures` login_failed rows from one ip spread evenly over `subjects` accounts. */
function spread(ip: string, failures: number, subjects: number, type = 'login_failed'): SecurityEventCountRow[] {
  const rows: SecurityEventCountRow[] = []
  for (let i = 0; i < subjects; i++) {
    const count = Math.floor(failures / subjects) + (i < failures % subjects ? 1 : 0)
    rows.push(ev(type, count, { ip_bucket: ip, subject_hash: `h${String(i).padStart(15, '0')}`, subject_hint: `u***${i}@example.com` }))
  }
  return rows
}

const ids = (findings: Finding[]) => findings.map((f) => f.id)
const byId = (findings: Finding[], id: string) => findings.find((f) => f.id === id)

describe('security digest rules', () => {
  it('no data gives no findings and severity none', () => {
    const findings = evaluateRules(dayData())
    expect(findings).toEqual([])
    expect(overallSeverity(findings)).toBe('none')
    expect(buildHeadline(DAY, findings)).toBe('No findings for 2026-11-18.')
  })

  describe('credential_stuffing', () => {
    it('fires at 30 failures over 10 accounts from one network', () => {
      const f = byId(evaluateRules(dayData({ events: spread('1.2.3.4', STUFFING_MIN_FAILURES, STUFFING_MIN_DISTINCT_SUBJECTS) })), 'credential_stuffing')
      expect(f?.severity).toBe('high')
      expect(f?.evidence.counts).toMatchObject({ networks: 1, failures: 30, accounts: 10 })
      expect(f?.evidence.topIpBuckets[0].label).toContain('1.2.3.4')
    })
    it('does not fire below the failure or account threshold', () => {
      expect(ids(evaluateRules(dayData({ events: spread('1.2.3.4', STUFFING_MIN_FAILURES - 1, 10) })))).not.toContain('credential_stuffing')
      expect(ids(evaluateRules(dayData({ events: spread('1.2.3.4', 30, STUFFING_MIN_DISTINCT_SUBJECTS - 1) })))).not.toContain('credential_stuffing')
    })
    it('counts admin_login_failed toward the same network', () => {
      const events = [...spread('9.9.9.9', 15, 5), ...spread('9.9.9.9', 15, 5, 'admin_login_failed').map((r, i) => ({ ...r, subject_hash: `a${String(i).padStart(15, '0')}` }))]
      expect(ids(evaluateRules(dayData({ events })))).toContain('credential_stuffing')
    })
  })

  describe('brute_force_account', () => {
    const rows = (n: number, type = 'login_failed') => [
      ev(type, n - 1, { ip_bucket: '1.1.1.1', subject_hash: 'aaaaaaaaaaaaaaaa', subject_hint: 'v***m@example.com' }),
      ev(type, 1, { ip_bucket: '2.2.2.2', subject_hash: 'aaaaaaaaaaaaaaaa', subject_hint: 'v***m@example.com' }),
    ]
    it('is medium at 20 learner failures across networks', () => {
      const f = byId(evaluateRules(dayData({ events: rows(BRUTE_FORCE_MIN_FAILURES) })), 'brute_force_account')
      expect(f?.severity).toBe('medium')
      expect(f?.evidence.maskedSubjects).toEqual([{ label: 'v***m@example.com', count: 20 }])
      expect(f?.evidence.topIpBuckets.map((e) => e.label)).toEqual(['1.1.1.1', '2.2.2.2'])
    })
    it('is high when any failure was on the admin login', () => {
      const events = [...rows(BRUTE_FORCE_MIN_FAILURES - 1), ev('admin_login_failed', 1, { subject_hash: 'aaaaaaaaaaaaaaaa' })]
      expect(byId(evaluateRules(dayData({ events })), 'brute_force_account')?.severity).toBe('high')
    })
    it('does not fire at 19', () => {
      expect(ids(evaluateRules(dayData({ events: rows(BRUTE_FORCE_MIN_FAILURES - 1) })))).not.toContain('brute_force_account')
    })
    it('never shows an unmasked email even if a raw one was stored', () => {
      const events = [ev('login_failed', 25, { subject_hash: 'bbbbbbbbbbbbbbbb', subject_hint: 'victim@example.com' })]
      const f = byId(evaluateRules(dayData({ events })), 'brute_force_account')
      expect(f?.evidence.maskedSubjects[0].label).toBe('v***m@example.com')
    })
  })

  describe('admin_login_attack', () => {
    it('fires on any admin rate limiting', () => {
      expect(byId(evaluateRules(dayData({ events: [ev('admin_login_rate_limited', 1)] })), 'admin_login_attack')?.severity).toBe('high')
    })
    it('fires at 10 admin failures, not at 9', () => {
      expect(ids(evaluateRules(dayData({ events: [ev('admin_login_failed', ADMIN_ATTACK_MIN_FAILURES)] })))).toContain('admin_login_attack')
      expect(ids(evaluateRules(dayData({ events: [ev('admin_login_failed', ADMIN_ATTACK_MIN_FAILURES - 1)] })))).not.toContain('admin_login_attack')
    })
  })

  it('non_admin_probing: medium at 3, nothing at 2', () => {
    expect(byId(evaluateRules(dayData({ events: [ev('admin_login_non_admin', NON_ADMIN_PROBING_MIN)] })), 'non_admin_probing')?.severity).toBe('medium')
    expect(ids(evaluateRules(dayData({ events: [ev('admin_login_non_admin', NON_ADMIN_PROBING_MIN - 1)] })))).not.toContain('non_admin_probing')
  })

  it('secret_probing: medium at 5 summed over the four types, high at 50', () => {
    const four = (n: number) => [
      ev('webhook_auth_failed', n - 3),
      ev('email_hook_auth_failed', 1),
      ev('cron_auth_failed', 1),
      ev('internal_revalidate_auth_failed', 1),
    ]
    expect(byId(evaluateRules(dayData({ events: four(SECRET_PROBING_MEDIUM) })), 'secret_probing')?.severity).toBe('medium')
    expect(ids(evaluateRules(dayData({ events: four(SECRET_PROBING_MEDIUM - 1) })))).not.toContain('secret_probing')
    expect(byId(evaluateRules(dayData({ events: four(SECRET_PROBING_HIGH) })), 'secret_probing')?.severity).toBe('high')
    expect(byId(evaluateRules(dayData({ events: four(SECRET_PROBING_HIGH - 1) })), 'secret_probing')?.severity).toBe('medium')
  })

  it('csrf_attempts: low at 20, medium at 200', () => {
    expect(ids(evaluateRules(dayData({ events: [ev('origin_rejected', CSRF_LOW - 1)] })))).not.toContain('csrf_attempts')
    expect(byId(evaluateRules(dayData({ events: [ev('origin_rejected', CSRF_LOW)] })), 'csrf_attempts')?.severity).toBe('low')
    expect(byId(evaluateRules(dayData({ events: [ev('origin_rejected', CSRF_MEDIUM - 1)] })), 'csrf_attempts')?.severity).toBe('low')
    expect(byId(evaluateRules(dayData({ events: [ev('origin_rejected', CSRF_MEDIUM)] })), 'csrf_attempts')?.severity).toBe('medium')
  })

  describe('reset_spam', () => {
    it('fires when one account gets 5 resets, not 4', () => {
      const one = (n: number) => [ev('password_reset_requested', n, { subject_hash: 'cccccccccccccccc', subject_hint: 'r***t@example.com' })]
      expect(byId(evaluateRules(dayData({ events: one(RESET_PER_SUBJECT_MIN) })), 'reset_spam')?.severity).toBe('medium')
      expect(ids(evaluateRules(dayData({ events: one(RESET_PER_SUBJECT_MIN - 1) })))).not.toContain('reset_spam')
    })
    it('does not flag a reset spike while the event table has under 3 days of history', () => {
      const thin = Array.from({ length: 7 }, (_, i) => ({
        day: `2026-11-1${i + 1}`,
        totals: i < 5 ? {} : { password_reset_requested: 1 },
      }))
      // Only 2 baseline days have data: 40 resets against a near-zero average is not a spike yet.
      expect(ids(evaluateRules(dayData({ baseline: thin, events: [ev('password_reset_requested', 40)] })))).not.toContain('reset_spam')
    })
    it('fires on a total above 3x the 7-day average when at least 20', () => {
      const baseline = Array.from({ length: 7 }, (_, i) => ({ day: `2026-11-1${i + 1}`, totals: { password_reset_requested: 6 } }))
      // avg 6, 3x = 18: 20 is above it and meets the minimum.
      expect(ids(evaluateRules(dayData({ baseline, events: [ev('password_reset_requested', RESET_SPIKE_MIN_TOTAL)] })))).toContain('reset_spam')
      // 19 is above 3x but below the minimum.
      expect(ids(evaluateRules(dayData({ baseline, events: [ev('password_reset_requested', RESET_SPIKE_MIN_TOTAL - 1)] })))).not.toContain('reset_spam')
      // avg 7, 3x = 21: 21 is not above it.
      const higher = baseline.map((d) => ({ ...d, totals: { password_reset_requested: 7 } }))
      expect(ids(evaluateRules(dayData({ baseline: higher, events: [ev('password_reset_requested', 21)] })))).not.toContain('reset_spam')
    })
  })

  describe('bot_signups', () => {
    it('is medium at 20 blocked or failed bot checks, not at 19', () => {
      const events = (n: number) => [ev('signup_blocked', n - 5), ev('turnstile_failed', 5)]
      expect(byId(evaluateRules(dayData({ events: events(BOT_SIGNUP_BLOCKED_MIN) })), 'bot_signups')?.severity).toBe('medium')
      expect(ids(evaluateRules(dayData({ events: events(BOT_SIGNUP_BLOCKED_MIN - 1) })))).not.toContain('bot_signups')
    })
    it('is low on a signup wave above 3x the average and at least 20', () => {
      const signups = (count: number, avg: number) => ({ count, baselineDaily: new Array(7).fill(avg) as number[] })
      expect(byId(evaluateRules(dayData({ signups: signups(SIGNUP_SPIKE_MIN, 5) })), 'bot_signups')?.severity).toBe('low')
      expect(ids(evaluateRules(dayData({ signups: signups(SIGNUP_SPIKE_MIN - 1, 1) })))).not.toContain('bot_signups')
      expect(ids(evaluateRules(dayData({ signups: signups(30, 10) })))).not.toContain('bot_signups')
    })
  })

  it('client_error_flood: any flood is medium', () => {
    expect(byId(evaluateRules(dayData({ events: [ev('client_errors_flood', 1)] })), 'client_error_flood')?.severity).toBe('medium')
  })

  it('quiz_abuse: low at 20, nothing at 19 (the trip itself is still listed)', () => {
    expect(byId(evaluateRules(dayData({ events: [ev('quiz_check_rate_limited', QUIZ_ABUSE_MIN)] })), 'quiz_abuse')?.severity).toBe('low')
    const below = evaluateRules(dayData({ events: [ev('quiz_check_rate_limited', QUIZ_ABUSE_MIN - 1)] }))
    expect(ids(below)).not.toContain('quiz_abuse')
    expect(ids(below)).toContain('rate_limit_trips')
  })

  describe('privilege_changes', () => {
    const audit = (action: string, target_resource = 'user'): AuditEntry => ({
      action,
      target_resource,
      target_id: 'usr-1',
      admin_email: 'owner@example.com',
      created_at: '2026-11-18T05:00:00.000Z',
    })
    it('is high for any admin role grant and masks the admin email', () => {
      const f = byId(evaluateRules(dayData({ audit: [audit('grant_admin_role')] })), 'privilege_changes')
      expect(f?.severity).toBe('high')
      expect(f?.evidence.items?.[0]).toContain('o***r@example.com')
      expect(f?.evidence.items?.[0]).not.toContain('owner@example.com')
    })
    it('is low and lists other sensitive actions', () => {
      const f = byId(
        evaluateRules(
          dayData({
            audit: [
              audit('revoke_admin_role'),
              audit('admin_user_deleted'),
              audit('system_error_ignored', 'system_error'),
              audit('update_product_settings', 'settings'),
              audit('bulk_update', 'bulk'),
            ],
          })
        ),
        'privilege_changes'
      )
      expect(f?.severity).toBe('low')
      expect(f?.evidence.items).toHaveLength(5)
    })
    it('ignores routine actions', () => {
      expect(ids(evaluateRules(dayData({ audit: [audit('cron_run_now', 'cron'), audit('access_denied', 'system')] })))).not.toContain('privilege_changes')
    })
  })

  describe('error_spike', () => {
    const errors = (critical: number, newFingerprints: number, regressions: number) => ({
      total: critical,
      bySeverity: { critical, error: 0, warning: 0 },
      byCategory: { auth: 0, webhook: 0 },
      newFingerprints,
      regressions,
    })
    it('is medium for one critical error', () => {
      expect(byId(evaluateRules(dayData({ errors: errors(1, 0, 0) })), 'error_spike')?.severity).toBe('medium')
    })
    it('is low for 10 new fingerprints or one regression', () => {
      expect(byId(evaluateRules(dayData({ errors: errors(0, 10, 0) })), 'error_spike')?.severity).toBe('low')
      expect(byId(evaluateRules(dayData({ errors: errors(0, 0, 1) })), 'error_spike')?.severity).toBe('low')
      expect(ids(evaluateRules(dayData({ errors: errors(0, 9, 0) })))).not.toContain('error_spike')
    })
  })

  it('rate_limit_trips lists every *_rate_limited total as low', () => {
    const f = byId(evaluateRules(dayData({ events: [ev('login_rate_limited', 2), ev('password_reset_rate_limited', 1)] })), 'rate_limit_trips')
    expect(f?.severity).toBe('low')
    expect(f?.evidence.items).toEqual(['login_rate_limited: 2', 'password_reset_rate_limited: 1'])
  })

  describe('aggregation and headline', () => {
    const busy = dayData({
      events: [...spread('1.2.3.4', 30, 10), ev('origin_rejected', 25)],
      audit: [
        { action: 'grant_admin_role', target_resource: 'user', target_id: 'u', admin_email: 'a@b.co', created_at: '2026-11-18T01:00:00.000Z' },
      ],
      errors: {
        total: 1,
        bySeverity: { critical: 1, error: 0, warning: 0 },
        byCategory: { auth: 0, webhook: 0 },
        newFingerprints: 0,
        regressions: 0,
      },
    })

    it('orders findings by severity then rule order, and takes the max severity', () => {
      const findings = evaluateRules(busy)
      expect(ids(findings)).toEqual(['credential_stuffing', 'privilege_changes', 'error_spike', 'csrf_attempts'])
      expect(overallSeverity(findings)).toBe('high')
      expect(overallSeverity(findings.filter((f) => f.severity === 'low'))).toBe('low')
      expect(overallSeverity(findings.filter((f) => f.severity !== 'high'))).toBe('medium')
    })

    it('builds the same headline every time', () => {
      const findings = evaluateRules(busy)
      const expected =
        '2 high, 1 medium, 1 low findings: possible credential stuffing from 1 network, 1 admin role granted, 1 critical error, and 1 more'
      expect(buildHeadline(DAY, findings)).toBe(expected)
      expect(buildHeadline(DAY, evaluateRules(busy))).toBe(expected)
      // Row order does not change the result.
      expect(buildHeadline(DAY, evaluateRules({ ...busy, events: [...busy.events].reverse() }))).toBe(expected)
    })

    it('uses the singular for one finding', () => {
      expect(buildHeadline(DAY, evaluateRules(dayData({ events: [ev('client_errors_flood', 1)] })))).toBe(
        '1 medium finding: client error reports flooded'
      )
    })

    it('summary has totals with 7-day average and change, top networks and masked accounts', () => {
      const baseline = Array.from({ length: 7 }, (_, i) => ({ day: `2026-11-1${i + 1}`, totals: { origin_rejected: 10 } }))
      const data = { ...busy, baseline }
      const summary = buildSummary(data, evaluateRules(data))
      const origin = summary.totals.find((t) => t.type === 'origin_rejected')
      expect(origin).toEqual({ type: 'origin_rejected', count: 25, avg7: 10, changePct: 150 })
      expect(summary.totals.find((t) => t.type === 'login_failed')?.changePct).toBeNull()
      expect(summary.totals).toHaveLength(16)
      expect(summary.topIpBuckets).toEqual([{ label: '1.2.3.4', count: 30 }])
      expect(summary.topAccounts).toHaveLength(5)
      expect(summary.topAccounts.every((a) => a.label.includes('***'))).toBe(true)
    })

    it('plain text stays under the cap and lists findings as bullets', () => {
      const findings = evaluateRules(busy)
      const text = buildDigestText(buildSummary(busy, findings), findings)
      expect(text).toContain('- [HIGH] Possible credential stuffing')
      expect(text.length).toBeLessThanOrEqual(DIGEST_TEXT_MAX_CHARS)
      const many = Array.from({ length: 200 }, () => findings[0])
      const long = buildDigestText(buildSummary(busy, findings), many)
      expect(long.length).toBeLessThanOrEqual(DIGEST_TEXT_MAX_CHARS)
      expect(long).toContain('truncated')
    })
  })
})
