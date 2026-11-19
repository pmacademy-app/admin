import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

import { SupabaseFake } from './helpers/supabase-fake'
import { collectDayData } from '@/lib/admin/security-digest/collect'
import { asDigestDb } from '@/lib/admin/security-digest/db'
import { runSecurityDigest, InvalidDigestDayError } from '@/lib/admin/security-digest/job'
import { addDays, dayBounds, localDay, previousDay } from '@/lib/admin/security-digest/time'
import { SECURITY_EVENTS_MIGRATION } from '@/lib/admin/security-digest/types'

const DAY = '2026-11-18'
const missing = (code = '42P01') => Object.assign(new Error('relation does not exist'), { code })

function event(day: string, event_type: string, count: number, over: Record<string, unknown> = {}) {
  return { day, event_type, app: 'web', ip_bucket: '', subject_hash: '', subject_hint: null, sample_path: null, count, first_seen: null, last_seen: null, ...over }
}

describe('IST day boundaries', () => {
  it('a day in Asia/Kolkata starts at 18:30 UTC the evening before', () => {
    expect(dayBounds(DAY, 'Asia/Kolkata')).toEqual({
      startIso: '2026-11-17T18:30:00.000Z',
      endIso: '2026-11-18T18:30:00.000Z',
    })
  })

  it('previous day is computed in IST, not UTC', () => {
    // 19:30 UTC on Nov 19 is 01:00 IST on Nov 20, so "yesterday" is Nov 19.
    expect(previousDay(new Date('2026-11-19T19:30:00.000Z'), 'Asia/Kolkata')).toBe('2026-11-19')
    // 17:00 UTC on Nov 19 is 22:30 IST on Nov 19, so "yesterday" is Nov 18.
    expect(previousDay(new Date('2026-11-19T17:00:00.000Z'), 'Asia/Kolkata')).toBe('2026-11-18')
    expect(localDay(new Date('2026-11-18T18:30:00.000Z'), 'Asia/Kolkata')).toBe('2026-11-19')
  })

  it('handles a DST zone and month edges', () => {
    expect(dayBounds('2026-03-08', 'America/New_York').startIso).toBe('2026-03-08T05:00:00.000Z')
    expect(dayBounds('2026-03-08', 'America/New_York').endIso).toBe('2026-03-09T04:00:00.000Z')
    expect(addDays('2026-03-01', -1)).toBe('2026-02-28')
  })
})

