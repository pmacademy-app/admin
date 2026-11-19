import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

import { createRecordingSupabase, eqValue, type RecordedQuery, type QueryResult } from './helpers/recording-supabase'

/**
 * Admin console side of monitoring: the Errors API (SUM(occurrence_count), last seen
 * from updated_at, ignored groups hidden by default), the ignore / unignore API
 * (admin only, audited, capped at 500), auth health reporting `unknown` on failure,
 * and the System routes and service paths that used to swallow failures.
 */

let respond: (query: RecordedQuery) => QueryResult = () => ({ data: [] })
let recording = createRecordingSupabase((q) => respond(q))

vi.mock('@/lib/supabase', () => ({
  createServiceRoleClient: vi.fn(() => recording.client),
  createAuthenticatedServerClient: vi.fn(() => recording.client),
}))

const ADMIN_ID = '55555555-5555-5555-5555-555555555555'
let adminAuthorized = true
const logAdminAction = vi.fn<(...args: unknown[]) => Promise<void>>(async () => {})
vi.mock('@/lib/admin/guard', () => ({
  requireAdminUser: vi.fn(async () =>
    adminAuthorized
      ? { authorized: true, userId: ADMIN_ID, email: 'admin@example.com', statusCode: 200 }
      : { authorized: false, statusCode: 403, error: 'not an admin' }
  ),
  logAdminAction: (...args: unknown[]) => logAdminAction(...args),
}))

vi.mock('@/lib/auth', () => ({ getAuthenticatedUserFromRequest: vi.fn(async () => null) }))

const getSystemHealth = vi.fn(async () => ({
  status: 'healthy',
  databaseLatencyMs: 5,
  environment: 'test',
  lastCheckedAt: new Date().toISOString(),
}))
vi.mock('@/lib/admin/service', () => ({
  AdminConsoleService: {
    getSystemHealth: () => getSystemHealth(),
    getEmailQueueOverview: vi.fn(async () => ({
      failed: false,
      failedCount: 0,
      pendingCount: 0,
      processingCount: 0,
      deliveredCount: 0,
    })),
  },
}))

const logErrorReport = vi.fn<(report: Record<string, unknown>, ctx?: unknown) => Promise<string>>(async () => 'row-id')
vi.mock('@/lib/monitoring/logger', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/monitoring/logger')>()
  return {
    ...actual,
    logErrorReport: (report: Record<string, unknown>, ctx?: unknown) => logErrorReport(report, ctx),
  }
})

import { SystemService } from '@/lib/admin/system-service'
import { GET as getErrors } from '@/app/api/admin/system/errors/route'
import { POST as postIgnore } from '@/app/api/admin/system/errors/ignore/route'
import { GET as getLatest } from '@/app/api/admin/system/errors/latest/route'
import { GET as getHealth } from '@/app/api/admin/system/health/route'
import { GET as getAudit } from '@/app/api/admin/system/audit/route'
import { GET as getAuthHealth } from '@/app/api/admin/system/auth-health/route'
import { PATCH as patchAlerts } from '@/app/api/admin/system/alerts/route'

function loggedOperations(): string[] {
  return logErrorReport.mock.calls.map(([report]) => String(report.operation))
}

beforeEach(() => {
  recording = createRecordingSupabase((q) => respond(q))
  respond = () => ({ data: [] })
  adminAuthorized = true
  logAdminAction.mockClear()
  logErrorReport.mockClear()
  getSystemHealth.mockClear()
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  vi.spyOn(console, 'error').mockImplementation(() => {})
})

afterEach(() => {
  vi.restoreAllMocks()
})

// ─── Errors API ──────────────────────────────────────────────────────────────

const T = (minutesAgo: number) => new Date(Date.UTC(2026, 10, 19, 12, 0) - minutesAgo * 60_000).toISOString()

