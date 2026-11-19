import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

import { createRecordingSupabase, eqValue, type RecordedQuery, type QueryResult } from './helpers/recording-supabase'

/**
 * Logger contract A to E (shared with the learner repo):
 *   A. details.stack / release / app / runtime / source
 *   B. user_id column from the server-side actor
 *   C. ignore list: recorded, never alerts; 60 s cache; fail open
 *   D. regression: latest row resolved -> new row, details.regression = true
 *   E. dedup window of 15 minutes measured from updated_at
 */

const state: {
  latest: Array<Record<string, unknown>>
  settings: QueryResult
  insertError: { message: string; code?: string } | null
} = { latest: [], settings: { data: null }, insertError: null }

function respond(query: RecordedQuery): QueryResult {
  if (query.table === 'system_errors') {
    if (query.op === 'insert') {
      if (state.insertError) {
        const error = state.insertError
        state.insertError = null
        return { data: null, error }
      }
      return { data: { id: 'new-row' } }
    }
    if (query.op === 'update') return { data: null }
    // The notification cooldown lookup excludes the new row.
    if (query.filters.some((f) => f.op === 'neq')) return { data: [] }
    return { data: state.latest }
  }
  if (query.table === 'system_settings') return state.settings
  if (query.table === 'users') return { data: [] }
  return { data: null }
}

let recording = createRecordingSupabase(respond)

vi.mock('@/lib/supabase', () => ({
  createServiceRoleClient: vi.fn(() => recording.client),
}))

const deliverOutOfBandAlert = vi.fn(async () => {})
vi.mock('@/lib/monitoring/out-of-band-alert', () => ({
  deliverOutOfBandAlert: (...args: unknown[]) => deliverOutOfBandAlert(...(args as [])),
}))

import {
  logErrorReport,
  logSystemError,
  invalidateIgnoredFingerprintsCache,
  parseIgnoredFingerprints,
  MAX_IGNORED_FINGERPRINTS,
  DEDUP_WINDOW_MS,
} from '@/lib/monitoring/logger'
import { redactStack, MAX_STACK_FRAMES, MAX_STACK_LENGTH } from '@/lib/monitoring/redaction'

const ORIGINAL_ENV = { ...process.env }

function inserts(): RecordedQuery[] {
  return recording.calls.filter((q) => q.table === 'system_errors' && q.op === 'insert')
}
function updates(): RecordedQuery[] {
  return recording.calls.filter((q) => q.table === 'system_errors' && q.op === 'update')
}
function insertedRow(index = 0): Record<string, unknown> {
  return inserts()[index].payload as Record<string, unknown>
}
function insertedDetails(index = 0): Record<string, unknown> {
  return insertedRow(index).details as Record<string, unknown>
}

function stackWithFrames(count: number, header = 'Error: boom'): string {
  const frames = Array.from({ length: count }, (_, i) => `    at fn${i} (/app/file${i}.js:${i + 1}:2)`)
  return [header, ...frames].join('\n')
}

beforeEach(() => {
  recording = createRecordingSupabase(respond)
  state.latest = []
  state.settings = { data: null }
  state.insertError = null
  invalidateIgnoredFingerprintsCache()
  deliverOutOfBandAlert.mockClear()
  delete process.env.VERCEL_GIT_COMMIT_SHA
  delete process.env.NEXT_PUBLIC_VERCEL_GIT_COMMIT_SHA
  vi.spyOn(console, 'error').mockImplementation(() => {})
  vi.spyOn(console, 'warn').mockImplementation(() => {})
})

afterEach(() => {
  process.env = { ...ORIGINAL_ENV }
  vi.restoreAllMocks()
})

