import { describe, it, expect, vi, beforeEach } from 'vitest'

/**
 * Admin split: proxy.ts guards /admin/* on the admin host. Guests go to /admin/login,
 * signed-in non-admins to /admin/access-denied, `/` goes to /admin, and cookie-bearing
 * cross-origin writes to the API are refused.
 */

const getClaims = vi.fn()
const refreshSession = vi.fn()
const maybeSingle = vi.fn()

vi.mock('@supabase/supabase-js', () => ({
  createClient: () => ({
    auth: { getClaims, refreshSession },
    from: () => ({ select: () => ({ eq: () => ({ maybeSingle }) }) }),
  }),
}))

async function run(path: string, init: { cookie?: string; method?: string; headers?: Record<string, string> } = {}) {
  const { NextRequest } = await import('next/server')
  const { proxy } = await import('../../proxy')
  const headers: Record<string, string> = { ...(init.headers || {}) }
  if (init.cookie) headers.cookie = init.cookie
  const req = new NextRequest(`https://admin.example.com${path}`, { method: init.method || 'GET', headers })
  return proxy(req)
}

const location = (res: Response) => res.headers.get('Location')

describe('admin proxy', () => {
  beforeEach(() => {
    getClaims.mockReset()
    refreshSession.mockReset()
    maybeSingle.mockReset()
  })

  it('redirects / to /admin', async () => {
    const res = await run('/')
    expect(res.status).toBe(307)
    expect(location(res)).toBe('https://admin.example.com/admin')
  })

  it('redirects a guest on /admin/* to /admin/login', async () => {
    const res = await run('/admin/users')
    expect(location(res)).toBe('https://admin.example.com/admin/login')
  })

  it('lets a guest see /admin/login and /admin/access-denied', async () => {
    expect((await run('/admin/login')).status).toBe(200)
    expect((await run('/admin/access-denied')).status).toBe(200)
  })

  it('redirects a signed-in non-admin to /admin/access-denied', async () => {
    getClaims.mockResolvedValue({ data: { claims: { sub: 'usr-1', app_metadata: {} } }, error: null })
    maybeSingle.mockResolvedValue({ data: { is_admin: false }, error: null })
    const res = await run('/admin/users', { cookie: 'sb-access-token=tok' })
    expect(location(res)).toBe('https://admin.example.com/admin/access-denied')
  })

  it('sends a signed-in non-admin on the login page to access denied', async () => {
    getClaims.mockResolvedValue({ data: { claims: { sub: 'usr-1', app_metadata: {} } }, error: null })
    maybeSingle.mockResolvedValue({ data: null, error: null })
    const res = await run('/admin/login', { cookie: 'sb-access-token=tok' })
    expect(location(res)).toBe('https://admin.example.com/admin/access-denied')
  })

  it('fails closed when the admin lookup errors', async () => {
    getClaims.mockResolvedValue({ data: { claims: { sub: 'usr-1', app_metadata: {} } }, error: null })
    maybeSingle.mockResolvedValue({ data: null, error: { code: '500', message: 'boom' } })
    const res = await run('/admin', { cookie: 'sb-access-token=tok' })
    expect(location(res)).toBe('https://admin.example.com/admin/access-denied')
  })

  it('lets an admin through (users.is_admin)', async () => {
    getClaims.mockResolvedValue({ data: { claims: { sub: 'usr-2', app_metadata: {} } }, error: null })
    maybeSingle.mockResolvedValue({ data: { is_admin: true }, error: null })
    const res = await run('/admin/users', { cookie: 'sb-access-token=tok' })
    expect(res.status).toBe(200)
    expect(location(res)).toBeNull()
  })

  it('lets an admin through on the signed claim without a DB read', async () => {
    getClaims.mockResolvedValue({ data: { claims: { sub: 'usr-2', app_metadata: { is_admin: true } } }, error: null })
    const res = await run('/admin', { cookie: 'sb-access-token=tok' })
    expect(res.status).toBe(200)
    expect(maybeSingle).not.toHaveBeenCalled()
  })

  it('sends an admin away from the login page to the console', async () => {
    getClaims.mockResolvedValue({ data: { claims: { sub: 'usr-2', app_metadata: { is_admin: true } } }, error: null })
    const res = await run('/admin/login', { cookie: 'sb-access-token=tok' })
    expect(location(res)).toBe('https://admin.example.com/admin')
  })

  it('refreshes an expired session and persists the rotated cookies', async () => {
    getClaims.mockResolvedValue({ data: null, error: new Error('expired') })
    refreshSession.mockResolvedValue({
      data: {
        session: { access_token: 'new-access', refresh_token: 'new-refresh', expires_in: 3600 },
        user: { id: 'usr-2', app_metadata: { is_admin: true } },
      },
      error: null,
    })
    const res = await run('/admin', { cookie: 'sb-access-token=old; sb-refresh-token=old-refresh' })
    expect(res.status).toBe(200)
    const cookies = (res as unknown as { cookies: { get: (n: string) => { value: string } | undefined } }).cookies
    expect(cookies.get('sb-access-token')?.value).toBe('new-access')
  })

  it('passes admin API calls through without redirecting (routes answer their own 401)', async () => {
    const res = await run('/api/admin/summary')
    expect(res.status).toBe(200)
    expect(location(res)).toBeNull()
  })

  it('refuses a cookie-bearing cross-origin write to the API', async () => {
    const res = await run('/api/admin/users/usr-1', {
      method: 'POST',
      cookie: 'sb-access-token=tok',
      headers: { origin: 'https://evil.example', 'sec-fetch-site': 'cross-site' },
    })
    expect(res.status).toBe(403)
  })

  it('refuses a same-site write from the learner origin', async () => {
    process.env.NEXT_PUBLIC_SITE_URL = 'https://admin.example.com'
    const res = await run('/api/admin/users/usr-1', {
      method: 'POST',
      cookie: 'sb-access-token=tok',
      headers: { origin: 'https://example.com', 'sec-fetch-site': 'same-site', host: 'admin.example.com' },
    })
    expect(res.status).toBe(403)
    delete process.env.NEXT_PUBLIC_SITE_URL
  })

  it('accepts a same-origin write', async () => {
    const res = await run('/api/admin/users/usr-1', {
      method: 'POST',
      cookie: 'sb-access-token=tok',
      headers: { origin: 'https://admin.example.com', 'sec-fetch-site': 'same-origin' },
    })
    expect(res.status).toBe(200)
  })
})