/** Newest insert first, as the query orders them. */
const ERROR_ROWS = [
  // fpB: inserted most recently, but last seen before fpA's latest occurrence.
  { id: 'b1', fingerprint: 'fpB', severity: 'error', category: 'api', operation: 'op.b', message: 'B', status: 'new',
    timestamp: T(30), updated_at: T(30), first_seen_at: T(30), occurrence_count: 1, app: 'web', release: null, regression: null },
  // fpA newest row: a regression, seen 5 times... last seen 2 minutes ago.
  { id: 'a2', fingerprint: 'fpA', severity: 'critical', category: 'admin', operation: 'op.a', message: 'A', status: 'new',
    timestamp: T(60), updated_at: T(2), first_seen_at: T(60), occurrence_count: 3, app: 'admin', release: 'abcdef123456', regression: 'true' },
  // fpC: on the ignore list.
  { id: 'c1', fingerprint: 'fpC', severity: 'warning', category: 'api', operation: 'op.c', message: 'C', status: 'new',
    timestamp: T(90), updated_at: T(1), first_seen_at: T(90), occurrence_count: 9, app: 'web', release: null, regression: null },
  // fpA older, resolved row.
  { id: 'a1', fingerprint: 'fpA', severity: 'critical', category: 'admin', operation: 'op.a', message: 'A', status: 'resolved',
    timestamp: T(600), updated_at: T(500), first_seen_at: T(600), occurrence_count: 4, app: 'admin', release: 'old', regression: null },
]

function errorsResponder(ignored: string[] = ['fpC']) {
  return (q: RecordedQuery): QueryResult => {
    if (q.table === 'system_errors' && q.op === 'select') {
      return { data: q.range && q.range[0] > 0 ? [] : ERROR_ROWS }
    }
    if (q.table === 'system_settings' && q.op === 'select') return { data: { value: ignored } }
    return { data: null }
  }
}

function adminGet(url: string): Request {
  return new Request(url, { headers: { cookie: 'sb-access-token=t' } })
}

describe('GET /api/admin/system/errors', () => {
  it('sums occurrence_count, takes last seen from updated_at, sorts by last seen and hides ignored groups', async () => {
    respond = errorsResponder()
    const res = await getErrors(adminGet('http://localhost:3000/api/admin/system/errors'))
    const body = await res.json()
    expect(res.status).toBe(200)
    expect(body.groups.map((g: { fingerprint: string }) => g.fingerprint)).toEqual(['fpA', 'fpB'])
    const a = body.groups[0]
    expect(a.occurrences).toBe(7)
    expect(a.lastSeen).toBe(T(2))
    expect(a.firstSeen).toBe(T(600))
    expect(a.status).toBe('new')
    expect(a).toMatchObject({ app: 'admin', release: 'abcdef123456', regression: true, ignored: false })
    expect(body.total).toBe(2)
    expect(body.ignoredHidden).toBe(1)
  })

  it('shows ignored groups with the flag when showIgnored=true', async () => {
    respond = errorsResponder()
    const res = await getErrors(adminGet('http://localhost:3000/api/admin/system/errors?showIgnored=true'))
    const body = await res.json()
    expect(body.groups.map((g: { fingerprint: string }) => g.fingerprint)).toEqual(['fpC', 'fpA', 'fpB'])
    expect(body.groups[0].ignored).toBe(true)
    expect(body.ignoredHidden).toBe(0)
  })

  it('applies the app and release filters to the query', async () => {
    respond = errorsResponder()
    await getErrors(adminGet('http://localhost:3000/api/admin/system/errors?app=web&release=abcdef123456'))
    const query = recording.calls.find((q) => q.table === 'system_errors')!
    expect(eqValue(query, 'details->>app')).toBe('web')
    expect(eqValue(query, 'details->>release')).toBe('abcdef123456')
  })

  it('shows everything and says so when the ignore list cannot be read', async () => {
    const base = errorsResponder()
    respond = (q) =>
      q.table === 'system_settings' ? { data: null, error: { message: 'settings down' } } : base(q)
    const body = await (await getErrors(adminGet('http://localhost:3000/api/admin/system/errors'))).json()
    expect(body.groups).toHaveLength(3)
    expect(body.ignoreListUnavailable).toBe(true)
    expect(loggedOperations()).toContain('admin.system.ignore_list_read')
  })

  it('refuses a non-admin', async () => {
    adminAuthorized = false
    const res = await getErrors(adminGet('http://localhost:3000/api/admin/system/errors'))
    expect([401, 403]).toContain(res.status)
  })

  it('the latest-incident endpoint returns the newest row with its details', async () => {
    respond = (q) =>
      q.table === 'system_errors'
        ? {
            data: [
              {
                id: 'a2', fingerprint: 'fpA', timestamp: T(60), updated_at: T(2), first_seen_at: T(60),
                severity: 'critical', status: 'new', category: 'admin', operation: 'op.a', message: 'A',
                occurrence_count: 3, user_id: ADMIN_ID,
                details: { stack: 'Error: A\n    at x (/a.js:1:1)', app: 'admin', runtime: 'server', regression: true },
              },
            ],
          }
        : { data: null }
    const res = await getLatest(adminGet('http://localhost:3000/api/admin/system/errors/latest?fingerprint=fpA'))
    const body = await res.json()
    expect(body.incident).toMatchObject({ id: 'a2', userId: ADMIN_ID, occurrenceCount: 3 })
    expect(body.incident.details.stack).toContain('Error: A')
    const query = recording.calls[0]
    expect(eqValue(query, 'fingerprint')).toBe('fpA')
    expect(query.order[0]).toEqual({ column: 'timestamp', ascending: false })
  })
})

