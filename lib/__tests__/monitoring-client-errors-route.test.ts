import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

/**
 * POST /api/client-errors in the admin app: contract A fields for client reports,
 * attribution from the session only (contract B), body cap, per-IP and global
 * limits. Also covers withRoute passing the actor id to an incident.
 */

type LimitResult = { success: boolean; remaining: number; resetInMs: number }
const rateLimit = vi.fn<(key: string, opts: unknown) => Promise<LimitResult>>(async () => ({
  success: true,
  remaining: 1,
  resetInMs: 1000,
}))
vi.mock('@/lib/rate-limit', () => ({
  evaluatePersistentRateLimit: (key: string, opts: unknown) => rateLimit(key, opts),
}))

type GuardResult = { authorized: boolean; userId?: string; email?: string; statusCode: number; error: string }
const requireAdminUser = vi.fn<(req: Request, opts?: unknown) => Promise<GuardResult>>(async () => ({
  authorized: false,
  statusCode: 401,
  error: 'no session',
}))
vi.mock('@/lib/admin/guard', () => ({
  requireAdminUser: (req: Request, opts?: unknown) => requireAdminUser(req, opts),
  logAdminAction: vi.fn(async () => {}),
}))

vi.mock('@/lib/auth', () => ({
  getAuthenticatedUserFromRequest: vi.fn(async () => null),
}))

const logSystemError = vi.fn<(opts: Record<string, unknown>) => Promise<string>>(async () => 'row-id')
const logErrorReport = vi.fn<(report: Record<string, unknown>, ctx?: Record<string, unknown>) => Promise<string>>(
  async () => 'row-id'
)
vi.mock('@/lib/monitoring/logger', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/monitoring/logger')>()
  return {
    ...actual,
    logSystemError: (opts: Record<string, unknown>) => logSystemError(opts),
    logErrorReport: (report: Record<string, unknown>, ctx?: Record<string, unknown>) => logErrorReport(report, ctx),
  }
})

import { POST } from '@/app/api/client-errors/route'
import { withRoute } from '@/lib/api/with-route'
import { MAX_CLIENT_ERROR_BODY_BYTES } from '@/lib/monitoring/client-error-beacon'

