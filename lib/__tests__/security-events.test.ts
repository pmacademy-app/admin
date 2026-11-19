import { describe, it, expect, vi, beforeEach } from 'vitest'

/**
 * The admin security event recorder and the admin login instrumentation.
 */

const rpc = vi.fn()
const signInWithPassword = vi.fn()
const signOut = vi.fn()
const isAdminUser = vi.fn()
const evaluatePersistentRateLimit = vi.fn()

vi.mock('@/lib/supabase', () => ({
  createServiceRoleClient: () => ({ rpc, auth: { signInWithPassword, signOut } }),
}))
vi.mock('@/lib/admin/authorization', () => ({ isAdminUser: (...args: unknown[]) => isAdminUser(...args) }))
vi.mock('@/lib/rate-limit', () => ({
  evaluatePersistentRateLimit: (...args: unknown[]) => evaluatePersistentRateLimit(...args),
}))

const flush = () => new Promise((resolve) => setTimeout(resolve, 0))

describe('recordSecurityEvent', () => {
  beforeEach(async () => {
    rpc.mockReset().mockResolvedValue({ error: null })
    const mod = await import('@/lib/security/security-events')
    mod.resetSecurityEventsStateForTests()
  })

  it('hashes the lowercased trimmed subject to 16 hex chars and masks the hint', async () => {
    const { hashSecuritySubject, securitySubjectHint } = await import('@/lib/security/security-events')
    const hash = hashSecuritySubject('  Victim@Example.com ')
    expect(hash).toMatch(/^[0-9a-f]{16}$/)
    expect(hash).toBe(hashSecuritySubject('victim@example.com'))
    expect(hashSecuritySubject('')).toBe('')
    expect(securitySubjectHint('Victim@Example.com')).toBe('v***m@example.com')
    expect(securitySubjectHint('not-an-email')).toBeNull()
  })

  it('calls the RPC with hashed values only, and drops query strings from the path', async () => {
    const { recordSecurityEvent } = await import('@/lib/security/security-events')
    recordSecurityEvent('admin_login_failed', { app: 'admin', ipBucket: '1.2.3.4', subject: 'victim@example.com', path: '/api/auth/login?x=1' })
    await flush()
    expect(rpc).toHaveBeenCalledTimes(1)
    const [fn, args] = rpc.mock.calls[0]
    expect(fn).toBe('record_security_event')
    expect(args).toMatchObject({ p_event_type: 'admin_login_failed', p_app: 'admin', p_ip_bucket: '1.2.3.0/24', p_path: '/api/auth/login', p_subject_hint: 'v***m@example.com' })
    expect(args.p_subject_hash).toMatch(/^[0-9a-f]{16}$/)
    expect(JSON.stringify(args)).not.toContain('victim@example.com')
  })

  it('coarsens IPv4 to /24 and IPv6 to /48, passing unresolved through', async () => {
    const { coarsenIpBucket } = await import('@/lib/security/security-events')
    expect(coarsenIpBucket('203.0.113.77')).toBe('203.0.113.0/24')
    expect(coarsenIpBucket('2001:db8:abcd:12::1')).toBe('2001:db8:abcd::/48')
    expect(coarsenIpBucket('2001:0DB8::1')).toBe('2001:db8:0::/48')
    expect(coarsenIpBucket('::1')).toBe('0:0:0::/48')
    expect(coarsenIpBucket('unresolved')).toBe('unresolved')
    expect(coarsenIpBucket('')).toBe('')
    expect(coarsenIpBucket(null)).toBe('')
    expect(coarsenIpBucket('203.0.113.0/24')).toBe('203.0.113.0/24')
    expect(coarsenIpBucket('999.1.1.1')).toBe('unresolved')
    expect(coarsenIpBucket('not-an-ip')).toBe('unresolved')
  })

  it('stores only the pathname of a path or full URL', async () => {
    const { samplePath, recordSecurityEvent } = await import('@/lib/security/security-events')
    expect(samplePath('/api/auth/login?email=a@b.co#x')).toBe('/api/auth/login')
    expect(samplePath('https://admin.example.com/api/auth/login?token=secret#frag')).toBe('/api/auth/login')
    expect(samplePath('')).toBeNull()
    recordSecurityEvent('origin_rejected', { app: 'admin', ipBucket: '2001:db8:abcd:12::1', path: 'https://admin.example.com/x?y=1' })
    await flush()
    expect(rpc.mock.calls[0][1]).toMatchObject({ p_ip_bucket: '2001:db8:abcd::/48', p_path: '/x' })
  })

  it('never throws, even when the RPC rejects', async () => {
    rpc.mockRejectedValue(new Error('network down'))
    const { recordSecurityEvent } = await import('@/lib/security/security-events')
    expect(() => recordSecurityEvent('login_failed', { app: 'admin' })).not.toThrow()
    await flush()
  })

  it('backs off for 10 minutes when the RPC is missing', async () => {
    rpc.mockResolvedValue({ error: { code: 'PGRST202', message: 'Could not find the function' } })
    const mod = await import('@/lib/security/security-events')
    mod.recordSecurityEvent('login_failed', { app: 'admin' })
    await flush()
    expect(mod.isSecurityEventsDisabled()).toBe(true)
    mod.recordSecurityEvent('login_failed', { app: 'admin' })
    await flush()
    expect(rpc).toHaveBeenCalledTimes(1)

    vi.useFakeTimers()
    vi.setSystemTime(Date.now() + mod.SECURITY_EVENTS_DISABLE_MS + 1000)
    expect(mod.isSecurityEventsDisabled()).toBe(false)
    vi.useRealTimers()
  })

  it('treats 42883 (undefined function) the same way', async () => {
    rpc.mockResolvedValue({ error: { code: '42883' } })
    const mod = await import('@/lib/security/security-events')
    mod.recordSecurityEvent('login_failed', { app: 'admin' })
    await flush()
    expect(mod.isSecurityEventsDisabled()).toBe(true)
  })
})