// ─── Ignore / unignore API ───────────────────────────────────────────────────

function ignoreRequest(body: unknown): Request {
  return new Request('http://localhost:3000/api/admin/system/errors/ignore', {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie: 'sb-access-token=t' },
    body: JSON.stringify(body),
  })
}

function settingsResponder(list: string[]) {
  return (q: RecordedQuery): QueryResult => {
    if (q.table === 'system_settings' && q.op === 'select') return { data: { value: list } }
    if (q.table === 'system_settings' && q.op === 'upsert') return { data: null }
    return { data: null }
  }
}

function upserts(): Array<Record<string, unknown>> {
  return recording.calls
    .filter((q) => q.table === 'system_settings' && q.op === 'upsert')
    .map((q) => q.payload as Record<string, unknown>)
}

describe('POST /api/admin/system/errors/ignore', () => {
  it('is admin only', async () => {
    adminAuthorized = false
    respond = settingsResponder([])
    const res = await postIgnore(ignoreRequest({ fingerprint: 'fpX', ignored: true }))
    expect([401, 403]).toContain(res.status)
    expect(upserts()).toHaveLength(0)
    expect(logAdminAction).not.toHaveBeenCalled()
  })

  it('adds the fingerprint to system_settings and writes an audit row', async () => {
    respond = settingsResponder(['fpOld'])
    const res = await postIgnore(ignoreRequest({ fingerprint: 'fpX', ignored: true }))
    expect(res.status).toBe(200)
    const [write] = upserts()
    expect(write.key).toBe('monitoring_ignored_fingerprints')
    expect(write.value).toEqual(['fpOld', 'fpX'])
    expect(logAdminAction).toHaveBeenCalledWith(
      ADMIN_ID,
      'admin@example.com',
      'system_error_ignored',
      'system_error',
      'fpX',
      expect.objectContaining({ ignored: true, ignoreListSize: 2 })
    )
  })

  it('removes the fingerprint on unignore and audits it', async () => {
    respond = settingsResponder(['fpOld', 'fpX'])
    const res = await postIgnore(ignoreRequest({ fingerprint: 'fpX', ignored: false }))
    expect(res.status).toBe(200)
    expect(upserts()[0].value).toEqual(['fpOld'])
    expect(logAdminAction.mock.calls[0][2]).toBe('system_error_unignored')
  })

  it('refuses to grow the list past 500 entries', async () => {
    respond = settingsResponder(Array.from({ length: 500 }, (_, i) => `fp${i}`))
    const res = await postIgnore(ignoreRequest({ fingerprint: 'fpNew', ignored: true }))
    expect(res.status).toBe(409)
    expect((await res.json()).code).toBe('IGNORE_LIST_FULL')
    expect(upserts()).toHaveLength(0)
    expect(logAdminAction).not.toHaveBeenCalled()
  })

  it('does not write or audit when nothing changes', async () => {
    respond = settingsResponder(['fpX'])
    const body = await (await postIgnore(ignoreRequest({ fingerprint: 'fpX', ignored: true }))).json()
    expect(body.changed).toBe(false)
    expect(upserts()).toHaveLength(0)
    expect(logAdminAction).not.toHaveBeenCalled()
  })

  it('rejects an invalid fingerprint', async () => {
    respond = settingsResponder([])
    const res = await postIgnore(ignoreRequest({ fingerprint: 'not valid!', ignored: true }))
    expect(res.status).toBe(400)
  })
})

// ─── Auth health ─────────────────────────────────────────────────────────────

describe('getAuthHealthTelemetry', () => {
  it('returns unknown, not healthy, when a telemetry query fails, and records it', async () => {
    respond = (q) => (q.table === 'system_errors' ? { data: null, error: { message: 'query failed' } } : { data: null })
    const telemetry = await SystemService.getAuthHealthTelemetry()
    expect(telemetry.status).toBe('unknown')
    expect(loggedOperations()).toContain('admin.system.auth_health')
  })

  it('reports healthy when the queries succeed with no failures', async () => {
    respond = () => ({ data: [], count: 0 })
    const telemetry = await SystemService.getAuthHealthTelemetry()
    expect(telemetry.status).toBe('healthy')
    expect(logErrorReport).not.toHaveBeenCalled()
  })
})

