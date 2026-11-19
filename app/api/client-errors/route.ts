import { z } from 'zod'

import { resolveActor } from '@/lib/api/actor'
import { RouteError, withRoute } from '@/lib/api/with-route'
import {
  CLIENT_ERROR_BOUNDARIES,
  CLIENT_ERROR_SOURCES,
  MAX_CLIENT_ERROR_BODY_BYTES,
  MAX_CLIENT_ERROR_DIGEST_LENGTH,
  MAX_CLIENT_ERROR_MESSAGE_LENGTH,
  MAX_CLIENT_ERROR_PATH_LENGTH,
  MAX_CLIENT_ERROR_RELEASE_LENGTH,
  MAX_CLIENT_ERROR_STACK_LENGTH,
  type ClientErrorSource,
} from '@/lib/monitoring/client-error-beacon'
import { logSystemError } from '@/lib/monitoring/logger'
import { RELEASE_LENGTH } from '@/lib/monitoring/release'
import { getClientIpBucket } from '@/lib/security/client-ip'

export const runtime = 'nodejs'

/** Per-IP budget. A crashing page reports a handful of times at most; more is a flood. */
const CLIENT_ERROR_IP_LIMIT = { limit: 10, windowMs: 60 * 1000 }

/**
 * Budget across every caller. The endpoint accepts anonymous reports, so a per-IP
 * limit alone lets a botnet fill `system_errors`. Past this, reports are refused
 * until the window rolls over; real crashes in that window are a burst already
 * visible from the reports that did land.
 */
const CLIENT_ERROR_GLOBAL_LIMIT = { limit: 300, windowMs: 10 * 60 * 1000 }

const clientErrorSchema = z
  .object({
    message: z.string().min(1).max(MAX_CLIENT_ERROR_MESSAGE_LENGTH),
    digest: z
      .string()
      .max(MAX_CLIENT_ERROR_DIGEST_LENGTH)
      .regex(/^[A-Za-z0-9_-]+$/)
      .optional(),
    path: z.string().min(1).max(MAX_CLIENT_ERROR_PATH_LENGTH).startsWith('/'),
    source: z.enum(CLIENT_ERROR_SOURCES).default('boundary'),
    boundary: z.enum(CLIENT_ERROR_BOUNDARIES).optional(),
    stack: z.string().max(MAX_CLIENT_ERROR_STACK_LENGTH).optional(),
    release: z
      .string()
      .max(MAX_CLIENT_ERROR_RELEASE_LENGTH)
      .regex(/^[A-Za-z0-9._-]+$/)
      .optional(),
  })
  .strict()
  .refine((report) => report.source !== 'boundary' || Boolean(report.boundary), {
    message: 'A boundary report names its boundary.',
  })

const payloadTooLarge = () => new RouteError(413, 'PAYLOAD_TOO_LARGE', 'Report is too large.')
const invalidReport = () => new RouteError(400, 'VALIDATION', 'Invalid error report.')

/** Operation per source, so a boundary crash and an unhandled rejection never share an incident. */
const OPERATION_BY_SOURCE: Record<ClientErrorSource, string> = {
  boundary: 'client.error_boundary',
  'window.onerror': 'client.window_error',
  unhandledrejection: 'client.unhandled_rejection',
}

function summaryFor(source: ClientErrorSource, boundary: string | undefined, message: string): string {
  const head = message.slice(0, 200)
  if (source === 'boundary') return `Client error caught by the ${boundary} boundary: ${head}`
  if (source === 'unhandledrejection') return `Unhandled promise rejection in the browser: ${head}`
  return `Uncaught error in the browser: ${head}`
}

/**
 * Reads the body as text, refusing once it passes `maxBytes`.
 *
 * The declared length is checked first so an honest oversized request is refused
 * without reading it; the stream is then counted as it arrives, because the header
 * is optional and can lie. Either way no more than `maxBytes` is ever buffered.
 */
async function readCappedText(request: Request, maxBytes: number): Promise<string> {
  const declared = Number(request.headers.get('content-length'))
  if (Number.isFinite(declared) && declared > maxBytes) throw payloadTooLarge()

  if (!request.body) return ''

  const reader = request.body.getReader()
  const chunks: Uint8Array[] = []
  let received = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    received += value.byteLength
    if (received > maxBytes) {
      await reader.cancel().catch(() => {})
      throw payloadTooLarge()
    }
    chunks.push(value)
  }

  const joined = new Uint8Array(received)
  let offset = 0
  for (const chunk of chunks) {
    joined.set(chunk, offset)
    offset += chunk.byteLength
  }
  return new TextDecoder().decode(joined)
}

/**
 * The signed-in admin behind the report, if any (contract B).
 *
 * Resolved from the session cookie the same-origin beacon carries, after the
 * limiter has run, so a flood cannot buy an auth lookup per request. Never read
 * from the body. A crashed page may have no session at all, which is fine.
 */
async function reportingAdminId(request: Request): Promise<string | undefined> {
  try {
    const resolution = await resolveActor(request, { allow: ['admin', 'anonymous'] })
    return resolution.ok && resolution.actor.kind === 'admin' ? resolution.actor.userId : undefined
  } catch {
    return undefined
  }
}

/**
 * POST /api/client-errors
 *
 * Receives the reports `lib/monitoring/client-error-beacon.ts` sends from the error
 * boundaries and the global `error` / `unhandledrejection` listeners. Anonymous on
 * purpose: a crash can happen on the login page or after the session expired.
 *
 * The body is not declared to `withRoute`: it is read here, under a byte cap, so the
 * per-IP and global limiters run before any of it is buffered. Replies 204.
 */
export const POST = withRoute(
  {
    actor: { allow: ['anonymous'] },
    operation: 'client_errors.report',
    domain: 'api',
    summary: 'Unhandled exception in /api/client-errors',
    rateLimit: [
      {
        key: ({ request }) => `client_errors:${getClientIpBucket(request)}`,
        ...CLIENT_ERROR_IP_LIMIT,
      },
      {
        key: () => 'client_errors:global',
        ...CLIENT_ERROR_GLOBAL_LIMIT,
      },
    ],
  },
  async ({ request, requestId }) => {
    const text = await readCappedText(request, MAX_CLIENT_ERROR_BODY_BYTES)

    let raw: unknown
    try {
      raw = JSON.parse(text)
    } catch {
      throw invalidReport()
    }

    const parsed = clientErrorSchema.safeParse(raw)
    if (!parsed.success) throw invalidReport()

    const { message, digest, path, source, boundary, stack, release } = parsed.data
    const userId = await reportingAdminId(request)

    // The summary names the source (and boundary) and the message so distinct crashes
    // get distinct incidents; the logger redacts it and collapses ids before
    // fingerprinting. The path stays in `details` so one crash on many pages is still
    // one incident.
    await logSystemError({
      severity: 'warning',
      category: 'api',
      operation: OPERATION_BY_SOURCE[source],
      message: summaryFor(source, boundary, message),
      userId,
      details: {
        ...(boundary ? { boundary } : {}),
        path,
        ...(digest ? { digest } : {}),
        clientMessage: message,
        requestId,
      },
      runtime: 'client',
      source,
      ...(stack ? { stack } : {}),
      ...(release ? { release: release.slice(0, RELEASE_LENGTH) } : {}),
    })

    return new Response(null, { status: 204 })
  }
)
