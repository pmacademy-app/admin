import { RouteError, withRoute } from '@/lib/api/with-route'
import { SystemService } from '@/lib/admin/system-service'
import { logAdminRouteFailure } from '@/lib/admin/route-failure'
import { requireAdmin } from '@/lib/api/actor'

export const runtime = 'nodejs'

export const GET = withRoute(
  {
    actor: { allow: ['admin'] },
    operation: 'admin.system.auth_health.get',
    domain: 'admin',
    summary: 'Unexpected failure in GET /api/admin/system/auth-health',
  },
  async ({ actor, requestId }) => {
    try {
      const data = await SystemService.getAuthHealthTelemetry()
      return Response.json({ success: true, data }, { status: 200 })
    } catch (err) {
      await logAdminRouteFailure({
        operation: 'admin.system.auth_health.get',
        summary: 'Authentication health could not be read',
        error: err,
        requestId,
        userId: requireAdmin(actor).userId,
      })
      throw new RouteError(500, 'AUTH_HEALTH_FETCH_FAILED', 'Failed to fetch authentication health')
    }
  }
)