function post(body: unknown, headers: Record<string, string> = {}): Request {
  return new Request('http://localhost:3000/api/client-errors', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-forwarded-for': '203.0.113.7', ...headers },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  })
}

const validReport = {
  message: 'Cannot read properties of undefined',
  path: '/admin/users',
  source: 'window.onerror',
  stack: 'TypeError: Cannot read properties of undefined\n    at onClick (/_next/static/chunks/app.js:1:2)',
  release: 'abcdef1234567890',
}

beforeEach(() => {
  rateLimit.mockClear()
  rateLimit.mockImplementation(async () => ({ success: true, remaining: 1, resetInMs: 1000 }))
  requireAdminUser.mockClear()
  requireAdminUser.mockImplementation(async () => ({
    authorized: false,
    userId: undefined,
    email: undefined,
    statusCode: 401,
    error: 'no session',
  }))
  logSystemError.mockClear()
  logErrorReport.mockClear()
  vi.spyOn(console, 'error').mockImplementation(() => {})
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('POST /api/client-errors', () => {
  it('records a client report with runtime, source, release (12 chars), stack and path', async () => {
    const res = await POST(post(validReport))
    expect(res.status).toBe(204)
    expect(logSystemError).toHaveBeenCalledTimes(1)
    const opts = logSystemError.mock.calls[0][0]
    expect(opts).toMatchObject({
      severity: 'warning',
      category: 'api',
      operation: 'client.window_error',
      runtime: 'client',
      source: 'window.onerror',
      release: 'abcdef123456',
      stack: validReport.stack,
    })
    expect(opts.userId).toBeUndefined()
    expect(opts.details).toMatchObject({ path: '/admin/users', clientMessage: validReport.message })
  })

  it('accepts a boundary report and keeps the boundary', async () => {
    const res = await POST(post({ message: 'boom', path: '/admin', source: 'boundary', boundary: 'admin' }))
    expect(res.status).toBe(204)
    const opts = logSystemError.mock.calls[0][0]
    expect(opts.operation).toBe('client.error_boundary')
    expect(opts.source).toBe('boundary')
    expect(opts.details).toMatchObject({ boundary: 'admin' })
  })

  it('refuses a boundary report that does not name its boundary', async () => {
    const res = await POST(post({ message: 'boom', path: '/admin', source: 'boundary' }))
    expect(res.status).toBe(400)
    expect(logSystemError).not.toHaveBeenCalled()
  })

  it('refuses a client-sent user id instead of trusting it', async () => {
    const res = await POST(post({ ...validReport, userId: '11111111-1111-1111-1111-111111111111' }))
    expect(res.status).toBe(400)
    expect(logSystemError).not.toHaveBeenCalled()
  })

  it('attributes the report to the signed-in admin from the session', async () => {
    requireAdminUser.mockImplementation(async () => ({
      authorized: true,
      userId: '99999999-9999-9999-9999-999999999999',
      email: 'admin@example.com',
      statusCode: 200,
      error: '',
    }))
    const res = await POST(post(validReport, { cookie: 'sb-access-token=abc' }))
    expect(res.status).toBe(204)
    expect(logSystemError.mock.calls[0][0].userId).toBe('99999999-9999-9999-9999-999999999999')
  })

  it('refuses a body over the 8 KB cap with 413', async () => {
    const big = JSON.stringify({ ...validReport, message: 'x'.repeat(MAX_CLIENT_ERROR_BODY_BYTES) })
    const res = await POST(post(big))
    expect(res.status).toBe(413)
    expect(logSystemError).not.toHaveBeenCalled()
  })

  it('refuses malformed JSON with 400', async () => {
    const res = await POST(post('{not json'))
    expect(res.status).toBe(400)
  })

  it('charges a per-IP bucket and a global bucket', async () => {
    await POST(post(validReport))
    const keys = rateLimit.mock.calls.map((call) => call[0])
    expect(keys).toContain('client_errors:global')
    expect(keys.some((key) => key.startsWith('client_errors:') && key !== 'client_errors:global')).toBe(true)
    const globalCall = rateLimit.mock.calls.find((call) => call[0] === 'client_errors:global')!
    expect(globalCall[1]).toMatchObject({ limit: 300, windowMs: 10 * 60 * 1000 })
  })

  it('answers 429 when the global cap is exhausted, even for a fresh IP', async () => {
    rateLimit.mockImplementation(async (key: string) =>
      key === 'client_errors:global'
        ? { success: false, remaining: 0, resetInMs: 5000 }
        : { success: true, remaining: 9, resetInMs: 1000 }
    )
    const res = await POST(post(validReport, { 'x-forwarded-for': '198.51.100.1' }))
    expect(res.status).toBe(429)
    expect(logSystemError).not.toHaveBeenCalled()
    // The session lookup happens after the limiter, so a flood buys no auth calls.
    expect(requireAdminUser).not.toHaveBeenCalled()
  })
})

describe('withRoute attribution (contract B)', () => {
  it('passes the resolved admin id and the caught error to the incident', async () => {
    requireAdminUser.mockImplementation(async () => ({
      authorized: true,
      userId: '77777777-7777-7777-7777-777777777777',
      email: 'admin@example.com',
      statusCode: 200,
      error: '',
    }))
    const failure = new Error('handler exploded')
    const handler = withRoute(
      { actor: { allow: ['admin'] }, operation: 'admin.test.boom', domain: 'admin' },
      async () => {
        throw failure
      }
    )
    const res = await handler(new Request('http://localhost:3000/api/admin/test'))
    expect(res.status).toBe(500)
    expect(logErrorReport).toHaveBeenCalledTimes(1)
    const [report, ctx] = logErrorReport.mock.calls[0]
    expect((report.subject as { userId?: string }).userId).toBe('77777777-7777-7777-7777-777777777777')
    expect(ctx?.error).toBe(failure)
  })
})
