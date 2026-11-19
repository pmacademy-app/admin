'use client'

import React, { useState } from 'react'
import { AdminDrawer } from './AdminDrawer'
import { AdminDetailItem } from './AdminDetailItem'
import { AdminErrorSeverityBadge, AdminErrorStatusBadge } from './AdminErrorBadges'
import { AdminIgnoredBadge, AdminIncidentDetails, AdminRegressionBadge } from './AdminIncidentDetails'
import { CheckCircle2, AlertCircle, Loader2, EyeOff, Eye } from 'lucide-react'
import { apiPatch, apiPost } from '@/lib/api/client'
import { useApiQuery } from '@/lib/api/hooks'
import type { AdminErrorGroup, AdminErrorIncident } from '@/lib/admin/types'

interface AdminErrorDetailDrawerProps {
  group: AdminErrorGroup | null
  open: boolean
  onOpenChange: (open: boolean) => void
  onStatusChange?: (fingerprint: string, status: 'acknowledged' | 'resolved') => void
  /** Called after the group was added to or removed from the ignore list. */
  onIgnoreChange?: (fingerprint: string, ignored: boolean) => void
}

interface LatestIncidentResponse {
  success: boolean
  incident: AdminErrorIncident | null
  error?: string
}

/**
 * Error detail drawer (spec §7.5): full message, severity, lifecycle status, area,
 * occurrence counts, grouping fingerprint, the newest row's full details (stack,
 * path, request id, digest, release, app, runtime, source, user, regression) and the
 * status and ignore actions.
 */
