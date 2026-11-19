import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

/**
 * Admin split: learner caches are purged through POST ${LEARNER_SITE_URL}/api/internal/revalidate
 * with the INTERNAL_REVALIDATE_SECRET bearer. Best effort: it never throws and is a no-op when
 * either env var is missing.
 */

const SECRET = 'test-internal-secret-value'

describe('revalidateLearner', () => {
  const fetchMock = vi.fn()
  const realFetch = global.fetch

  beforeEach(() => {
    vi.resetModules()
    fetchMock.mockReset()
    global.fetch = fetchMock as unknown as typeof fetch
    process.env.LEARNER_SITE_URL = 'https://learner.example.com/'
    process.env.INTERNAL_REVALIDATE_SECRET = SECRET
  })

  afterEach(() => {
    global.fetch = realFetch
    delete process.env.LEARNER_SITE_URL
    delete process.env.INTERNAL_REVALIDATE_SECRET
  })

  it('posts the tags and paths with the bearer secret', async () => {
    fetchMock.mockResolvedValue(new Response('{}', { status: 200 }))
    const { revalidateLearner } = await import('@/lib/learner-revalidate')

    const result = await revalidateLearner({
      tags: [{ tag: 'leaderboard', expire: 0 }, { tag: 'system_settings' }],
      paths: ['/dashboard', '/p/alice', '/dashboard'],
    })

    expect(result).toBe('sent')
    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(url).toBe('https://learner.example.com/api/internal/revalidate')
    expect(init.method).toBe('POST')
    expect((init.headers as Record<string, string>).Authorization).toBe(`Bearer ${SECRET}`)
    expect((init.headers as Record<string, string>)['Content-Type']).toBe('application/json')
    expect(init.signal).toBeInstanceOf(AbortSignal)
    expect(JSON.parse(String(init.body))).toEqual({
      tags: [{ tag: 'leaderboard', expire: 0 }, { tag: 'system_settings' }],
      paths: ['/dashboard', '/p/alice'],
    })
  })

  it('is a no-op when LEARNER_SITE_URL is missing', async () => {
    delete process.env.LEARNER_SITE_URL
    const { revalidateLearner } = await import('@/lib/learner-revalidate')
    expect(await revalidateLearner({ paths: ['/dashboard'] })).toBe('skipped')
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('is a no-op when INTERNAL_REVALIDATE_SECRET is missing', async () => {
    delete process.env.INTERNAL_REVALIDATE_SECRET
    const { revalidateLearner } = await import('@/lib/learner-revalidate')
    expect(await revalidateLearner({ tags: [{ tag: 'badges' }] })).toBe('skipped')
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('skips an empty request', async () => {
    const { revalidateLearner } = await import('@/lib/learner-revalidate')
    expect(await revalidateLearner({})).toBe('skipped')
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('never throws on a network error and never logs the secret', async () => {
    fetchMock.mockRejectedValue(new TypeError('fetch failed'))
    const spies = (['warn', 'info', 'log', 'error'] as const).map((m) =>
      vi.spyOn(console, m).mockImplementation(() => {})
    )
    const { revalidateLearner } = await import('@/lib/learner-revalidate')

    await expect(revalidateLearner({ paths: ['/dashboard'] })).resolves.toBe('failed')
    const logged = JSON.stringify(spies.flatMap((s) => s.mock.calls))
    expect(logged).not.toContain(SECRET)
    spies.forEach((s) => s.mockRestore())
  })

  it('reports a rejected request as failed without throwing', async () => {
    fetchMock.mockResolvedValue(new Response('nope', { status: 401 }))
    const { revalidateLearner } = await import('@/lib/learner-revalidate')
    await expect(revalidateLearner({ paths: ['/dashboard'] })).resolves.toBe('failed')
  })

  it('routes the portfolio and OG card helpers through the learner endpoint', async () => {
    fetchMock.mockResolvedValue(new Response('{}', { status: 200 }))
    const { revalidatePublicPortfolio } = await import('@/lib/portfolio-revalidate')
    const { revalidatePortfolioOgCard } = await import('@/lib/og/revalidate-capstone-cards')

    await revalidatePublicPortfolio(' Alice ', ['m1'])
    await revalidatePortfolioOgCard('Alice')

    const bodies = fetchMock.mock.calls.map((c) => JSON.parse(String((c[1] as RequestInit).body)))
    expect(bodies[0]).toEqual({ paths: ['/p/alice', '/p/alice/capstones/m1'] })
    expect(bodies[1]).toEqual({ paths: ['/api/og/portfolio/alice', '/api/og/portfolio/Alice'] })
  })

  it('asks the learner site to expire the leaderboard tag', async () => {
    fetchMock.mockResolvedValue(new Response('{}', { status: 200 }))
    const { invalidateLeaderboardCache } = await import('@/lib/leaderboard-db')
    await invalidateLeaderboardCache({ expire: 0 })
    const body = JSON.parse(String((fetchMock.mock.calls[0][1] as RequestInit).body))
    expect(body).toEqual({ tags: [{ tag: 'leaderboard', expire: 0 }] })
  })

  it('leaves no direct revalidatePath call for a learner page in admin code', async () => {
    const fs = await import('node:fs')
    const path = await import('node:path')
    const root = path.resolve(import.meta.dirname, '../..')
    const offenders: string[] = []
    const walk = (dir: string) => {
      for (const entry of fs.readdirSync(path.join(root, dir), { withFileTypes: true })) {
        const rel = path.posix.join(dir, entry.name)
        if (entry.isDirectory()) {
          if (rel !== 'lib/__tests__') walk(rel)
        } else if (/\.(ts|tsx)$/.test(entry.name)) {
          const src = fs.readFileSync(path.join(root, rel), 'utf8')
          for (const m of src.matchAll(/revalidatePath\(\s*[`'"]([^`'"]+)/g)) {
            if (!m[1].startsWith('/admin')) offenders.push(`${rel}: ${m[1]}`)
          }
        }
      }
    }
    for (const dir of ['app', 'lib', 'components']) walk(dir)
    expect(offenders).toEqual([])
  })
})
