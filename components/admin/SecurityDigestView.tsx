import React from 'react'
import Link from 'next/link'
import { AlertTriangle, Database, History, ListChecks, Network, ShieldCheck, UserX } from 'lucide-react'
import { AdminEmptyState } from '@/components/admin/AdminEmptyState'
import { AdminSection } from '@/components/admin/AdminSection'
import { AdminStatusBadge } from '@/components/admin/AdminStatusBadge'
import type { DigestPageData } from '@/lib/admin/security-digest/read'
import {
  SECURITY_EVENTS_MIGRATION,
  type CountEntry,
  type DigestSeverity,
  type Finding,
  type SecurityDigestRow,
} from '@/lib/admin/security-digest/types'
import { cn } from '@/lib/utils'

const SEVERITY_BADGE: Record<DigestSeverity, { status: string; label: string }> = {
  high: { status: 'danger', label: 'High' },
  medium: { status: 'warning', label: 'Medium' },
  low: { status: 'info', label: 'Low' },
  none: { status: 'success', label: 'No findings' },
}

export function SecuritySeverityBadge({ severity }: { severity: DigestSeverity }) {
  const badge = SEVERITY_BADGE[severity] ?? SEVERITY_BADGE.none
  return <AdminStatusBadge status={badge.status} label={badge.label} data-severity={severity} />
}

function formatChange(changePct: number | null): string {
  if (changePct === null) return 'new'
  if (changePct === 0) return 'flat'
  return `${changePct > 0 ? '+' : ''}${changePct}%`
}

