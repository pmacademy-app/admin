'use client'

import React, { useEffect, useRef } from 'react'
import { AdminSidebar } from './AdminSidebar'
import { AdminHeader } from './AdminHeader'
import { AdminMobileNav } from './AdminMobileNav'
import { AdminShellProvider } from './admin-shell-context'
import { AdminToastProvider } from './admin-toast'
import { installClientErrorListeners } from '@/lib/monitoring/client-error-listeners'

export interface AdminConsoleUser {
  name: string | null
  email: string
}

interface AdminConsoleShellProps {
  children: React.ReactNode
  user?: AdminConsoleUser
  /** Live attention counts keyed by nav href (sidebar badges). */
  attention?: Record<string, number>
  /** Total actionable items (header bell dot). */
  attentionTotal?: number
  /** Whether the database is reachable (header status chip). */
  systemOnline?: boolean
}

export function AdminConsoleShell({
  children,
  user,
  attention,
  attentionTotal = 0,
  systemOnline = true,
}: AdminConsoleShellProps) {
  const shellRef = useRef<HTMLDivElement>(null)

  // Global `error` / `unhandledrejection` reporting for every console page. The shell
  // mounts once per console visit; the installer is idempotent, so React's
  // development double effect still leaves exactly one pair of listeners.
  useEffect(() => installClientErrorListeners(), [])

  return (
    <AdminShellProvider shellRef={shellRef}>
      <AdminToastProvider>
        <div
          ref={shellRef}
          className="admin-console min-h-screen bg-admin-bg text-admin-fg flex font-sans antialiased selection:bg-admin-accent/30 selection:text-admin-accent"
        >
          <AdminSidebar user={user} attention={attention} />
          <div className="flex-1 flex flex-col min-w-0">
            <AdminHeader
              user={user}
              attention={attention}
              attentionTotal={attentionTotal}
              systemOnline={systemOnline}
            />
            {/* Bottom padding on phones keeps the last row clear of the tab bar. */}
            <main className="flex-1 px-4 pt-4 pb-[calc(5.5rem+env(safe-area-inset-bottom))] sm:px-6 sm:pt-6 md:p-8 max-w-7xl w-full mx-auto space-y-6 sm:space-y-8 overflow-x-hidden">
              {children}
            </main>
            <AdminMobileNav user={user} attention={attention} />
          </div>
        </div>
      </AdminToastProvider>
    </AdminShellProvider>
  )
}