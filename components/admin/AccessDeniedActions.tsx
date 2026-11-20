'use client'

import React, { useState } from 'react'
import { useRouter } from 'next/navigation'
import { Loader2, LogOut } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { signOutAdmin } from '@/lib/admin/session'

/**
 * Signs out the current (non-admin) account and lands on the admin login page.
 *
 * A plain link to /admin/login would loop: the proxy sends any signed-in non-admin
 * straight back here. Signing out first breaks that loop.
 */
export function AccessDeniedActions() {
  const router = useRouter()
  const [pending, setPending] = useState(false)

  return (
    <Button
      type="button"
      size="lg"
      disabled={pending}
      onClick={async () => {
        setPending(true)
        await signOutAdmin(router)
      }}
      className="h-12 w-full gap-2 rounded-xl bg-admin-accent text-base font-semibold text-admin-accent-fg hover:bg-admin-accent/90 sm:text-sm"
    >
      {pending ? <Loader2 className="animate-spin" aria-hidden="true" /> : <LogOut aria-hidden="true" />}
      {pending ? 'Signing out...' : 'Sign out and use an admin account'}
    </Button>
  )
}
