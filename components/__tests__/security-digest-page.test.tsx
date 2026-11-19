/**
 * @vitest-environment jsdom
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'

import { SupabaseFake } from '../../lib/__tests__/helpers/supabase-fake'
import { evaluateRules, buildSummary, overallSeverity } from '@/lib/admin/security-digest/rules'
import type { DayData } from '@/lib/admin/security-digest/types'

let fake: SupabaseFake
vi.mock('@/lib/supabase', () => ({ createServiceRoleClient: () => fake }))
vi.mock('@/lib/api/client', () => ({ apiPost: vi.fn() }))

async function renderPage(searchParams: { day?: string } = {}) {
  const { default: Page } = await import('../../app/admin/(console)/security/page')
  const element = await Page({ searchParams: Promise.resolve(searchParams) })
  const container = document.createElement('div')
  container.innerHTML = renderToStaticMarkup(element)
  return container
}

function sampleDigest(day: string) {
  const data: DayData = {
    day,
    timezone: 'Asia/Kolkata',
    events: [
      { day, event_type: 'admin_login_rate_limited', app: 'admin', ip_bucket: '198.51.100.7', subject_hash: 'abcdabcdabcdabcd', subject_hint: 'o***r@example.com', sample_path: null, count: 2, first_seen: null, last_seen: null },
      { day, event_type: 'origin_rejected', app: 'web', ip_bucket: '198.51.100.8', subject_hash: '', subject_hint: null, sample_path: null, count: 25, first_seen: null, last_seen: null },
    ],
    baseline: [],
    audit: [],
    errors: { total: 0, bySeverity: { critical: 0, error: 0, warning: 0 }, byCategory: { auth: 0, webhook: 0 }, newFingerprints: 0, regressions: 0 },
    signups: { count: 3, baselineDaily: [1, 1, 1, 1, 1, 1, 1] },
    missingTables: [],
    dataGaps: [],
  }
  const findings = evaluateRules(data)
  return {
    day,
    generated_at: '2026-11-19T19:30:00.000Z',
    severity: overallSeverity(findings),
    summary: buildSummary(data, findings),
    findings,
  }
}

describe('/admin/security page', () => {
  beforeEach(() => {
    fake = new SupabaseFake()
  })

  it('shows the not set up state with the migration name when the tables are missing', async () => {
    fake.forceError('security_digests', Object.assign(new Error('relation does not exist'), { code: '42P01' }))
    const page = await renderPage()
    expect(page.textContent).toContain('Security summary is not set up yet')
    expect(page.textContent).toContain('20261119000007_security_events.sql')
    expect(page.textContent).toContain('Generate now')
  })

  it('shows an empty history when no digest exists yet', async () => {
    const page = await renderPage()
    expect(page.textContent).toContain('No summaries yet')
  })

  it('renders the latest digest: badge, headline, findings with evidence, totals and history', async () => {
    fake.seed('security_digests', [sampleDigest('2026-11-18'), sampleDigest('2026-11-19')])
    const page = await renderPage()
    expect(page.querySelector('[data-testid="security-digest-headline"]')?.textContent).toBe(
      '1 high, 2 low findings: admin login attempts blocked, 25 cross-origin writes refused, 2 rate limit trips'
    )
    expect(page.textContent).toContain('Summary for 2026-11-19')
    expect(page.querySelector('[data-finding="admin_login_attack"]')?.textContent).toContain('198.51.100.7')
    expect(page.querySelector('[data-finding="admin_login_attack"]')?.textContent).toContain('o***r@example.com')
    expect(page.querySelector('tr[data-event="origin_rejected"]')?.textContent).toContain('25')
    // next/link is mocked to render its children, so the history is checked by its entries.
    const history = Array.from(page.querySelectorAll('[data-testid="security-digest-history"] li')).map((li) => li.textContent)
    expect(history).toEqual(['2026-11-19High', '2026-11-18High'])
    expect(page.textContent).not.toContain('owner@example.com')
  })

  it('opens the requested day from the query string', async () => {
    fake.seed('security_digests', [sampleDigest('2026-11-18'), sampleDigest('2026-11-19')])
    const page = await renderPage({ day: '2026-11-18' })
    expect(page.textContent).toContain('Summary for 2026-11-18')
    expect(page.textContent).not.toContain('Summary for 2026-11-19')
  })
})