function CountTable({ title, rows, empty }: { title: string; rows: CountEntry[]; empty: string }) {
  return (
    <div className="space-y-1.5">
      <p className="text-[11px] font-semibold uppercase tracking-wider text-admin-fg-muted">{title}</p>
      {rows.length === 0 ? (
        <p className="text-xs text-admin-fg-subtle">{empty}</p>
      ) : (
        <table className="w-full text-xs">
          <tbody>
            {rows.map((row) => (
              <tr key={row.label} className="border-t border-admin-border first:border-t-0">
                <td className="py-1 pr-3 font-mono text-admin-fg break-all">{row.label}</td>
                <td className="py-1 text-right tabular-nums text-admin-fg-muted">{row.count}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  )
}

function FindingCard({ finding }: { finding: Finding }) {
  const counts = Object.entries(finding.evidence.counts)
  return (
    <article
      data-finding={finding.id}
      className="rounded-xl border border-admin-border bg-admin-bg/60 p-4 space-y-3"
    >
      <header className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="text-sm font-bold text-admin-fg">{finding.title}</h3>
        <SecuritySeverityBadge severity={finding.severity} />
      </header>
      <p className="text-xs text-admin-fg-muted">{finding.detail}</p>
      {counts.length > 0 && (
        <dl className="grid grid-cols-2 gap-2 sm:grid-cols-4">
          {counts.map(([key, value]) => (
            <div key={key} className="rounded-lg border border-admin-border bg-admin-surface px-2.5 py-1.5">
              <dt className="truncate font-mono text-[10px] text-admin-fg-subtle">{key}</dt>
              <dd className="text-sm font-bold tabular-nums text-admin-fg">{value}</dd>
            </div>
          ))}
        </dl>
      )}
      {(finding.evidence.topIpBuckets.length > 0 || finding.evidence.maskedSubjects.length > 0) && (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          {finding.evidence.topIpBuckets.length > 0 && (
            <CountTable title="Networks" rows={finding.evidence.topIpBuckets} empty="None" />
          )}
          {finding.evidence.maskedSubjects.length > 0 && (
            <CountTable title="Accounts (masked)" rows={finding.evidence.maskedSubjects} empty="None" />
          )}
        </div>
      )}
      {finding.evidence.items && finding.evidence.items.length > 0 && (
        <ul className="list-disc space-y-0.5 pl-5 text-xs text-admin-fg-muted">
          {finding.evidence.items.map((item) => (
            <li key={item} className="break-all">
              {item}
            </li>
          ))}
        </ul>
      )}
    </article>
  )
}

function DigestDetail({ digest }: { digest: SecurityDigestRow }) {
  const { summary, findings } = digest
  const totals = summary.totals.filter((t) => t.count > 0 || t.avg7 > 0)
  return (
    <div className="space-y-6">
      <AdminSection
        title={`Summary for ${digest.day}`}
        icon={ShieldCheck}
        meta={`Generated ${digest.generated_at.replace('T', ' ').slice(0, 16)} UTC`}
      >
        <div className="flex flex-wrap items-center gap-3">
          <SecuritySeverityBadge severity={digest.severity} />
          <p data-testid="security-digest-headline" className="text-sm font-medium text-admin-fg">
            {summary.headline}
          </p>
        </div>
        <dl className="grid grid-cols-2 gap-3 sm:grid-cols-4 text-xs">
          <div className="rounded-lg border border-admin-border bg-admin-bg/60 p-3">
            <dt className="text-admin-fg-muted">New signups</dt>
            <dd className="text-lg font-bold tabular-nums text-admin-fg">{summary.signups.count}</dd>
            <dd className="text-[11px] text-admin-fg-subtle">
              avg {summary.signups.avg7}, {formatChange(summary.signups.changePct)}
            </dd>
          </div>
          <div className="rounded-lg border border-admin-border bg-admin-bg/60 p-3">
            <dt className="text-admin-fg-muted">System errors</dt>
            <dd className="text-lg font-bold tabular-nums text-admin-fg">{summary.errors.total}</dd>
            <dd className="text-[11px] text-admin-fg-subtle">{summary.errors.bySeverity.critical} critical</dd>
          </div>
          <div className="rounded-lg border border-admin-border bg-admin-bg/60 p-3">
            <dt className="text-admin-fg-muted">New error groups</dt>
            <dd className="text-lg font-bold tabular-nums text-admin-fg">{summary.errors.newFingerprints}</dd>
            <dd className="text-[11px] text-admin-fg-subtle">{summary.errors.regressions} regressions</dd>
          </div>
          <div className="rounded-lg border border-admin-border bg-admin-bg/60 p-3">
            <dt className="text-admin-fg-muted">Auth / webhook errors</dt>
            <dd className="text-lg font-bold tabular-nums text-admin-fg">
              {summary.errors.byCategory.auth} / {summary.errors.byCategory.webhook}
            </dd>
          </div>
        </dl>
        {summary.dataGaps.length > 0 && (
          <p className="text-xs text-admin-warning">
            Incomplete data: {summary.dataGaps.join(', ')} could not be read when this summary was built.
          </p>
        )}
      </AdminSection>

      <AdminSection title="Findings" icon={AlertTriangle} meta={`${findings.length} total`}>
        {findings.length === 0 ? (
          <p className="text-sm text-admin-fg-muted">No rule fired for this day.</p>
        ) : (
          <div className="space-y-3">
            {findings.map((f) => (
              <FindingCard key={f.id} finding={f} />
            ))}
          </div>
        )}
      </AdminSection>

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
        <AdminSection title="Top networks by failures" icon={Network}>
          <CountTable title="IP bucket" rows={summary.topIpBuckets} empty="No failures recorded." />
        </AdminSection>
        <AdminSection title="Top targeted accounts" icon={UserX}>
          <CountTable title="Account (masked)" rows={summary.topAccounts} empty="No targeted accounts." />
        </AdminSection>
      </div>

      <AdminSection title="Event totals" icon={ListChecks} meta="Compared with the 7-day average">
        {totals.length === 0 ? (
          <p className="text-sm text-admin-fg-muted">No security events recorded for this day or the week before.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead>
                <tr className="text-left text-admin-fg-muted">
                  <th className="py-1.5 pr-3 font-semibold">Event</th>
                  <th className="py-1.5 pr-3 text-right font-semibold">Count</th>
                  <th className="py-1.5 pr-3 text-right font-semibold">7-day avg</th>
                  <th className="py-1.5 text-right font-semibold">Change</th>
                </tr>
              </thead>
              <tbody>
                {totals.map((t) => (
                  <tr key={t.type} data-event={t.type} className="border-t border-admin-border">
                    <td className="py-1.5 pr-3 font-mono text-admin-fg">{t.type}</td>
                    <td className="py-1.5 pr-3 text-right tabular-nums text-admin-fg">{t.count}</td>
                    <td className="py-1.5 pr-3 text-right tabular-nums text-admin-fg-muted">{t.avg7}</td>
                    <td
                      className={cn(
                        'py-1.5 text-right tabular-nums',
                        t.changePct === null || t.changePct > 100 ? 'text-admin-danger' : 'text-admin-fg-muted'
                      )}
                    >
                      {formatChange(t.changePct)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </AdminSection>
    </div>
  )
}

function History30({ data, selectedDay }: { data: Extract<DigestPageData, { status: 'ok' }>; selectedDay: string | null }) {
  return (
    <AdminSection title="Last 30 summaries" icon={History}>
      {data.history.length === 0 ? (
        <p className="text-xs text-admin-fg-muted">None yet.</p>
      ) : (
        <ul data-testid="security-digest-history" className="space-y-1">
          {data.history.map((item) => (
            <li key={item.day}>
              <Link
                href={`/admin/security?day=${item.day}`}
                aria-current={item.day === selectedDay ? 'page' : undefined}
                className={cn(
                  'flex items-center justify-between gap-2 rounded-lg px-2.5 py-1.5 text-xs transition-colors',
                  item.day === selectedDay
                    ? 'bg-admin-accent-soft text-admin-accent font-semibold'
                    : 'text-admin-fg hover:bg-admin-surface-raised'
                )}
              >
                <span className="font-mono">{item.day}</span>
                <SecuritySeverityBadge severity={item.severity} />
              </Link>
            </li>
          ))}
        </ul>
      )}
    </AdminSection>
  )
}

/**
 * Body of /admin/security: the not-set-up state, an error state, or the selected
 * digest beside the 30-day history.
 */
export function SecurityDigestView({ data, requestedDay }: { data: DigestPageData; requestedDay: string | null }) {
  if (data.status === 'not_set_up') {
    return (
      <AdminEmptyState
        icon={Database}
        title="Security summary is not set up yet"
        description={`The security tables do not exist in the database yet. Apply the migration ${SECURITY_EVENTS_MIGRATION} from the web repo, then generate a summary.`}
      />
    )
  }
  if (data.status === 'error') {
    return (
      <AdminEmptyState
        icon={AlertTriangle}
        title="Security summaries could not be loaded"
        description="The database did not answer. Reload the page in a moment."
      />
    )
  }

  const selectedDay = data.selected?.day ?? requestedDay
  return (
    <div className="grid grid-cols-1 gap-6 xl:grid-cols-[minmax(0,1fr)_16rem]">
      <div className="min-w-0">
        {data.selected ? (
          <DigestDetail digest={data.selected} />
        ) : (
          <AdminEmptyState
            icon={ShieldCheck}
            title={requestedDay ? `No summary for ${requestedDay}` : 'No summaries yet'}
            description="The nightly job writes one summary per day at 01:00 IST. Use Generate now to build one."
          />
        )}
      </div>
      <History30 data={data} selectedDay={selectedDay} />
    </div>
  )
}
