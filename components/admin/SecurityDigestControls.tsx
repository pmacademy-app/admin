'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { CalendarSearch, RefreshCw } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { apiPost } from '@/lib/api/client'

export const SECURITY_DIGEST_GENERATE_PATH = '/api/admin/security/digest'

interface GenerateResponse {
  success: boolean
  result?:
    | { status: 'not_set_up'; day: string; migration: string }
    | { status: 'ok'; day: string; severity: string; findings: number; webhook: string }
  error?: string
}

const WEBHOOK_COPY: Record<string, string> = {
  sent: 'alert sent',
  not_configured: 'no alert webhook configured',
  failed: 'alert delivery failed',
  skipped_no_findings: 'no alert needed',
  skipped_already_sent: 'alert was already sent for this day',
}

/**
 * Day picker and "Generate now" for the security summary page. Viewing a day only
 * changes the URL; generating calls the admin-only route, then refreshes the page.
 */
export function SecurityDigestControls({ defaultDay, maxDay }: { defaultDay: string; maxDay: string }) {
  const router = useRouter()
  const [day, setDay] = useState(defaultDay)
  const [force, setForce] = useState(false)
  const [loading, setLoading] = useState(false)
  const [message, setMessage] = useState<{ tone: 'ok' | 'error'; text: string } | null>(null)

  const generate = async () => {
    setLoading(true)
    setMessage(null)
    try {
      const res = await apiPost<GenerateResponse>(SECURITY_DIGEST_GENERATE_PATH, { day, force })
      if (!res.ok || !res.data.success || !res.data.result) {
        setMessage({ tone: 'error', text: !res.ok ? res.error.message : res.data.error || 'Could not generate the summary.' })
        return
      }
      const result = res.data.result
      if (result.status === 'not_set_up') {
        setMessage({ tone: 'error', text: `Not set up yet: apply ${result.migration} first.` })
        return
      }
      setMessage({
        tone: 'ok',
        text: `Summary for ${result.day} saved: ${result.findings} findings, ${WEBHOOK_COPY[result.webhook] ?? result.webhook}.`,
      })
      router.push(`/admin/security?day=${result.day}`)
      router.refresh()
    } catch {
      setMessage({ tone: 'error', text: 'Network error while generating the summary.' })
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="flex flex-col items-start gap-2 md:items-end">
      <div className="flex flex-wrap items-center gap-2">
        <label className="sr-only" htmlFor="security-digest-day">
          Day
        </label>
        <input
          id="security-digest-day"
          type="date"
          value={day}
          max={maxDay}
          onChange={(e) => setDay(e.target.value)}
          className="h-8 rounded-lg border border-admin-border bg-admin-surface px-2 text-xs text-admin-fg"
        />
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={!day}
          onClick={() => router.push(`/admin/security?day=${day}`)}
          className="border-admin-border bg-admin-surface text-admin-fg hover:bg-admin-surface-raised"
        >
          <CalendarSearch aria-hidden="true" />
          View
        </Button>
        <Button type="button" variant="admin" size="sm" loading={loading} disabled={!day} onClick={generate}>
          {!loading && <RefreshCw aria-hidden="true" />}
          Generate now
        </Button>
      </div>
      <label className="flex items-center gap-1.5 text-[11px] text-admin-fg-muted">
        <input type="checkbox" checked={force} onChange={(e) => setForce(e.target.checked)} />
        Resend the alert even if it already went out for this day
      </label>
      <div aria-live="polite">
        {message && (
          <p
            data-testid="security-digest-message"
            className={`text-[11px] ${message.tone === 'ok' ? 'text-admin-success' : 'text-admin-danger'}`}
          >
            {message.text}
          </p>
        )}
      </div>
    </div>
  )
}