describe('admin login instrumentation', () => {
  const session = { access_token: 'access-abc', refresh_token: 'refresh-abc', expires_in: 3600 }
  const user = { id: 'usr-1', email: 'person@example.com' }

  async function login(body: unknown) {
    const { NextRequest } = await import('next/server')
    const { POST } = await import('../../app/api/auth/login/route')
    const req = new NextRequest('http://localhost:3000/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-real-ip': '203.0.113.9' },
      body: JSON.stringify(body),
    })
    const res = await POST(req, { params: Promise.resolve({}) })
    await flush()
    return res
  }

  const recorded = () => rpc.mock.calls.map(([, args]) => (args as { p_event_type: string }).p_event_type)

  beforeEach(async () => {
    rpc.mockReset().mockResolvedValue({ error: null })
    signInWithPassword.mockReset()
    signOut.mockReset().mockResolvedValue({ error: null })
    isAdminUser.mockReset()
    evaluatePersistentRateLimit.mockReset().mockResolvedValue({ success: true, resetInMs: 0 })
    const mod = await import('@/lib/security/security-events')
    mod.resetSecurityEventsStateForTests()
  })

  it('records admin_login_failed for a wrong password, with the trusted IP', async () => {
    signInWithPassword.mockResolvedValue({ data: {}, error: { code: 'invalid_credentials', message: 'Invalid login credentials' } })
    const res = await login({ email: 'person@example.com', password: 'wrong' })
    expect(res.status).toBe(401)
    expect(recorded()).toEqual(['admin_login_failed'])
    expect(rpc.mock.calls[0][1]).toMatchObject({ p_app: 'admin', p_ip_bucket: '203.0.113.0/24' })
  })

  it('records admin_login_rate_limited when throttled', async () => {
    evaluatePersistentRateLimit.mockResolvedValue({ success: false, resetInMs: 1000 })
    const res = await login({ email: 'person@example.com', password: 'x' })
    expect(res.status).toBe(429)
    expect(recorded()).toEqual(['admin_login_rate_limited'])
    expect(signInWithPassword).not.toHaveBeenCalled()
  })

  it('records admin_login_non_admin for a valid password on a non-admin account', async () => {
    signInWithPassword.mockResolvedValue({ data: { session, user }, error: null })
    isAdminUser.mockResolvedValue(false)
    const res = await login({ email: 'person@example.com', password: 'correct' })
    expect(res.status).toBe(403)
    expect(recorded()).toEqual(['admin_login_non_admin'])
  })

  it('records nothing for a successful admin login', async () => {
    signInWithPassword.mockResolvedValue({ data: { session, user }, error: null })
    isAdminUser.mockResolvedValue(true)
    const res = await login({ email: 'admin@example.com', password: 'correct' })
    expect(res.status).toBe(200)
    expect(recorded()).toEqual([])
  })
})
