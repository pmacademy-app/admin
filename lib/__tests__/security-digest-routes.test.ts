import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

import { SupabaseFake } from './helpers/supabase-fake'

/**
 * Security summary routes: the Vercel cron (bearer CRON_SECRET only) and the admin
 * "Generate now" route.
 */

let fake: SupabaseFake
const deliverOutOfBandAlert = vi.fn()
const recordSecurityEvent = vi.fn()
const requireAdminUser = vi.fn()
const logAdminAction = vi.fn()

vi.mock('@/lib/supabase', () => ({ createServiceRoleClient: () => fake }))
vi.mock('@/lib/monitoring/out-of-band-alert', () => ({
  deliverOutOfBandAlert: (...args: unknown[]) => deliverOutOfBandAlert(...args),
}))
vi.mock('@/lib/security/security-events', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/security/security-events')>()),
  recordSecurityEvent: (...args: unknown[]) => recordSecurityEvent(...args),
}))
vi.mock('@/lib/admin/guard', () => ({
  requireAdminUser: (...args: unknown[]) => requireAdminUser(...args),
  logAdminAction: (...args: unknown[]) => logAdminAction(...args),
}))
vi.mock('@/lib/notifications/in-app/service', () => ({
  createInAppNotification: vi.fn(async () => ({ success: true })),
}))

const CRON_PATH = 'http://localhost:3000/api/admin/cron/security-digest'
const yesterdayRow = (event_type: string, count: number) => ({
  day: '',
  event_type,
  app: 'web',
  ip_bucket: '5.6.7.8',
  subject_hash: '',
  subject_hint: null,
  sample_path: null,
  count,
  first_seen: null,
  last_seen: null,
})

async function callCron(headers: Record<string, string> = {}, method: 'GET' | 'POST' = 'GET') {
  const { NextRequest } = await import('next/server')
  const route = await import('../../app/api/admin/cron/security-digest/route')
  const req = new NextRequest(CRON_PATH, { method, headers })
  return route[method](req, { params: Promise.resolve({}) })
}

async function callGenerate(body: unknown) {
  const { NextRequest } = await import('next/server')
  const { POST } = await import('../../app/api/admin/security/digest/route')
  const req = new NextRequest('http://localhost:3000/api/admin/security/digest', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  return POST(req, { params: Promise.resolve({}) })
}

describe('security digest cron route', () => {
  const originalSecret = process.env.CRON_SECRET

  beforeEach(async () => {
    fake = new SupabaseFake()
    deliverOutOfBandAlert.mockReset().mockResolvedValue({ delivered: true })
    recordSecurityEvent.mockReset()
    process.env.CRON_SECRET = 'test-cron-secret'
    const { previousDay } = await import('@/lib/admin/security-digest/time')
    const day = previousDay(new Date(), 'Asia/Kolkata')
    fake.seed('security_event_counts', [{ ...yesterdayRow('origin_rejected', 40), day }])
  })
  afterEach(() => {
    process.env.CRON_SECRET = originalSecret
  })

  it('refuses a request with no bearer and records cron_auth_failed', async () => {
    const res = await callCron()
    expect(res.status).toBe(401)
    expect(recordSecurityEvent).toHaveBeenCalledWith('cron_auth_failed', expect.objectContaining({ app: 'admin' }))
    expect(fake.getTableRows('security_digests')).toHaveLength(0)
  })

  it('refuses a wrong secret with 401', async () => {
    const res = await callCron({ Authorization: 'Bearer not-the-secret' })
    expect(res.status).toBe(401)
    expect(deliverOutOfBandAlert).not.toHaveBeenCalled()
  })

  it('refuses everything when CRON_SECRET is unset', async () => {
    delete process.env.CRON_SECRET
    expect((await callCron({ Authorization: 'Bearer ' })).status).toBe(401)
    expect((await callCron({ Authorization: 'Bearer undefined' })).status).toBe(401)
  })

  it('does not accept an admin session in place of the bearer', async () => {
    requireAdminUser.mockResolvedValue({ authorized: true, userId: 'adm', email: 'adm@example.com' })
    const res = await callCron({ cookie: 'sb-access-token=admin-token' })
    expect(res.status).toBe(401)
    expect(requireAdminUser).not.toHaveBeenCalled()
  })

  it('runs with the right bearer (GET from Vercel) and does not resend on a second run', async () => {
    const res = await callCron({ Authorization: 'Bearer test-cron-secret' })
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.result).toMatchObject({ status: 'ok', severity: 'low', webhook: 'sent' })
    expect(deliverOutOfBandAlert).toHaveBeenCalledTimes(1)
    expect(deliverOutOfBandAlert.mock.calls[0][0]).toMatchObject({ kind: 'security_digest', severity: 'low' })

    const again = await callCron({ Authorization: 'Bearer test-cron-secret' }, 'POST')
    expect((await again.json()).result).toMatchObject({ webhook: 'skipped_already_sent' })
    expect(deliverOutOfBandAlert).toHaveBeenCalledTimes(1)
    expect(fake.getTableRows('security_digests')).toHaveLength(1)
  })

  it('answers 200 not_set_up while the migration is unapplied', async () => {
    fake.forceError('security_digests', Object.assign(new Error('missing'), { code: 'PGRST205' }))
    const res = await callCron({ Authorization: 'Bearer test-cron-secret' })
    expect(res.status).toBe(200)
    expect((await res.json()).result).toMatchObject({ status: 'not_set_up', migration: '20261119000007_security_events.sql' })
    expect(deliverOutOfBandAlert).not.toHaveBeenCalled()
  })
})

describe('security digest generate route', () => {
  beforeEach(() => {
    fake = new SupabaseFake()
    deliverOutOfBandAlert.mockReset().mockResolvedValue({ delivered: false, reason: 'not_configured' })
    requireAdminUser.mockReset()
    logAdminAction.mockReset()
  })

  it('requires an admin', async () => {
    requireAdminUser.mockResolvedValue({ authorized: false, statusCode: 401, error: 'no session' })
    const res = await callGenerate({ day: '2026-11-18' })
    expect(res.status).toBe(401)
    expect(fake.getTableRows('security_digests')).toHaveLength(0)
  })

  it('builds the requested day and audits the action', async () => {
    requireAdminUser.mockResolvedValue({ authorized: true, userId: 'adm-1', email: 'adm@example.com' })
    fake.seed('security_event_counts', [{ ...yesterdayRow('client_errors_flood', 1), day: '2026-11-18' }])
    const res = await callGenerate({ day: '2026-11-18' })
    expect(res.status).toBe(200)
    expect((await res.json()).result).toMatchObject({ status: 'ok', day: '2026-11-18', severity: 'medium', webhook: 'not_configured' })
    expect(logAdminAction).toHaveBeenCalledWith(
      'adm-1',
      'adm@example.com',
      'security_digest_generated',
      'security_digest',
      '2026-11-18',
      expect.objectContaining({ status: 'ok', severity: 'medium' })
    )
  })

  it('rejects an invalid day with 400', async () => {
    requireAdminUser.mockResolvedValue({ authorized: true, userId: 'adm-1', email: 'adm@example.com' })
    expect((await callGenerate({ day: 'yesterday' })).status).toBe(400)
    expect((await callGenerate({ day: '2026-02-30' })).status).toBe(400)
    expect((await callGenerate({ day: '2999-01-01' })).status).toBe(400)
  })
})
