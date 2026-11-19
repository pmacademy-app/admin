import { describe, it, expect, vi, beforeEach } from 'vitest'

/**
 * Admin split: the admin host's /api/auth/login signs in administrators only. A valid password
 * on a non-admin account is refused after the password check, the provider session is ended and
 * no session cookie is written.
 */

const signInWithPassword = vi.fn()
const signOut = vi.fn()
const isAdminUser = vi.fn()

vi.mock('@/lib/supabase', () => ({
  createServiceRoleClient: () => ({ auth: { signInWithPassword, signOut } }),
}))
vi.mock('@/lib/admin/authorization', () => ({ isAdminUser: (...args: unknown[]) => isAdminUser(...args) }))
vi.mock('@/lib/rate-limit', () => ({
  evaluatePersistentRateLimit: vi.fn(async () => ({ success: true, resetInMs: 0 })),
}))

const session = { access_token: 'access-abc', refresh_token: 'refresh-abc', expires_in: 3600 }
const user = { id: 'usr-1', email: 'person@example.com' }

function loginRequest(body: unknown) {
  return new Request('http://localhost:3000/api/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', origin: 'http://localhost:3000' },
    body: JSON.stringify(body),
  })
}

async function callLogin(body: unknown) {
  const { NextRequest } = await import('next/server')
  const { POST } = await import('../../app/api/auth/login/route')
  const req = loginRequest(body)
  return POST(new NextRequest(req.url, { method: 'POST', headers: req.headers, body: JSON.stringify(body) }), {
    params: Promise.resolve({}),
  })
}

describe('admin login route', () => {
  beforeEach(() => {
    signInWithPassword.mockReset()
    signOut.mockReset()
    isAdminUser.mockReset()
    signOut.mockResolvedValue({ error: null })
  })

  it('refuses a non-admin after the password check, signs them out and sets no cookie', async () => {
    signInWithPassword.mockResolvedValue({ data: { session, user }, error: null })
    isAdminUser.mockResolvedValue(false)

    const res = await callLogin({ email: 'person@example.com', password: 'correct-password' })
    const body = await res.json()

    expect(res.status).toBe(403)
    expect(body.code).toBe('AUTH_NOT_ADMIN')
    expect(body.redirect).toBe('/admin/access-denied')
    expect(signOut).toHaveBeenCalledWith({ scope: 'local' })
    const cookies = (res as unknown as { cookies: { getAll: () => Array<{ name: string }> } }).cookies.getAll()
    expect(cookies.map((c) => c.name)).not.toContain('sb-access-token')
    expect(cookies.map((c) => c.name)).not.toContain('sb-refresh-token')
    expect(JSON.stringify(body)).not.toContain('access-abc')
  })

  it('fails closed when the admin lookup throws', async () => {
    signInWithPassword.mockResolvedValue({ data: { session, user }, error: null })
    isAdminUser.mockRejectedValue(new Error('db down'))

    const res = await callLogin({ email: 'person@example.com', password: 'correct-password' })
    expect(res.status).toBe(403)
    expect(signOut).toHaveBeenCalled()
  })

  it('signs an admin in with cookies only and sends them to the console', async () => {
    signInWithPassword.mockResolvedValue({ data: { session, user }, error: null })
    isAdminUser.mockResolvedValue(true)

    const res = await callLogin({ email: 'admin@example.com', password: 'correct-password' })
    const body = await res.json()

    expect(res.status).toBe(200)
    expect(body.redirect).toBe('/admin')
    expect(JSON.stringify(body)).not.toContain('access-abc')
    expect(JSON.stringify(body)).not.toContain('refresh-abc')
    expect(signOut).not.toHaveBeenCalled()
    const names = (res as unknown as { cookies: { getAll: () => Array<{ name: string }> } }).cookies.getAll().map((c) => c.name)
    expect(names).toContain('sb-access-token')
  })

  it('answers a wrong password with 401 and never checks admin status', async () => {
    signInWithPassword.mockResolvedValue({ data: { session: null, user: null }, error: { message: 'Invalid login credentials' } })

    const res = await callLogin({ email: 'person@example.com', password: 'wrong' })
    expect(res.status).toBe(401)
    expect(isAdminUser).not.toHaveBeenCalled()
  })

  it('has no Google OAuth or signup route in this repo', async () => {
    const fs = await import('node:fs')
    const path = await import('node:path')
    const root = path.resolve(import.meta.dirname, '../..')
    for (const route of ['google', 'signup', 'callback', 'complete-consent']) {
      expect(fs.existsSync(path.join(root, 'app/api/auth', route))).toBe(false)
    }
  })
})