// ─── Swallowed failures are now logged ───────────────────────────────────────

describe('swallowed failures are recorded', () => {
  it('getErrorGroups logs and returns failed: true', async () => {
    respond = (q) => (q.table === 'system_errors' ? { data: null, error: { message: 'boom' } } : { data: { value: [] } })
    const result = await SystemService.getErrorGroups({})
    expect(result.failed).toBe(true)
    expect(loggedOperations()).toContain('admin.system.error_groups')
  })

  it('getAuditLog logs and returns failed: true', async () => {
    respond = (q) => (q.table === 'admin_audit_logs' ? { data: null, error: { message: 'boom' } } : { data: null })
    const result = await SystemService.getAuditLog({})
    expect(result.failed).toBe(true)
    expect(loggedOperations()).toContain('admin.system.audit_log')
  })

  it('getHealthOverview logs and returns failed: true', async () => {
    getSystemHealth.mockRejectedValueOnce(new Error('db unreachable'))
    const result = await SystemService.getHealthOverview()
    expect(result.failed).toBe(true)
    expect(result.overallStatus).toBe('unknown')
    expect(loggedOperations()).toContain('admin.system.health_overview')
  })

  it('GET /api/admin/system/errors logs a thrown failure with the admin id and keeps the 500', async () => {
    vi.spyOn(SystemService, 'getErrorGroups').mockRejectedValueOnce(new Error('unexpected'))
    const res = await getErrors(adminGet('http://localhost:3000/api/admin/system/errors'))
    expect(res.status).toBe(500)
    expect((await res.json()).success).toBe(false)
    const call = logErrorReport.mock.calls.find(([r]) => r.operation === 'admin.system.errors.get')!
    expect((call[0].subject as { userId: string }).userId).toBe(ADMIN_ID)
    expect((call[1] as { error: unknown }).error).toBeInstanceOf(Error)
  })

  it('GET /api/admin/system/health logs and keeps the 500', async () => {
    getSystemHealth.mockRejectedValueOnce(new Error('db unreachable'))
    const res = await getHealth(adminGet('http://localhost:3000/api/admin/system/health'))
    expect(res.status).toBe(500)
    expect(loggedOperations()).toContain('admin.system.health.get')
  })

  it('GET /api/admin/system/audit logs and keeps the 500', async () => {
    vi.spyOn(SystemService, 'getAuditLog').mockRejectedValueOnce(new Error('unexpected'))
    const res = await getAudit(adminGet('http://localhost:3000/api/admin/system/audit'))
    expect(res.status).toBe(500)
    expect(loggedOperations()).toContain('admin.system.audit.get')
  })

  it('GET /api/admin/system/auth-health logs and keeps the 500', async () => {
    vi.spyOn(SystemService, 'getAuthHealthTelemetry').mockRejectedValueOnce(new Error('unexpected'))
    const res = await getAuthHealth(adminGet('http://localhost:3000/api/admin/system/auth-health'))
    expect(res.status).toBe(500)
    expect(loggedOperations()).toContain('admin.system.auth_health.get')
  })

  it('PATCH /api/admin/system/alerts logs a failed update and leaves updated_at alone', async () => {
    respond = (q) => (q.op === 'update' ? { data: null, error: { message: 'update failed' } } : { data: null })
    const res = await patchAlerts(
      new Request('http://localhost:3000/api/admin/system/alerts', {
        method: 'PATCH',
        headers: { 'content-type': 'application/json', cookie: 'sb-access-token=t' },
        body: JSON.stringify({ alertId: 'a1', newStatus: 'acknowledged' }),
      })
    )
    expect(res.status).toBe(400)
    expect(loggedOperations()).toContain('admin.system.alerts.patch')
    const update = recording.calls.find((q) => q.op === 'update')!
    expect(update.payload).toEqual({ status: 'acknowledged' })
  })

  it('status changes on an error group do not move updated_at (last seen)', async () => {
    respond = () => ({ data: [{ id: 'a1' }] })
    await SystemService.updateErrorGroupStatus('fpA', 'resolved')
    const update = recording.calls.find((q) => q.op === 'update')!
    expect(update.payload).toEqual({ status: 'resolved' })
  })
})