describe('A. details fields', () => {
  it('records a redacted, bounded stack from the error and its cause, plus release, app and runtime', async () => {
    process.env.VERCEL_GIT_COMMIT_SHA = 'abcdef1234567890abcdef1234567890abcdef12'
    const inner = new Error('inner failure')
    inner.stack = 'Error: inner failure\n    at inner (/app/db.js:1:1)'
    const outer = new Error('outer failure', { cause: inner })
    outer.stack = stackWithFrames(5, 'Error: outer failure Bearer secret_token_value_123')

    await logErrorReport(
      { domain: 'api', kind: 'unexpected', operation: 'test.op', summary: 'Test failure' },
      { error: outer }
    )

    const details = insertedDetails()
    expect(details.app).toBe('admin')
    expect(details.runtime).toBe('server')
    expect(details.release).toBe('abcdef123456')
    expect(details.source).toBeUndefined()
    const stack = String(details.stack)
    expect(stack).toContain('at fn0 (/app/file0.js:1:2)')
    expect(stack).toContain('Caused by: Error: inner failure')
    expect(stack).toContain('at inner (/app/db.js:1:1)')
    expect(stack).not.toContain('secret_token_value_123')
  })

  it('omits release when no commit SHA is set', async () => {
    await logErrorReport({ domain: 'api', kind: 'unexpected', operation: 'test.op', summary: 'No release' })
    const details = insertedDetails()
    expect('release' in details).toBe(false)
    expect(details.app).toBe('admin')
  })

  it('keeps a client report runtime, source, stack and its own release', async () => {
    process.env.VERCEL_GIT_COMMIT_SHA = 'ffffffffffffffffffff'
    await logSystemError({
      severity: 'warning',
      category: 'api',
      operation: 'client.window_error',
      message: 'Uncaught error in the browser: x is undefined',
      runtime: 'client',
      source: 'window.onerror',
      stack: stackWithFrames(2, 'TypeError: x is undefined'),
      release: '0123456789ab',
      details: { path: '/admin/users' },
    })
    const details = insertedDetails()
    expect(details).toMatchObject({
      runtime: 'client',
      source: 'window.onerror',
      release: '0123456789ab',
      app: 'admin',
      path: '/admin/users',
    })
    expect(String(details.stack)).toContain('TypeError: x is undefined')
  })

  it('does not stamp the server release on a client report that has none', async () => {
    process.env.VERCEL_GIT_COMMIT_SHA = 'ffffffffffffffffffff'
    await logSystemError({
      severity: 'warning',
      category: 'api',
      operation: 'client.error_boundary',
      message: 'boom',
      runtime: 'client',
      source: 'boundary',
    })
    expect('release' in insertedDetails()).toBe(false)
  })

  it('redactStack keeps at most 30 frames, 4000 characters, and drops query strings', () => {
    const long = stackWithFrames(80)
    const redacted = redactStack(long) as string
    const frames = redacted.split('\n').filter((line) => line.trim().startsWith('at '))
    expect(frames).toHaveLength(MAX_STACK_FRAMES)
    expect(redacted.length).toBeLessThanOrEqual(MAX_STACK_LENGTH)

    const huge = redactStack(`Error: ${'x'.repeat(9000)}\n    at a (/a.js:1:1)`) as string
    expect(huge.length).toBe(MAX_STACK_LENGTH)

    const withQuery = redactStack('Error: e\n    at f (https://admin.test/reset?token=abc123secret:4:5)') as string
    expect(withQuery).not.toContain('abc123secret')
    expect(withQuery).toContain('https://admin.test/reset:4:5')
    expect(redactStack('')).toBeUndefined()
    expect(redactStack(undefined)).toBeUndefined()
  })
})

describe('B. user_id column', () => {
  it('fills user_id from the report subject', async () => {
    await logErrorReport({
      domain: 'admin',
      kind: 'unexpected',
      operation: 'test.user',
      summary: 'Attributed failure',
      subject: { userId: '11111111-1111-1111-1111-111111111111' },
    })
    expect(insertedRow().user_id).toBe('11111111-1111-1111-1111-111111111111')
  })

  it('retries without user_id when the profile row does not exist (FK violation)', async () => {
    state.insertError = { message: 'violates foreign key constraint', code: '23503' }
    const id = await logSystemError({
      severity: 'error',
      category: 'admin',
      operation: 'test.fk',
      message: 'fk',
      userId: '22222222-2222-2222-2222-222222222222',
    })
    expect(id).toBe('new-row')
    expect(inserts()).toHaveLength(2)
    expect(insertedRow(1).user_id).toBeNull()
  })

  it('apiInternalError records the caller id and the caught error stack', async () => {
    const { apiInternalError } = await import('@/lib/errors/api-response')
    const cause = new Error('db down')
    cause.stack = stackWithFrames(3, 'Error: db down')
    await apiInternalError({
      cause,
      domain: 'admin',
      operation: 'admin.test',
      summary: 'Unhandled exception in admin.test',
      userId: '33333333-3333-3333-3333-333333333333',
    })
    expect(insertedRow().user_id).toBe('33333333-3333-3333-3333-333333333333')
    expect(String(insertedDetails().stack)).toContain('Error: db down')
  })
})

