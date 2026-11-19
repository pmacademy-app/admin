import { NextResponse } from 'next/server'
import { z } from 'zod'

import { logAdminAction } from '@/lib/admin/guard'
import { setFingerprintIgnored } from '@/lib/admin/monitoring-ignore-service'
import { requireAdmin } from '@/lib/api/actor'
import { withRoute } from '@/lib/api/with-route'

export const runtime = 'nodejs'

const ignoreSchema = z
  .object({
    // Fingerprints are md5 hex today; the allowlist is a little wider so a future
    // hash still fits, and narrow enough that nothing odd lands in the setting.
    fingerprint: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/, 'A valid fingerprint is required.'),
    ignored: z.boolean(),
  })
  .strict()

/**
 * POST /api/admin/system/errors/ignore
 *
 * Adds a fingerprint to the monitoring ignore list (`ignored: true`) or removes it
 * (`ignored: false`). An ignored group is still recorded by the logger but never
 * alerts, and is hidden from the default Errors list. Admin only, audited. Adding
 * past 500 entries is refused with 409 IGNORE_LIST_FULL.
 */
export const POST = withRoute(
  {
    actor: { allow: ['admin'] },
    operation: 'admin.system.errors.ignore.post',
    domain: 'admin',
    summary: 'Unexpected failure in POST /api/admin/system/errors/ignore',
    body: ignoreSchema,
  },
  async ({ actor, body }) => {
    const admin = requireAdmin(actor)
    const result = await setFingerprintIgnored(body.fingerprint, body.ignored)

    if (result.changed) {
      await logAdminAction(
        admin.userId,
        admin.email,
        body.ignored ? 'system_error_ignored' : 'system_error_unignored',
        'system_error',
        body.fingerprint,
        { ignored: body.ignored, ignoreListSize: result.fingerprints.length }
      )
    }

    return NextResponse.json({
      success: true,
      fingerprint: body.fingerprint,
      ignored: body.ignored,
      changed: result.changed,
      ignoreListSize: result.fingerprints.length,
    })
  }
)
