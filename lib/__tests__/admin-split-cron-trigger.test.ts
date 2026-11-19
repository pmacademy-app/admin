import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

/**
 * Admin split: the admin app does not host /api/cron/*. Run-now calls the learner site's cron
 * route server to server with the CRON_SECRET bearer.
 */

describe('triggerLearnerCron', () => {
  const fetchMock = vi.fn()
  const realFetch = global.fetch
  const savedSecret = process.env.CRON_SECRET

  beforeEach(() => {
    fetchMock.mockReset()
    global.fetch = fetchMock as unknown as typeof fetch
    process.env.LEARNER_SITE_URL = 'https://learner.example.com'
    process.env.CRON_SECRET = 'cron-secret-for-tests'
  })

  afterEach(() => {
    global.fetch = realFetch
    delete process.env.LEARNER_SITE_URL
    process.env.CRON_SECRET = savedSecret
  })

  it('runs cleanup as a dry run unless deleting is explicitly requested', async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ ok: true }), { status: 200 }))
    const { triggerLearnerCron } = await import('@/lib/admin/cron-trigger')

    await triggerLearnerCron('cleanup')
    expect(JSON.parse(String((fetchMock.mock.calls[0] as [string, RequestInit])[1].body))).toEqual({ dryRun: true })

    await triggerLearnerCron('cleanup', { deleteRows: true })
    expect(JSON.parse(String((fetchMock.mock.calls[1] as [string, RequestInit])[1].body))).toEqual({ dryRun: false })

    await triggerLearnerCron('weekly-recap')
    expect(JSON.parse(String((fetchMock.mock.calls[2] as [string, RequestInit])[1].body))).toEqual({})
  })

  it('POSTs the learner cron route with the bearer secret', async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ processed: 3 }), { status: 200 }))
    const { triggerLearnerCron } = await import('@/lib/admin/cron-trigger')

    const result = await triggerLearnerCron('process-email-queue')

    expect(result).toEqual({ ok: true, status: 200, body: { processed: 3 } })
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(url).toBe('https://learner.example.com/api/cron/process-email-queue')
    expect(init.method).toBe('POST')
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer cron-secret-for-tests')
  })

  it('refuses a job that is not on the allowlist without calling out', async () => {
    const { triggerLearnerCron } = await import('@/lib/admin/cron-trigger')
    expect(await triggerLearnerCron('../internal/revalidate')).toEqual({ ok: false, reason: 'unknown_job' })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('does nothing when CRON_SECRET or LEARNER_SITE_URL is missing', async () => {
    const { triggerLearnerCron } = await import('@/lib/admin/cron-trigger')
    delete process.env.CRON_SECRET
    expect(await triggerLearnerCron('cleanup')).toEqual({ ok: false, reason: 'not_configured' })
    process.env.CRON_SECRET = 'x'
    delete process.env.LEARNER_SITE_URL
    expect(await triggerLearnerCron('cleanup')).toEqual({ ok: false, reason: 'not_configured' })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('reports a learner refusal and a network failure without throwing', async () => {
    const { triggerLearnerCron } = await import('@/lib/admin/cron-trigger')
    fetchMock.mockResolvedValueOnce(new Response('{"error":"no"}', { status: 401 }))
    expect(await triggerLearnerCron('weekly-recap')).toMatchObject({ ok: false, reason: 'rejected', status: 401 })
    fetchMock.mockRejectedValueOnce(new TypeError('fetch failed'))
    expect(await triggerLearnerCron('weekly-recap')).toEqual({ ok: false, reason: 'request_failed' })
  })

  it('the run-now route is admin only', async () => {
    const { NextRequest } = await import('next/server')
    const { POST } = await import('../../app/api/admin/system/cron/[name]/route')
    const res = await POST(new NextRequest('http://localhost:3000/api/admin/system/cron/cleanup', { method: 'POST' }), {
      params: Promise.resolve({ name: 'cleanup' }),
    })
    expect([401, 403]).toContain(res.status)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('the admin repo hosts no cron, webhook, send-email hook or unsubscribe route', async () => {
    const fs = await import('node:fs')
    const path = await import('node:path')
    const root = path.resolve(import.meta.dirname, '../..')
    for (const p of ['app/api/cron', 'app/api/email', 'app/api/auth/send-email-hook']) {
      expect(fs.existsSync(path.join(root, p))).toBe(false)
    }
  })
})