describe('C. ignore list', () => {
  beforeEach(() => {
    process.env.ALLOW_TEST_ADMIN_NOTIFICATIONS = 'true'
  })

  const critical = () =>
    logErrorReport({ domain: 'db', kind: 'db_unavailable', operation: 'test.critical', summary: 'Critical failure' })

  it('alerts on a critical incident that is not ignored', async () => {
    state.settings = { data: { value: ['some-other-fingerprint'] } }
    await critical()
    expect(inserts()).toHaveLength(1)
    expect(deliverOutOfBandAlert).toHaveBeenCalledTimes(1)
  })

  it('records an ignored fingerprint but never alerts', async () => {
    await critical()
    const fingerprint = insertedRow().fingerprint as string
    deliverOutOfBandAlert.mockClear()
    recording = createRecordingSupabase(respond)
    invalidateIgnoredFingerprintsCache()

    state.settings = { data: { value: [fingerprint] } }
    const id = await critical()
    expect(id).toBe('new-row')
    expect(inserts()).toHaveLength(1)
    expect(deliverOutOfBandAlert).not.toHaveBeenCalled()
  })

  it('fails open when the ignore list cannot be read', async () => {
    state.settings = { data: null, error: { message: 'settings unavailable' } }
    await critical()
    expect(deliverOutOfBandAlert).toHaveBeenCalledTimes(1)
  })

  it('caches the ignore list for 60 seconds', async () => {
    state.settings = { data: { value: [] } }
    await critical()
    state.latest = []
    await logErrorReport({ domain: 'db', kind: 'db_unavailable', operation: 'test.critical2', summary: 'Another' })
    const settingsReads = recording.calls.filter((q) => q.table === 'system_settings')
    expect(settingsReads).toHaveLength(1)
    expect(eqValue(settingsReads[0], 'key')).toBe('monitoring_ignored_fingerprints')
  })

  it('parseIgnoredFingerprints drops junk and caps at 500', () => {
    expect(parseIgnoredFingerprints('nope')).toEqual([])
    expect(parseIgnoredFingerprints(['a', 'a', '', 3, ' b '])).toEqual(['a', 'b'])
    const many = Array.from({ length: 700 }, (_, i) => `fp${i}`)
    expect(parseIgnoredFingerprints(many)).toHaveLength(MAX_IGNORED_FINGERPRINTS)
  })
})

describe('D. regression', () => {
  it('inserts a new row with regression = true when the latest row is resolved, even inside the window', async () => {
    const now = new Date().toISOString()
    state.latest = [{ id: 'old', status: 'resolved', occurrence_count: 4, updated_at: now, timestamp: now }]
    await logSystemError({ severity: 'error', category: 'admin', operation: 'test.reg', message: 'came back' })
    expect(updates()).toHaveLength(0)
    expect(inserts()).toHaveLength(1)
    expect(insertedRow().status).toBe('new')
    expect(insertedRow().occurrence_count).toBe(1)
    expect(insertedDetails().regression).toBe(true)
  })

  it('does not mark a first occurrence as a regression', async () => {
    await logSystemError({ severity: 'error', category: 'admin', operation: 'test.first', message: 'first' })
    expect(insertedDetails().regression).toBeUndefined()
  })
})

describe('E. dedup window from updated_at', () => {
  it('increments occurrence_count when the latest row was last seen inside 15 minutes, even if inserted long ago', async () => {
    const insertedLongAgo = new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString()
    const seenRecently = new Date(Date.now() - 5 * 60 * 1000).toISOString()
    state.latest = [{ id: 'row-1', status: 'acknowledged', occurrence_count: 7, updated_at: seenRecently, timestamp: insertedLongAgo }]

    const id = await logSystemError({ severity: 'error', category: 'admin', operation: 'test.dedup', message: 'again' })

    expect(id).toBe('row-1')
    expect(inserts()).toHaveLength(0)
    const update = updates()[0]
    expect(eqValue(update, 'id')).toBe('row-1')
    expect((update.payload as Record<string, unknown>).occurrence_count).toBe(8)
    expect(typeof (update.payload as Record<string, unknown>).updated_at).toBe('string')
  })

  it('inserts a new row when the latest row was last seen more than 15 minutes ago', async () => {
    const stale = new Date(Date.now() - DEDUP_WINDOW_MS - 60 * 1000).toISOString()
    state.latest = [{ id: 'row-1', status: 'new', occurrence_count: 3, updated_at: stale, timestamp: stale }]
    await logSystemError({ severity: 'error', category: 'admin', operation: 'test.dedup', message: 'later' })
    expect(updates()).toHaveLength(0)
    expect(inserts()).toHaveLength(1)
    expect(insertedRow().occurrence_count).toBe(1)
  })

  it('looks up the newest row by fingerprint without a timestamp window', async () => {
    await logSystemError({ severity: 'error', category: 'admin', operation: 'test.lookup', message: 'x' })
    const lookup = recording.calls.find((q) => q.table === 'system_errors' && q.op === 'select')!
    expect(lookup.columns).toContain('updated_at')
    expect(lookup.filters.some((f) => f.op === 'gte')).toBe(false)
    expect(lookup.order[0]).toEqual({ column: 'timestamp', ascending: false })
    expect(lookup.limit).toBe(1)
  })
})
