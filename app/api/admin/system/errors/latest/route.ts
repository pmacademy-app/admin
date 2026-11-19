import { NextResponse } from 'next/server'
import { z } from 'zod'

import { SystemService } from '@/lib/admin/system-service'
import { withRoute } from '@/lib/api/with-route'

export const runtime = 'nodejs'

const latestQuery = z.object({
  fingerprint: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/, 'A valid fingerprint is required.'),
})

/**
 * GET /api/admin/system/errors/latest?fingerprint=...
 *
 * The newest row of one error group with its full details (stack, path, request id,
 * digest, release, app, runtime, source, regression flag), already redacted by the
 * logger at write time. Loaded when the error drawer opens, so the Errors list does
 * not carry every row's details payload.
 */
export const GET = withRoute(
  {
    actor: { allow: ['admin'] },
    operation: 'admin.system.errors.latest.get',
    domain: 'admin',
    summary: 'Unexpected failure in GET /api/admin/system/errors/latest',
    query: latestQuery,
  },
  async ({ query }) => {
    const incident = await SystemService.getLatestIncident(query.fingerprint)
    return NextResponse.json({ success: true, incident })
  }
)
