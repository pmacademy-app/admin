'use client'

import React, { useEffect } from 'react'

import { reportClientError } from '@/lib/monitoring/client-error-beacon'

/**
 * Root segment error boundary: catches what the console boundary does not (the login
 * and access-denied pages, the root page). Renders inside the root layout, so the
 * admin theme tokens apply through the `admin-console` class.
 *
 * Next.js 16.4 passes `retry` (re-fetch and re-render) and `reset` (re-render only).
 */
export default function RootError({
  error,
  retry,
  reset,
}: {
  error: unknown
  retry?: () => void
  reset?: () => void
}) {
  useEffect(() => {
    console.error(error)
    reportClientError(error, 'root')
  }, [error])

  const digest =
    error && typeof error === 'object' && typeof (error as { digest?: unknown }).digest === 'string'
      ? (error as { digest: string }).digest
      : undefined

  return (
    <div className="admin-console min-h-screen bg-admin-bg text-admin-fg flex items-center justify-center p-4">
      <div className="max-w-md w-full p-8 rounded-2xl bg-admin-surface border border-admin-border space-y-4 text-center">
        <h1 className="text-xl font-bold">Something went wrong</h1>
        <p className="text-sm text-admin-fg-muted">This page could not be loaded. The error has been reported.</p>
        {digest && (
          <p className="rounded-lg bg-admin-surface-raised px-3 py-2 font-mono text-[11px] text-admin-fg-muted break-all">
            Error ID: {digest}
          </p>
        )}
        <button
          type="button"
          onClick={() => (retry ?? reset)?.()}
          className="rounded-lg border border-admin-border bg-admin-surface px-4 py-1.5 text-xs font-semibold text-admin-fg transition-colors hover:bg-admin-surface-raised cursor-pointer focus-visible:ring-2 focus-visible:ring-admin-accent/50"
        >
          Try again
        </button>
      </div>
    </div>
  )
}
