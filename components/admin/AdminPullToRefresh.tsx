'use client'

import React, { useEffect, useRef, useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { ArrowDown, Loader2 } from 'lucide-react'
import { cn } from '@/lib/utils'

/** How far (px) the finger must drag down from the top before a release refreshes. */
const THRESHOLD = 72
const MAX_PULL = 110

function isStandaloneApp(): boolean {
  if (typeof window === 'undefined') return false
  const iosStandalone = (window.navigator as Navigator & { standalone?: boolean }).standalone === true
  return iosStandalone || window.matchMedia?.('(display-mode: standalone)').matches === true
}

/**
 * Pull down at the top of the page to refresh the server data, like a native app.
 *
 * Only active when the console runs from the home screen: there the browser has no
 * reload button and no built-in pull-to-refresh. In a normal browser tab it does
 * nothing, so it never doubles up with Chrome's own gesture.
 */
export function AdminPullToRefresh() {
  const router = useRouter()
  const [pull, setPull] = useState(0)
  const [isPending, startTransition] = useTransition()
  const startY = useRef<number | null>(null)
  const pullRef = useRef(0)

  useEffect(() => {
    if (!isStandaloneApp()) return

    const onStart = (e: TouchEvent) => {
      // Only from the very top, and not while a sheet or dialog is open.
      if (window.scrollY > 0 || document.querySelector('[role="dialog"]')) {
        startY.current = null
        return
      }
      startY.current = e.touches[0].clientY
    }
    const onMove = (e: TouchEvent) => {
      if (startY.current === null) return
      const delta = e.touches[0].clientY - startY.current
      if (delta <= 0 || window.scrollY > 0) {
        pullRef.current = 0
        setPull(0)
        return
      }
      // Resistance: the indicator moves slower than the finger.
      const next = Math.min(MAX_PULL, delta * 0.5)
      pullRef.current = next
      setPull(next)
    }
    const onEnd = () => {
      if (startY.current !== null && pullRef.current >= THRESHOLD) {
        startTransition(() => router.refresh())
      }
      startY.current = null
      pullRef.current = 0
      setPull(0)
    }

    window.addEventListener('touchstart', onStart, { passive: true })
    window.addEventListener('touchmove', onMove, { passive: true })
    window.addEventListener('touchend', onEnd)
    window.addEventListener('touchcancel', onEnd)
    return () => {
      window.removeEventListener('touchstart', onStart)
      window.removeEventListener('touchmove', onMove)
      window.removeEventListener('touchend', onEnd)
      window.removeEventListener('touchcancel', onEnd)
    }
  }, [router])

  const visible = pull > 8 || isPending
  const ready = pull >= THRESHOLD

  return (
    <div
      aria-live="polite"
      className={cn(
        'no-print md:hidden pointer-events-none fixed inset-x-0 z-40 flex justify-center transition-opacity',
        visible ? 'opacity-100' : 'opacity-0'
      )}
      style={{ top: `calc(3.5rem + env(safe-area-inset-top) + ${isPending ? 16 : pull / 2}px)` }}
    >
      <span className="flex h-10 w-10 items-center justify-center rounded-full border border-admin-border bg-admin-surface text-admin-accent shadow-lg">
        {isPending ? (
          <>
            <Loader2 className="h-5 w-5 animate-spin" aria-hidden="true" />
            <span className="sr-only">Refreshing</span>
          </>
        ) : (
          <ArrowDown
            className={cn('h-5 w-5 transition-transform', ready && 'rotate-180')}
            aria-hidden="true"
          />
        )}
      </span>
    </div>
  )
}
