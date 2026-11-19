import { NextResponse } from 'next/server'

import { logAdminAction } from '@/lib/admin/guard'
import { logAdminRouteFailure } from '@/lib/admin/route-failure'
import { SystemService } from '@/lib/admin/system-service'
import { requireAdmin } from '@/lib/api/actor'
import { withRoute } from '@/lib/api/with-route'
import { adminErrorMessage } from '@/lib/errors/api-response'
import { revalidateAdminShell } from '@/lib/admin/cache-tags'

export const runtime = 'nodejs'

/**
 * Grouped operational errors from `system_errors` (spec §46 / §7.5).
 *
 * Filters: severity, category, status, app (web | admin), release, showIgnored
 * (`true` to include groups on the monitoring ignore list), page, pageSize.
 * Occurrences are SUM(occurrence_count) and last seen is MAX(updated_at).
 */
export const GET = withRoute(
  {
    actor: { allow: ['admin'] },
    operation: 'admin.system.errors.get',
    domain: 'admin',
    summary: 'Unexpected failure in GET /api/admin/system/errors',
  },
  async ({ request, actor, requestId }) => {
    try {
      const { searchParams } = new URL(request.url)
      const result = await SystemService.getErrorGroups({
        severity: searchParams.get('severity') || undefined,
        category: searchParams.get('category') || undefined,
        status: searchParams.get('status') || undefined,
        app: searchParams.get('app') || undefined,
        release: searchParams.get('release') || undefined,
        showIgnored: searchParams.get('showIgnored') === 'true',
        page: Number(searchParams.get('page')) || 1,
        pageSize: Number(searchParams.get('pageSize')) || 25,
      })
      return NextResponse.json({ success: true, ...result })
    } catch (err) {
      await logAdminRouteFailure({
        operation: 'admin.system.errors.get',
        summary: 'System errors could not be listed',
        error: err,
        requestId,
        userId: requireAdmin(actor).userId,
      })
      const message = adminErrorMessage(err, 'Failed to fetch system errors')
      return NextResponse.json({ success: false, error: message }, { status: 500 })
    }
  }
)

export const PATCH = withRoute(
  {
    actor: { allow: ['admin'] },
    operation: 'admin.system.errors.patch',
    domain: 'admin',
    summary: 'Unexpected failure in PATCH /api/admin/system/errors',
  },
  async ({ request, actor, requestId }) => {
    const admin = requireAdmin(actor)
    try {
      const body = await request.json()
      const { fingerprint, newStatus } = body

      if (!fingerprint || !['new', 'acknowledged', 'resolved'].includes(newStatus)) {
        return NextResponse.json(
          { error: 'Valid fingerprint and newStatus are required.' },
          { status: 400 }
        )
      }

      const result = await SystemService.updateErrorGroupStatus(fingerprint, newStatus)
      await logAdminAction(
        admin.userId,
        admin.email,
        `system_error_${newStatus}`,
        'system_error',
        fingerprint,
        { newStatus, updatedCount: result.updatedCount }
      )

      revalidateAdminShell()
      return NextResponse.json({ ...result })
    } catch (err) {
      await logAdminRouteFailure({
        operation: 'admin.system.errors.patch',
        summary: 'System error status could not be updated',
        error: err,
        requestId,
        userId: admin.userId,
      })
      const message = adminErrorMessage(err, 'Failed to update system error')
      return NextResponse.json({ success: false, error: message }, { status: 500 })
    }
  }
)
