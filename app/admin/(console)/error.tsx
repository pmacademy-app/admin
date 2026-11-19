'use client'

import React, { useEffect } from 'react'
import { AlertTriangle } from 'lucide-react'

import { reportClientError } from '@/lib/monitoring/client-error-beacon'

/**
 * Admin console error boundary. Next.js 16.4 passes `retry`, which re-fetches and
 * re-renders the failed segment, and `reset`, which only re-renders it; `retry` is
 * preferred because a failed server fetch is the usual cause.
 */
export default function AdminConsoleError({
  error,
  retry,
  reset,
}: {
  error: Error & { digest?: string }
  retry?: () => void
  reset?: () => void
}) {
  useEffect(() => {
    console.error(error)
    reportClientError(error, 'admin')
  }, [error])

  const handleRetry = () => {
    if (retry) retry()
    else if (reset) reset()
  }

  return (
    <div className="flex flex-col items-center justify-center gap-4 rounded-xl border border-admin-danger/25 bg-admin-danger-soft/40 px-6 py-16 text-center">
      <div className="p-3 rounded-xl bg-admin-danger-soft border border-admin-danger/25">
        <AlertTriangle className="w-6 h-6 text-admin-danger stroke-[1.5]" />
      </div>
      <div className="space-y-1">
        <p className="text-sm font-bold text-admin-fg">Something went wrong</p>
        <p className="max-w-sm text-xs text-admin-fg-muted">
          We could not load this page. Please try again.
        </p>
        {error.digest && (
          <p className="mx-auto max-w-md rounded-lg bg-admin-surface px-3 py-2 font-mono text-[11px] text-admin-fg-muted break-all">
            Error ID: {error.digest}
          </p>
        )}
      </div>
      <button
        type="button"
        onClick={handleRetry}
        className="mt-1 rounded-lg border border-admin-border bg-admin-surface px-4 py-1.5 text-xs font-semibold text-admin-fg transition-colors hover:bg-admin-surface-raised cursor-pointer focus-visible:ring-2 focus-visible:ring-admin-accent/50"
      >
        Try again
      </button>
    </div>
  )
}