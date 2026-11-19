import React from 'react'
import { ShieldCheck } from 'lucide-react'
import { AdminPageHeader } from '@/components/admin/AdminPageHeader'
import { SecurityDigestControls } from '@/components/admin/SecurityDigestControls'
import { SecurityDigestView } from '@/components/admin/SecurityDigestView'
import { asDigestDb } from '@/lib/admin/security-digest/db'
import { loadDigestPageData, type DigestPageData } from '@/lib/admin/security-digest/read'
import { getAdminTimezone, isValidDay, localDay, previousDay } from '@/lib/admin/security-digest/time'
import { createServiceRoleClient } from '@/lib/supabase'

export const revalidate = 0

interface PageProps {
  searchParams: Promise<{ day?: string }>
}

/**
 * Security summary (rule based, no AI). The nightly cron at 01:00 IST writes one
 * digest per day into security_digests; this page shows the selected day and the
 * last 30, and lets an admin build one now.
 */
export default async function AdminSecurityPage({ searchParams }: PageProps) {
  const params = await searchParams
  const requestedDay = isValidDay(params.day) ? params.day : null

  let data: DigestPageData
  try {
    data = await loadDigestPageData(asDigestDb(createServiceRoleClient()), requestedDay)
  } catch (err) {
    console.error('[AdminSecurityPage] load failed:', err instanceof Error ? err.name : 'unknown')
    data = { status: 'error' }
  }

  const now = new Date()
  const timezone = getAdminTimezone()
  const yesterday = previousDay(now, timezone)

  return (
    <div className="space-y-8">
      <AdminPageHeader
        title="Security"
        description={`Daily rule-based security summary. Days are calendar days in ${timezone}.`}
        icon={ShieldCheck}
        actions={<SecurityDigestControls defaultDay={requestedDay ?? yesterday} maxDay={localDay(now, timezone)} />}
      />
      <SecurityDigestView data={data} requestedDay={requestedDay} />
    </div>
  )
}
