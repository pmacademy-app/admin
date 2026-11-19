import { NextResponse } from 'next/server'

import { asDigestDb, runSecurityDigest } from '@/lib/admin/security-digest'
import { withRoute } from '@/lib/api/with-route'
import { getClientIpBucket } from '@/lib/security/client-ip'
import { recordSecurityEvent } from '@/lib/security/security-events'
import { createServiceRoleClient } from '@/lib/supabase'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 60

/**
 * GET /api/admin/cron/security-digest (Vercel cron, daily at 19:30 UTC = 01:00 IST)
 *
 * Builds the security summary for the previous Asia/Kolkata day. Vercel calls
 * cron paths with GET and `Authorization: Bearer ${CRON_SECRET}`; the cron actor
 * compares it in constant time and refuses everything else (no admin session is
 * accepted here). POST is accepted with the same bearer for a manual run.
 *
 * Returns 200 with `status: 'not_set_up'` while the held migration is unapplied,
 * so the cron does not retry or alert on a known state.
 */
const handler = withRoute(
  {
    actor: { allow: ['cron'] },
    operation: 'admin.cron.security_digest',
    domain: 'admin',
    summary: 'Unexpected failure in the security digest cron',
    onDenied: ({ request }) => {
      recordSecurityEvent('cron_auth_failed', {
        app: 'admin',
        ipBucket: getClientIpBucket(request),
        path: '/api/admin/cron/security-digest',
      })
    },
  },
  async () => {
    const result = await runSecurityDigest({ db: asDigestDb(createServiceRoleClient()) }, { trigger: 'cron' })
    return NextResponse.json({ success: true, result })
  }
)

export const GET = handler
export const POST = handler