describe('collectDayData', () => {
  let fake: SupabaseFake
  beforeEach(() => {
    fake = new SupabaseFake()
  })

  it('bounds audit, errors and signups by IST midnight', async () => {
    fake.seed('admin_audit_logs', [
      { action: 'too_early', target_resource: 'x', target_id: null, admin_email: 'a@b.co', created_at: '2026-11-17T18:29:59.999Z' },
      { action: 'first', target_resource: 'x', target_id: null, admin_email: 'a@b.co', created_at: '2026-11-17T18:30:00.000Z' },
      { action: 'last', target_resource: 'x', target_id: null, admin_email: 'a@b.co', created_at: '2026-11-18T18:29:59.999Z' },
      { action: 'too_late', target_resource: 'x', target_id: null, admin_email: 'a@b.co', created_at: '2026-11-18T18:30:00.000Z' },
    ])
    fake.seed('users', [
      { id: 'u1', created_at: '2026-11-17T18:30:00.000Z' },
      { id: 'u2', created_at: '2026-11-18T10:00:00.000Z' },
      { id: 'u3', created_at: '2026-11-18T18:30:00.000Z' },
      { id: 'u4', created_at: '2026-11-12T00:00:00.000Z' },
    ])
    fake.seed('system_errors', [
      { severity: 'critical', category: 'auth', fingerprint: 'fp-new', first_seen_at: '2026-11-18T01:00:00.000Z', timestamp: '2026-11-18T01:00:00.000Z', details: null },
      { severity: 'error', category: 'webhook', fingerprint: 'fp-old', first_seen_at: '2026-11-18T02:00:00.000Z', timestamp: '2026-11-18T02:00:00.000Z', details: { regression: true } },
      { severity: 'warning', category: 'db', fingerprint: 'fp-old', first_seen_at: '2026-11-10T02:00:00.000Z', timestamp: '2026-11-10T02:00:00.000Z', details: null },
      { severity: 'critical', category: 'auth', fingerprint: 'fp-utc', first_seen_at: '2026-11-17T18:00:00.000Z', timestamp: '2026-11-17T18:00:00.000Z', details: null },
    ])
    fake.seed('security_event_counts', [
      event(DAY, 'login_failed', 4),
      event('2026-11-17', 'login_failed', 7),
      event('2026-11-11', 'login_failed', 14),
      event('2026-11-10', 'login_failed', 99),
    ])

    const data = await collectDayData(asDigestDb(fake), DAY, { timezone: 'Asia/Kolkata' })

    expect(data.audit.map((a) => a.action)).toEqual(['first', 'last'])
    expect(data.signups.count).toBe(1 + 1)
    expect(data.signups.baselineDaily).toHaveLength(7)
    expect(data.signups.baselineDaily.reduce((a, b) => a + b, 0)).toBe(1)
    expect(data.errors).toEqual({
      total: 2,
      bySeverity: { critical: 1, error: 1, warning: 0 },
      byCategory: { auth: 1, webhook: 1 },
      newFingerprints: 1,
      regressions: 1,
    })
    expect(data.events.map((e) => e.count)).toEqual([4])
    expect(data.baseline.map((b) => b.day)).toEqual([
      '2026-11-11', '2026-11-12', '2026-11-13', '2026-11-14', '2026-11-15', '2026-11-16', '2026-11-17',
    ])
    expect(data.baseline[0].totals.login_failed).toBe(14)
    expect(data.baseline[6].totals.login_failed).toBe(7)
    expect(data.missingTables).toEqual([])
    expect(data.dataGaps).toEqual([])
  })

  it('reports a missing table instead of throwing', async () => {
    fake.forceError('security_event_counts', missing('PGRST205'))
    fake.forceError('system_errors', Object.assign(new Error('boom'), { code: '57014' }))
    const data = await collectDayData(asDigestDb(fake), DAY, { timezone: 'Asia/Kolkata' })
    expect(data.missingTables).toEqual(['security_event_counts'])
    expect(data.dataGaps).toEqual(['system_errors'])
    expect(data.events).toEqual([])
    expect(data.baseline).toHaveLength(7)
  })
})

