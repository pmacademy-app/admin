'use client'

import React, { useEffect } from 'react'

import { reportClientError } from '@/lib/monitoring/client-error-beacon'

/**
 * Last-resort boundary for an error in the root layout itself.
 *
 * It replaces the root layout, so it renders its own `<html>` and `<body>` and gets
 * none of the global styles: the light admin look is inlined here. Next.js 16.4
 * passes `retry` (re-fetch and re-render) and `reset` (re-render only).
 */
const COLORS = {
  bg: '#F8FAFC',
  surface: '#FFFFFF',
  raised: '#F1F5F9',
  border: '#E2E8F0',
  fg: '#0F172A',
  muted: '#475569',
}

export default function GlobalError({
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
    reportClientError(error, 'global')
  }, [error])

  const digest =
    error && typeof error === 'object' && typeof (error as { digest?: unknown }).digest === 'string'
      ? (error as { digest: string }).digest
      : undefined

  return (
    <html lang="en">
      <body
        style={{
          margin: 0,
          minHeight: '100vh',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          padding: 16,
          boxSizing: 'border-box',
          background: COLORS.bg,
          color: COLORS.fg,
          fontFamily: 'system-ui, -apple-system, "Segoe UI", Roboto, sans-serif',
        }}
      >
        <title>Something went wrong | Prodily Admin</title>
        <main
          style={{
            maxWidth: 420,
            width: '100%',
            padding: 32,
            borderRadius: 16,
            background: COLORS.surface,
            border: `1px solid ${COLORS.border}`,
            textAlign: 'center',
          }}
        >
          <h1 style={{ fontSize: 20, fontWeight: 700, margin: '0 0 8px' }}>Something went wrong</h1>
          <p style={{ fontSize: 14, color: COLORS.muted, margin: '0 0 16px' }}>
            The admin console could not be loaded. The error has been reported.
          </p>
          {digest && (
            <p
              style={{
                fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
                fontSize: 11,
                color: COLORS.muted,
                background: COLORS.raised,
                borderRadius: 8,
                padding: '8px 12px',
                margin: '0 0 16px',
                wordBreak: 'break-all',
              }}
            >
              Error ID: {digest}
            </p>
          )}
          <button
            type="button"
            onClick={() => (retry ?? reset)?.()}
            style={{
              fontSize: 12,
              fontWeight: 600,
              padding: '6px 16px',
              borderRadius: 8,
              border: `1px solid ${COLORS.border}`,
              background: COLORS.surface,
              color: COLORS.fg,
              cursor: 'pointer',
            }}
          >
            Try again
          </button>
        </main>
      </body>
    </html>
  )
}
