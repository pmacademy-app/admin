'use client'

import React, { useState } from 'react'
import Link from 'next/link'
import { usePathname, useRouter } from 'next/navigation'
import { Dialog as DialogPrimitive } from '@base-ui/react/dialog'
import {
  LayoutDashboard,
  Users,
  MessagesSquare,
  ShieldAlert,
  Grip,
  LogOut,
  X,
  type LucideIcon,
} from 'lucide-react'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { signOutAdmin } from '@/lib/admin/session'
import { ADMIN_NAV_BUILT, isAdminNavItemActive } from '@/lib/admin/navigation'
import { useAdminShell } from './admin-shell-context'
import type { AdminConsoleUser } from './AdminConsoleShell'

interface Tab {
  name: string
  href: string
  icon: LucideIcon
}

/** The four places an admin goes most from a phone. Everything else lives under More. */
const TABS: Tab[] = [
  { name: 'Home', href: '/admin', icon: LayoutDashboard },
  { name: 'Users', href: '/admin/users', icon: Users },
  { name: 'Inbox', href: '/admin/communications', icon: MessagesSquare },
  { name: 'Review', href: '/admin/moderation', icon: ShieldAlert },
]

function isTabActive(href: string, pathname: string) {
  if (href === '/admin') return pathname === '/admin' || pathname === '/admin/dashboard'
  return pathname === href || pathname.startsWith(`${href}/`)
}

export interface AdminMobileNavProps {
  user?: AdminConsoleUser
  attention?: Record<string, number>
}

/**
 * Phone navigation (below md): a bottom tab bar like a native app, plus a "More"
 * sheet that holds every other section, the signed-in admin and sign out.
 */