describe('runSecurityDigest', () => {
  let fake: SupabaseFake
  const deliver = vi.fn()
  const notifyAdmins = vi.fn()
  const now = () => new Date('2026-11-19T19:30:00.000Z') // 01:00 IST on Nov 20

  const deps = (over: Record<string, unknown> = {}) => ({ db: asDigestDb(fake), now, deliver, notifyAdmins, sendEmpty: false, ...over })

  beforeEach(() => {
    fake = new SupabaseFake()
    deliver.mockReset().mockResolvedValue('sent')
    notifyAdmins.mockReset().mockResolvedValue(2)
    delete process.env.ADMIN_TIMEZONE
  })
  afterEach(() => {
    delete process.env.ADMIN_TIMEZONE
  })

  it('summarizes the previous IST day by default and stores it', async () => {
    fake.seed('security_event_counts', [event('2026-11-19', 'origin_rejected', 25)])
    const result = await runSecurityDigest(deps(), { trigger: 'cron' })
    expect(result).toMatchObject({ status: 'ok', day: '2026-11-19', severity: 'low', findings: 1, webhook: 'sent', notified: 'skipped_not_high' })
    const rows = fake.getTableRows('security_digests')
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ day: '2026-11-19', severity: 'low' })
    expect((rows[0].summary as { delivery: { webhookSentAt: string } }).delivery.webhookSentAt).toBe('2026-11-19T19:30:00.000Z')
    expect(deliver).toHaveBeenCalledTimes(1)
    expect(deliver.mock.calls[0][0].text).toContain('Cross-origin writes refused')
  })

  it('is idempotent: a re-run overwrites the row and does not resend the webhook or notifications', async () => {
    fake.seed('security_event_counts', [event(DAY, 'admin_login_rate_limited', 1)])
    const first = await runSecurityDigest(deps(), { day: DAY, trigger: 'cron' })
    expect(first).toMatchObject({ severity: 'high', webhook: 'sent', notified: 'sent' })

    fake.seed('security_event_counts', [event(DAY, 'admin_login_rate_limited', 1), event(DAY, 'origin_rejected', 30)])
    const second = await runSecurityDigest(deps(), { day: DAY, trigger: 'admin' })
    expect(second).toMatchObject({ severity: 'high', findings: 3, webhook: 'skipped_already_sent', notified: 'skipped_already_sent' })
    expect(deliver).toHaveBeenCalledTimes(1)
    expect(notifyAdmins).toHaveBeenCalledTimes(1)

    const rows = fake.getTableRows('security_digests')
    expect(rows).toHaveLength(1)
    expect((rows[0].findings as unknown[]).length).toBe(3)
    expect((rows[0].summary as { delivery: { webhookSentAt: string | null } }).delivery.webhookSentAt).not.toBeNull()
  })

  it('resends when forced', async () => {
    fake.seed('security_event_counts', [event(DAY, 'admin_login_rate_limited', 1)])
    await runSecurityDigest(deps(), { day: DAY, trigger: 'cron' })
    const forced = await runSecurityDigest(deps(), { day: DAY, trigger: 'admin', force: true })
    expect(forced).toMatchObject({ webhook: 'sent', notified: 'sent' })
    expect(deliver).toHaveBeenCalledTimes(2)
  })

  it('retries delivery on the next run when the webhook failed', async () => {
    fake.seed('security_event_counts', [event(DAY, 'origin_rejected', 25)])
    deliver.mockResolvedValueOnce('failed')
    expect(await runSecurityDigest(deps(), { day: DAY, trigger: 'cron' })).toMatchObject({ webhook: 'failed' })
    expect(await runSecurityDigest(deps(), { day: DAY, trigger: 'cron' })).toMatchObject({ webhook: 'sent' })
  })

  it('sends nothing for an empty day unless SECURITY_DIGEST_SEND_EMPTY is on, then once', async () => {
    expect(await runSecurityDigest(deps(), { day: DAY, trigger: 'cron' })).toMatchObject({ severity: 'none', webhook: 'skipped_no_findings' })
    expect(deliver).not.toHaveBeenCalled()

    expect(await runSecurityDigest(deps({ sendEmpty: true }), { day: DAY, trigger: 'cron' })).toMatchObject({ webhook: 'sent' })
    expect(deliver.mock.calls[0][0].text).toBe(`Prodily security summary for ${DAY}: no findings.`)
    expect(await runSecurityDigest(deps({ sendEmpty: true }), { day: DAY, trigger: 'cron' })).toMatchObject({ webhook: 'skipped_already_sent' })
    expect(deliver).toHaveBeenCalledTimes(1)
  })

  it('returns not_set_up and writes nothing when the tables are missing', async () => {
    fake.forceError('security_digests', missing())
    expect(await runSecurityDigest(deps(), { day: DAY, trigger: 'cron' })).toEqual({
      status: 'not_set_up',
      day: DAY,
      missingTables: ['security_digests'],
      migration: SECURITY_EVENTS_MIGRATION,
    })

    fake.clearError('security_digests')
    fake.forceError('security_event_counts', missing('PGRST205'))
    const result = await runSecurityDigest(deps(), { day: DAY, trigger: 'cron' })
    expect(result.status).toBe('not_set_up')
    expect(fake.getTableRows('security_digests')).toHaveLength(0)
    expect(deliver).not.toHaveBeenCalled()
  })

  it('rejects a malformed or future day', async () => {
    await expect(runSecurityDigest(deps(), { day: '2026-13-01', trigger: 'admin' })).rejects.toBeInstanceOf(InvalidDigestDayError)
    await expect(runSecurityDigest(deps(), { day: '2026-11-21', trigger: 'admin' })).rejects.toBeInstanceOf(InvalidDigestDayError)
  })

  it('honours ADMIN_TIMEZONE for the default day', async () => {
    process.env.ADMIN_TIMEZONE = 'UTC'
    expect(await runSecurityDigest(deps(), { trigger: 'cron' })).toMatchObject({ day: '2026-11-18' })
  })
})
