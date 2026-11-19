'use client'

import React from 'react'
import Link from 'next/link'
import { RotateCcw } from 'lucide-react'

/**
 * Full diagnostic context of one `system_errors` row: the stack, the well-known
 * fields of contract A (path, requestId, digest, release, app, runtime, source), the
 * user it is attributed to, a regression badge, and whatever else is in `details`.
 *
 * Every value was redacted by the logger before it was written, so this renders it
 * as text and never as HTML. Shared by the error drawer and the alert list.
 */

/** Fields shown in the grid; anything else in `details` goes to the raw JSON block. */
const KNOWN_FIELDS: Array<{ key: string; label: string }> = [
  { key: 'path', label: 'Path' },
  { key: 'requestId', label: 'Request ID' },
  { key: 'digest', label: 'Digest' },
  { key: 'release', label: 'Release' },
  { key: 'app', label: 'App' },
  { key: 'runtime', label: 'Runtime' },
  { key: 'source', label: 'Source' },
]

const HIDDEN_FROM_REST = new Set(['stack', 'regression', ...KNOWN_FIELDS.map((f) => f.key)])

function asText(value: unknown): string | null {
  if (typeof value === 'string') return value || null
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  return null
}

/** Basic UUID shape, so only a real id becomes a link. */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export function AdminRegressionBadge() {
  return (
    <span
      className="inline-flex items-center gap-1 px-2 py-0.5 rounded bg-admin-danger-soft text-admin-danger text-[10px] font-bold uppercase tracking-wider"
      title="This error came back after it was resolved"
    >
      <RotateCcw className="w-3 h-3" aria-hidden="true" />
      Regression
    </span>
  )
}

export function AdminIgnoredBadge() {
  return (
    <span
      className="inline-flex items-center px-2 py-0.5 rounded border border-admin-border bg-admin-surface-raised text-admin-fg-muted text-[10px] font-bold uppercase tracking-wider"
      title="On the monitoring ignore list: recorded, never alerts"
    >
      Ignored
    </span>
  )
}

export function AdminIncidentDetails({
  details,
  userId,
}: {
  details: Record<string, unknown> | null | undefined
  userId?: string | null
}) {
  const data = details ?? {}
  const stack = asText(data.stack)
  const regression = data.regression === true || data.regression === 'true'
  const fields = KNOWN_FIELDS.map((field) => ({ ...field, value: asText(data[field.key]) })).filter(
    (field): field is { key: string; label: string; value: string } => field.value !== null
  )
  const rest = Object.fromEntries(Object.entries(data).filter(([key]) => !HIDDEN_FROM_REST.has(key)))
  const hasRest = Object.keys(rest).length > 0

  return (
    <div className="space-y-3" data-testid="incident-details">
      {regression && (
        <div>
          <AdminRegressionBadge />
        </div>
      )}

      {(fields.length > 0 || userId) && (
        <dl className="grid grid-cols-1 sm:grid-cols-2 gap-2">
          {fields.map((field) => (
            <div key={field.key} className="p-2.5 rounded-lg bg-admin-surface-raised border border-admin-border min-w-0">
              <dt className="text-[10px] font-bold text-admin-fg-subtle uppercase tracking-wider">{field.label}</dt>
              <dd className="mt-0.5 font-mono text-[11px] text-admin-fg break-all">{field.value}</dd>
            </div>
          ))}
          {userId && (
            <div className="p-2.5 rounded-lg bg-admin-surface-raised border border-admin-border min-w-0">
              <dt className="text-[10px] font-bold text-admin-fg-subtle uppercase tracking-wider">User</dt>
              <dd className="mt-0.5 font-mono text-[11px] break-all">
                {UUID.test(userId) ? (
                  <Link href={`/admin/users/${userId}`} className="text-admin-accent hover:underline">
                    {userId}
                  </Link>
                ) : (
                  <span className="text-admin-fg">{userId}</span>
                )}
              </dd>
            </div>
          )}
        </dl>
      )}

      {stack && (
        <div>
          <p className="text-[10px] font-bold text-admin-fg-subtle uppercase tracking-wider mb-1">Stack</p>
          <pre
            className="max-h-72 overflow-auto rounded-lg border border-admin-border bg-admin-bg p-3 font-mono text-[11px] leading-relaxed text-admin-fg whitespace-pre"
            tabIndex={0}
            aria-label="Stack trace"
          >
            {stack}
          </pre>
        </div>
      )}

      {hasRest && (
        <div>
          <p className="text-[10px] font-bold text-admin-fg-subtle uppercase tracking-wider mb-1">Other details</p>
          <pre
            className="max-h-60 overflow-auto rounded-lg border border-admin-border bg-admin-bg p-3 font-mono text-[11px] leading-relaxed text-admin-fg-muted whitespace-pre-wrap break-all"
            tabIndex={0}
            aria-label="Other details"
          >
            {JSON.stringify(rest, null, 2)}
          </pre>
        </div>
      )}

      {!stack && fields.length === 0 && !userId && !hasRest && (
        <p className="text-[11px] text-admin-fg-muted">No further details were recorded for this error.</p>
      )}
    </div>
  )
}