export function AdminErrorDetailDrawer({
  group,
  open,
  onOpenChange,
  onStatusChange,
  onIgnoreChange,
}: AdminErrorDetailDrawerProps) {
  const [updating, setUpdating] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  const latestKey =
    open && group ? `/api/admin/system/errors/latest?fingerprint=${encodeURIComponent(group.fingerprint)}` : null
  const { data: latest, error: latestError, isLoading: latestLoading } = useApiQuery<LatestIncidentResponse>(
    latestKey,
    { revalidateOnFocus: false }
  )
  const incident = latest?.success ? latest.incident : null

  const handleUpdateStatus = async (newStatus: 'acknowledged' | 'resolved') => {
    if (!group) return
    setUpdating(newStatus)
    setError(null)
    try {
      const result = await apiPatch<{ success?: boolean; error?: string }>(
        '/api/admin/system/errors',
        { fingerprint: group.fingerprint, newStatus }
      )
      if (result.ok && result.data.success) {
        onStatusChange?.(group.fingerprint, newStatus)
        onOpenChange(false)
      } else {
        const errorMsg = !result.ok ? result.error.message : (result.data.error || 'Failed to update status.')
        setError(errorMsg)
      }
    } catch {
      setError('Network error while updating error status.')
    } finally {
      setUpdating(null)
    }
  }

  const handleIgnore = async (ignored: boolean) => {
    if (!group) return
    setUpdating(ignored ? 'ignore' : 'unignore')
    setError(null)
    try {
      const result = await apiPost<{ success?: boolean; error?: string }>('/api/admin/system/errors/ignore', {
        fingerprint: group.fingerprint,
        ignored,
      })
      if (result.ok && result.data.success) {
        onIgnoreChange?.(group.fingerprint, ignored)
        onOpenChange(false)
      } else {
        setError(!result.ok ? result.error.message : (result.data.error || 'Failed to update the ignore list.'))
      }
    } catch {
      setError('Network error while updating the ignore list.')
    } finally {
      setUpdating(null)
    }
  }

  return (
    <AdminDrawer
      open={open}
      onOpenChange={onOpenChange}
      title="Error Details"
      description={group?.operation}
      size="md"
    >
      {group ? (
        <div className="space-y-5">
          {error && (
            <div className="p-3 rounded-lg bg-red-500/10 border border-red-500/30 text-danger text-xs flex items-center gap-2">
              <AlertCircle className="w-4 h-4 shrink-0" />
              <span>{error}</span>
            </div>
          )}

          {(group.ignored || group.regression) && (
            <div className="flex flex-wrap items-center gap-2">
              {group.regression && <AdminRegressionBadge />}
              {group.ignored && <AdminIgnoredBadge />}
            </div>
          )}

          <div className="p-4 rounded-xl bg-admin-bg/60 border border-admin-border">
            <p className="text-[10px] font-bold text-admin-fg-subtle uppercase tracking-wider mb-1.5">Message</p>
            <p className="text-xs font-mono text-admin-fg break-all">{group.message}</p>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <AdminDetailItem label="Severity" value={<AdminErrorSeverityBadge severity={group.severity} />} />
            <AdminDetailItem label="Status" value={<AdminErrorStatusBadge status={group.status} />} />
            <AdminDetailItem
              label="Area"
              value={
                <span className="px-2 py-0.5 rounded bg-admin-surface-raised text-admin-fg-muted text-[10px] font-mono uppercase">
                  {group.category}
                </span>
              }
            />
            <AdminDetailItem label="Occurrences" value={<span className="font-mono text-sm font-semibold text-admin-fg">{group.occurrences}</span>} />
            <AdminDetailItem label="First Seen" value={<span className="font-mono text-[11px] text-admin-fg-muted">{new Date(group.firstSeen).toLocaleString()}</span>} />
            <AdminDetailItem label="Last Seen" value={<span className="font-mono text-[11px] text-admin-fg-muted">{new Date(group.lastSeen).toLocaleString()}</span>} />
          </div>

          <div className="p-3 rounded-lg bg-admin-surface-raised border border-admin-border">
            <p className="text-[10px] font-bold text-admin-fg-subtle uppercase tracking-wider mb-1">Fingerprint</p>
            <p className="font-mono text-[11px] text-admin-fg-muted break-all">{group.fingerprint}</p>
          </div>

          <section aria-label="Latest occurrence details" className="space-y-2">
            <p className="text-[10px] font-bold text-admin-fg-subtle uppercase tracking-wider">Latest occurrence</p>
            {latestLoading ? (
              <div className="h-24 rounded-lg bg-admin-surface-raised border border-admin-border animate-pulse" aria-busy="true" />
            ) : latestError || (latest && !latest.success) ? (
              <p className="text-[11px] text-danger">
                The details of the latest occurrence could not be loaded.
              </p>
            ) : incident ? (
              <AdminIncidentDetails details={incident.details} userId={incident.userId} />
            ) : (
              <p className="text-[11px] text-admin-fg-muted">No occurrence rows were found for this group.</p>
            )}
          </section>

          {/* Action buttons */}
          <div className="pt-4 border-t border-admin-border flex flex-wrap items-center gap-3">
            {group.status !== 'acknowledged' && group.status !== 'resolved' && (
              <button
                type="button"
                disabled={updating !== null}
                onClick={() => void handleUpdateStatus('acknowledged')}
                className="flex-1 py-2 px-3 text-xs font-semibold rounded-xl border border-amber-500/30 bg-amber-500/10 hover:bg-amber-500/20 text-warning transition-colors flex items-center justify-center gap-2 cursor-pointer disabled:opacity-50"
              >
                {updating === 'acknowledged' ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : null}
                <span>Acknowledge</span>
              </button>
            )}
            {group.status !== 'resolved' && (
              <button
                type="button"
                disabled={updating !== null}
                onClick={() => void handleUpdateStatus('resolved')}
                className="flex-1 py-2 px-3 text-xs font-semibold rounded-xl border border-emerald-500/30 bg-emerald-500/10 hover:bg-emerald-500/20 text-success transition-colors flex items-center justify-center gap-2 cursor-pointer disabled:opacity-50"
              >
                {updating === 'resolved' ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <CheckCircle2 className="w-3.5 h-3.5" />}
                <span>Resolve</span>
              </button>
            )}
            <button
              type="button"
              disabled={updating !== null}
              onClick={() => void handleIgnore(!group.ignored)}
              title={
                group.ignored
                  ? 'Show this group in the default list and alert on it again'
                  : 'Keep recording this group, but hide it from the default list and never alert on it'
              }
              className="flex-1 py-2 px-3 text-xs font-semibold rounded-xl border border-admin-border bg-admin-surface hover:bg-admin-surface-raised text-admin-fg transition-colors flex items-center justify-center gap-2 cursor-pointer disabled:opacity-50"
            >
              {updating === 'ignore' || updating === 'unignore' ? (
                <Loader2 className="w-3.5 h-3.5 animate-spin" />
              ) : group.ignored ? (
                <Eye className="w-3.5 h-3.5" />
              ) : (
                <EyeOff className="w-3.5 h-3.5" />
              )}
              <span>{group.ignored ? 'Unignore' : 'Ignore'}</span>
            </button>
          </div>
        </div>
      ) : null}
    </AdminDrawer>
  )
}
