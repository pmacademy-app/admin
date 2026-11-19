import { NextResponse } from 'next/server'

import { triggerLearnerCron, isLearnerCronName, LEARNER_CRON_NAMES } from '@/lib/admin/cron-trigger'
import { logAdminAction } from '@/lib/admin/guard'
import { requireAdmin } from '@/lib/api/actor'
import { RouteError, withRoute } from '@/lib/api/with-route'

export const runtime = 'nodejs'
export const maxDuration = 60

/**
 * POST /api/admin/system/cron/[name]
 *
 * Runs one learner cron job now (admin split). The admin app does not host /api/cron/*; it calls
 * the learner site server to server with the CRON_SECRET bearer, so the secret stays on the server.
 */
export const POST = withRoute(
  {
    actor: { allow: ['admin'] },
    operation: 'admin.system.cron.run.post',
    domain: 'admin',
    summary: 'Unexpected failure in POST /api/admin/system/cron/[name]',
    rateLimit: [
      {
        key: ({ actor }) => (actor.kind === 'admin' ? `admin_cron_run_${actor.userId}` : null),
        limit: 6,
        windowMs: 60 * 1000,
      },
    ],
  },
  async ({ actor, params }) => {
    const admin = requireAdmin(actor)
    const name = params.name
    if (!isLearnerCronName(name)) {
      throw new RouteError(400, 'VALIDATION', `name must be one of: ${LEARNER_CRON_NAMES.join(', ')}.`)
    }

    const result = await triggerLearnerCron(name)
    await logAdminAction(admin.userId, admin.email, 'cron_run_now', 'cron', name, {
      ok: result.ok,
      status: result.status ?? null,
    })

    if (!result.ok) {
      if (result.reason === 'not_configured') {
        throw new RouteError(503, 'CRON_NOT_CONFIGURED', 'LEARNER_SITE_URL and CRON_SECRET must be set to run jobs.')
      }
      throw new RouteError(502, 'CRON_RUN_FAILED', `The learner site did not run ${name} (${result.reason}).`)
    }
    return NextResponse.json({ success: true, job: name, status: result.status, result: result.body })
  }
)
