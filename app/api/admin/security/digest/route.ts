import { NextResponse } from 'next/server'
import { z } from 'zod'

import { logAdminAction } from '@/lib/admin/guard'
import { asDigestDb, DigestWriteError, InvalidDigestDayError, runSecurityDigest } from '@/lib/admin/security-digest'
import { requireAdmin } from '@/lib/api/actor'
import { RouteError, withRoute } from '@/lib/api/with-route'
import { createServiceRoleClient } from '@/lib/supabase'

export const runtime = 'nodejs'
export const maxDuration = 60

const bodySchema = z.object({
  day: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, 'day must be a YYYY-MM-DD date.')
    .optional(),
  /** Send the webhook and notifications again even if they already went out for this day. */
  force: z.boolean().optional(),
})

/**
 * POST /api/admin/security/digest
 *
 * "Generate now" from the security console page. Admin only. Builds (or rebuilds)
 * the summary for `day`, default yesterday in Asia/Kolkata. A rebuild overwrites
 * the stored digest and does not resend the webhook unless `force` is true.
 */
export const POST = withRoute(
  {
    actor: { allow: ['admin'] },
    operation: 'admin.security.digest.generate',
    domain: 'admin',
    summary: 'Unexpected failure in POST /api/admin/security/digest',
    body: bodySchema,
    rateLimit: [
      {
        key: ({ actor }) => (actor.kind === 'admin' ? `admin_security_digest_${actor.userId}` : null),
        limit: 10,
        windowMs: 10 * 60 * 1000,
      },
    ],
  },
  async ({ actor, body }) => {
    const admin = requireAdmin(actor)
    let result
    try {
      result = await runSecurityDigest(
        { db: asDigestDb(createServiceRoleClient()) },
        { day: body.day, force: body.force === true, trigger: 'admin' }
      )
    } catch (err) {
      if (err instanceof InvalidDigestDayError) {
        throw new RouteError(400, 'VALIDATION', 'day must be a valid date that is not in the future.')
      }
      if (err instanceof DigestWriteError) {
        throw new RouteError(503, 'DIGEST_WRITE_FAILED', 'The summary could not be saved. Try again shortly.')
      }
      throw err
    }

    await logAdminAction(admin.userId, admin.email, 'security_digest_generated', 'security_digest', result.day, {
      status: result.status,
      force: body.force === true,
      ...(result.status === 'ok' ? { severity: result.severity, webhook: result.webhook } : {}),
    })

    return NextResponse.json({ success: true, result })
  }
)