export function AdminMobileNav({ user, attention = {} }: AdminMobileNavProps) {
  const pathname = usePathname()
  const router = useRouter()
  const shellRef = useAdminShell()
  const [moreOpen, setMoreOpen] = useState(false)

  const onTab = TABS.some((t) => isTabActive(t.href, pathname))
  const displayName = user?.name || user?.email.split('@')[0] || 'Admin'
  const moreCount = ['/admin/system'].reduce((sum, href) => sum + (attention[href] || 0), 0)

  return (
    <>
      <nav
        aria-label="Admin sections"
        className="no-print md:hidden fixed inset-x-0 bottom-0 z-40 border-t border-admin-border bg-admin-surface/95 backdrop-blur supports-[backdrop-filter]:bg-admin-surface/85 pb-[env(safe-area-inset-bottom)]"
      >
        <ul className="grid grid-cols-5">
          {TABS.map((tab) => {
            const Icon = tab.icon
            const active = isTabActive(tab.href, pathname)
            const count = attention[tab.href] || 0
            return (
              <li key={tab.href}>
                <Link
                  href={tab.href}
                  aria-current={active ? 'page' : undefined}
                  className={cn(
                    'relative flex h-16 flex-col items-center justify-center gap-1 text-[11px] font-semibold transition-colors',
                    active ? 'text-admin-accent' : 'text-admin-fg-muted active:text-admin-fg'
                  )}
                >
                  <span
                    className={cn(
                      'relative flex h-8 w-14 items-center justify-center rounded-full transition-colors',
                      active && 'bg-admin-accent-soft'
                    )}
                  >
                    <Icon className="h-5 w-5" aria-hidden="true" />
                    {count > 0 && (
                      <span className="absolute -top-1 right-1.5 min-w-[18px] rounded-full bg-admin-danger px-1 text-center text-[10px] font-bold leading-[18px] text-white">
                        {count > 99 ? '99+' : count}
                        <span className="sr-only"> need attention</span>
                      </span>
                    )}
                  </span>
                  {tab.name}
                </Link>
              </li>
            )
          })}
          <li>
            <Button
              type="button"
              variant="ghost"
              onClick={() => setMoreOpen(true)}
              aria-haspopup="dialog"
              aria-expanded={moreOpen}
              className={cn(
                'relative h-16 w-full flex-col gap-1 rounded-none text-[11px] font-semibold hover:bg-transparent',
                !onTab || moreOpen ? 'text-admin-accent' : 'text-admin-fg-muted active:text-admin-fg'
              )}
            >
              <span
                className={cn(
                  'relative flex h-8 w-14 items-center justify-center rounded-full transition-colors',
                  (!onTab || moreOpen) && 'bg-admin-accent-soft'
                )}
              >
                <Grip className="size-5" aria-hidden="true" />
                {moreCount > 0 && (
                  <span className="absolute -top-0.5 right-3 h-2.5 w-2.5 rounded-full bg-admin-danger ring-2 ring-admin-surface" aria-hidden="true" />
                )}
              </span>
              More
            </Button>
          </li>
        </ul>
      </nav>

      <DialogPrimitive.Root open={moreOpen} onOpenChange={setMoreOpen}>
        <DialogPrimitive.Portal container={shellRef}>
          <DialogPrimitive.Backdrop className="md:hidden fixed inset-0 z-50 bg-black/40 data-open:animate-in data-open:fade-in-0 data-closed:animate-out data-closed:fade-out-0" />
          <DialogPrimitive.Popup className="md:hidden fixed inset-x-0 bottom-0 z-50 flex max-h-[85dvh] flex-col rounded-t-3xl bg-admin-surface text-admin-fg shadow-2xl outline-none duration-200 data-open:animate-in data-open:slide-in-from-bottom data-closed:animate-out data-closed:slide-out-to-bottom">
            <div className="mx-auto mt-2.5 h-1.5 w-10 rounded-full bg-admin-border-strong" aria-hidden="true" />
            <div className="flex items-center justify-between px-5 pt-3 pb-2">
              <DialogPrimitive.Title className="text-lg font-bold">All sections</DialogPrimitive.Title>
              <DialogPrimitive.Close
                aria-label="Close"
                className="inline-flex size-10 items-center justify-center rounded-full bg-admin-surface-raised text-admin-fg-muted cursor-pointer"
              >
                <X className="h-5 w-5" />
              </DialogPrimitive.Close>
            </div>
            <DialogPrimitive.Description className="sr-only">Every admin console section</DialogPrimitive.Description>

            <div className="flex-1 overflow-y-auto overscroll-contain px-4 pb-4 space-y-5">
              {ADMIN_NAV_BUILT.map((group) => (
                <section key={group.label}>
                  <h3 className="px-1 pb-2 text-[11px] font-bold uppercase tracking-wider text-admin-fg-subtle">
                    {group.label}
                  </h3>
                  <ul className="grid grid-cols-3 gap-2">
                    {group.items.map((item) => {
                      const Icon = item.icon
                      const active = isAdminNavItemActive(item, pathname)
                      const count = attention[item.href] || 0
                      return (
                        <li key={item.href}>
                          <Link
                            href={item.href}
                            onClick={() => setMoreOpen(false)}
                            aria-current={active ? 'page' : undefined}
                            className={cn(
                              'relative flex min-h-[84px] flex-col items-center justify-center gap-2 rounded-2xl border p-2 text-center text-xs font-semibold transition-colors',
                              active
                                ? 'border-admin-accent/30 bg-admin-accent-soft text-admin-accent'
                                : 'border-admin-border bg-admin-surface-raised/50 text-admin-fg active:bg-admin-surface-raised'
                            )}
                          >
                            <Icon className={cn('h-5 w-5', active ? 'text-admin-accent' : 'text-admin-fg-muted')} aria-hidden="true" />
                            <span className="leading-tight">{item.name}</span>
                            {count > 0 && (
                              <span className="absolute top-1.5 right-1.5 min-w-[18px] rounded-full bg-admin-danger px-1 text-[10px] font-bold leading-[18px] text-white">
                                {count > 99 ? '99+' : count}
                              </span>
                            )}
                          </Link>
                        </li>
                      )
                    })}
                  </ul>
                </section>
              ))}
            </div>

            {user && (
              <div className="flex items-center gap-3 border-t border-admin-border px-5 pt-3 pb-[calc(0.75rem+env(safe-area-inset-bottom))]">
                <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full border border-admin-accent/25 bg-admin-accent-soft text-sm font-bold uppercase text-admin-accent">
                  {displayName.slice(0, 2)}
                </span>
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-semibold">{displayName}</p>
                  <p className="truncate text-xs text-admin-fg-subtle">{user.email}</p>
                </div>
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => signOutAdmin(router)}
                  className="h-10 gap-2 rounded-xl border-admin-border bg-admin-surface px-3 text-sm font-semibold text-admin-danger hover:bg-admin-danger-soft hover:text-admin-danger"
                >
                  <LogOut aria-hidden="true" />
                  Sign out
                </Button>
              </div>
            )}
          </DialogPrimitive.Popup>
        </DialogPrimitive.Portal>
      </DialogPrimitive.Root>
    </>
  )
}
