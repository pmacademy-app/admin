import { describe, it, expect, vi } from 'vitest'
import { sanitizeErrorMessage } from '../monitoring/logger'

// Admin split: the email webhook, cron and health route cases stay in the web repo, which
// hosts those routes. The admin copy keeps the redaction and admin system route cases.

// ---------------------------------------------------------------------------
// IMPORTANT: This test suite must NEVER call logSystemError with a live
// Supabase client, because CI has a real SUPABASE_SERVICE_ROLE_KEY injected
// and would write test records into the production system_errors table.
//
// Sanitisation is tested via the exported pure helper `sanitizeErrorMessage`
// which has no I/O.  All DB-touching paths are mocked below.
// ---------------------------------------------------------------------------

function makeSupabaseMock() {
  const queryBuilder = {
    eq: vi.fn().mockReturnThis(),
    gte: vi.fn().mockReturnThis(),
    in: vi.fn().mockReturnThis(),
    lte: vi.fn().mockReturnThis(),
    order: vi.fn().mockReturnThis(),
    limit: vi.fn().mockReturnThis(),
    not: vi.fn().mockReturnThis(),
    gt: vi.fn().mockReturnThis(),
    maybeSingle: vi.fn(async () => ({ data: null, error: null })),
    single: vi.fn(async () => ({ data: { id: 'mock-id' }, error: null })),
    select: vi.fn().mockReturnThis(),
    insert: vi.fn().mockReturnThis(),
    update: vi.fn().mockReturnThis(),
    upsert: vi.fn().mockReturnThis(),
    delete: vi.fn().mockReturnThis(),
  }
  return {
    from: vi.fn(() => queryBuilder),
    auth: { getUser: vi.fn(async () => ({ data: { user: null } })) },
    rpc: vi.fn(async () => ({ data: null, error: { message: 'rpc not available in test' } })),
  }
}

vi.mock('@/lib/supabase', () => ({
  createServiceRoleClient: vi.fn(() => makeSupabaseMock()),
  createAuthenticatedServerClient: vi.fn(() => makeSupabaseMock()),
}))

describe('System Monitoring & Error Instrumentation Unit Test Suite', () => {
  // ── 1. Pure sanitisation tests (no DB, no network) ────────────────────────

  it('sanitizeErrorMessage redacts Bearer tokens', () => {
    const input = 'Test error containing Bearer secret_token_123 and more text'
    const output = sanitizeErrorMessage(input)
    expect(output).not.toContain('secret_token_123')
    expect(output).toContain('Bearer [REDACTED]')
  })

  it('sanitizeErrorMessage redacts whsec_ webhook secrets', () => {
    const input = 'Hook secret: whsec_abc123xyz456'
    const output = sanitizeErrorMessage(input)
    expect(output).not.toContain('abc123xyz456')
    expect(output).toContain('whsec_[REDACTED]')
  })

  it('sanitizeErrorMessage redacts Resend API key prefixes', () => {
    // Synthetic key. This fixture previously held a 28-character prefix of the
    // live RESEND_API_KEY, which the B14-B secret scan caught on its first run.
    const input = 'API key re_TestPlaceholder_NotARealResendKey000 leaked in message'
    const output = sanitizeErrorMessage(input)
    expect(output).not.toContain('TestPlaceholder_NotARealResendKey000')
    expect(output).toContain('re_[REDACTED]')
  })

  it('sanitizeErrorMessage redacts Svix v1 signatures', () => {
    const input = 'Signature check failed for v1,someBase64Sig=='
    const output = sanitizeErrorMessage(input)
    expect(output).not.toContain('someBase64Sig==')
    expect(output).toContain('v1,[REDACTED]')
  })

  it('sanitizeErrorMessage returns empty string for empty input', () => {
    expect(sanitizeErrorMessage('')).toBe('')
  })

  it('sanitizeErrorMessage leaves non-sensitive messages unchanged', () => {
    const safe = 'Database query returned 0 rows for user lookup'
    expect(sanitizeErrorMessage(safe)).toBe(safe)
  })

  it('GET /api/admin/system/alerts rejects unauthorized requests with 401 or 403', async () => {
    const { NextRequest } = await import('next/server')
    const { GET: handleSystemAlerts } = await import('../../app/api/admin/system/alerts/route')
    const req = new NextRequest('http://localhost:3000/api/admin/system/alerts')
    const res = await handleSystemAlerts(req)
    expect([401, 403].includes(res.status)).toBe(true)
  })

  it('GET /api/admin/system/audit rejects unauthorized requests with 401 or 403', async () => {
    const { NextRequest } = await import('next/server')
    const { GET: handleSystemAudit } = await import('../../app/api/admin/system/audit/route')
    const req = new NextRequest('http://localhost:3000/api/admin/system/audit')
    const res = await handleSystemAudit(req)
    expect([401, 403].includes(res.status)).toBe(true)
  })

  it('SystemService.getHealthOverview returns valid telemetry overview', async () => {
    const { SystemService } = await import('../admin/system-service')
    const overview = await SystemService.getHealthOverview()
    expect(overview).toBeDefined()
    expect(['healthy', 'degraded', 'down'].includes(overview.overallStatus)).toBe(true)
    expect(typeof overview.databaseLatencyMs).toBe('number')
  })

})
