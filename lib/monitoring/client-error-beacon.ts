/**
 * Client error beacon (ENG-11).
 *
 * The error boundaries and the global `error` / `unhandledrejection` listeners post
 * a small, bounded report to `/api/client-errors`, which records it as a
 * `system_errors` row with app 'admin', runtime 'client' and the `source` below.
 *
 * What it sends, and nothing more: the error message (truncated), the Next.js digest
 * when there is one, the page path WITHOUT its query string (a reset or verification
 * link carries its token in the query), which hook caught it (`source`), which
 * boundary when it was a boundary, a truncated stack and the release this bundle was
 * built from. No cookies are read and no user id is sent: the server attributes the
 * report to the signed-in admin itself, from the session, and never trusts an id in
 * the body.
 *
 * Shared by the browser and the route (it imports the limits and enums), so the two
 * cannot drift apart. Browser safe: no Node imports.
 */

import { clientRelease } from './release'

export const CLIENT_ERROR_ENDPOINT = '/api/client-errors'

/** Which boundary caught the error. Mirrors the boundary files under `app/`. */
export const CLIENT_ERROR_BOUNDARIES = ['root', 'global', 'app', 'admin', 'communications'] as const
export type ClientErrorBoundary = (typeof CLIENT_ERROR_BOUNDARIES)[number]

/** Which browser hook caught the error (contract A, `details.source`). */
export const CLIENT_ERROR_SOURCES = ['boundary', 'window.onerror', 'unhandledrejection'] as const
export type ClientErrorSource = (typeof CLIENT_ERROR_SOURCES)[number]

export const MAX_CLIENT_ERROR_MESSAGE_LENGTH = 500
export const MAX_CLIENT_ERROR_DIGEST_LENGTH = 64
export const MAX_CLIENT_ERROR_PATH_LENGTH = 300
/** Stack text sent by the browser. The server redacts it and keeps at most 30 frames. */
export const MAX_CLIENT_ERROR_STACK_LENGTH = 4000
export const MAX_CLIENT_ERROR_RELEASE_LENGTH = 40

/**
 * Upper bound on the serialized report, enforced by the route before it parses.
 * The capped fields plus the JSON framing (and escaping) fit inside it.
 */
export const MAX_CLIENT_ERROR_BODY_BYTES = 8192

/** At most this many reports leave one page load, whichever hook raised them. */
export const MAX_REPORTS_PER_PAGE = 5

export interface ClientErrorPayload {
  message: string
  digest?: string
  path: string
  source: ClientErrorSource
  boundary?: ClientErrorBoundary
  stack?: string
  release?: string
}

function truncate(value: string, max: number): string {
  return value.length > max ? value.slice(0, max) : value
}

/**
 * Reads the message, digest and stack off whatever was thrown.
 *
 * Next.js passes a value thrown in a Client Component through as-is, so it may not
 * be an `Error` at all. A string, an object with a `message`, or anything else must
 * still produce a report rather than a second crash inside the boundary.
 */
function describeThrown(error: unknown): { message: string; digest?: string; stack?: string } {
  if (error && typeof error === 'object') {
    const record = error as { message?: unknown; digest?: unknown; stack?: unknown }
    let message: string
    try {
      message = typeof record.message === 'string' ? record.message : String(error)
    } catch {
      message = 'Unknown error'
    }
    const digest = typeof record.digest === 'string' && record.digest ? record.digest : undefined
    const stack = typeof record.stack === 'string' && record.stack.trim() ? record.stack : undefined
    return { message, digest, stack }
  }
  return { message: String(error) }
}

/** Path only: the query and hash are dropped because they can carry tokens. */
function normalizePath(path: string): string {
  const pathname = path.split(/[?#]/, 1)[0] || '/'
  return truncate(pathname.startsWith('/') ? pathname : `/${pathname}`, MAX_CLIENT_ERROR_PATH_LENGTH)
}

export interface ClientErrorReportOptions {
  source: ClientErrorSource
  boundary?: ClientErrorBoundary
}

/** Builds the bounded report. Exported so the truncation rules can be tested directly. */
export function buildClientErrorPayload(
  error: unknown,
  options: ClientErrorReportOptions | ClientErrorBoundary,
  path: string
): ClientErrorPayload {
  const { source, boundary } =
    typeof options === 'string' ? { source: 'boundary' as const, boundary: options } : options
  const { message, digest, stack } = describeThrown(error)
  const release = clientRelease()
  return {
    message: truncate(message || 'Unknown error', MAX_CLIENT_ERROR_MESSAGE_LENGTH),
    ...(digest ? { digest: truncate(digest, MAX_CLIENT_ERROR_DIGEST_LENGTH) } : {}),
    path: normalizePath(path),
    source,
    ...(boundary ? { boundary } : {}),
    ...(stack ? { stack: truncate(stack, MAX_CLIENT_ERROR_STACK_LENGTH) } : {}),
    ...(release ? { release: truncate(release, MAX_CLIENT_ERROR_RELEASE_LENGTH) } : {}),
  }
}

const sentKeys = new Set<string>()

/** Test hook: forgets which reports this page load already sent. */
export function resetClientErrorBeaconForTests(): void {
  sentKeys.clear()
}

/**
 * Sends one report, best effort. Never throws: it runs inside an error boundary or a
 * global error listener, and a failure here must not raise a second error.
 *
 * Deduplicated per page load on source, boundary and digest or message, and capped
 * at `MAX_REPORTS_PER_PAGE` across every hook, so a render loop or a noisy handler
 * cannot flood the endpoint.
 *
 * `navigator.sendBeacon` first, because it survives the admin navigating away from
 * the broken page; `fetch` with `keepalive` when the beacon is unavailable or the
 * browser refuses to queue it. Both are same-origin, so the session cookie goes with
 * the request and the server can attribute it.
 *
 * Returns true when a report was handed to the browser.
 */
export function sendClientErrorReport(error: unknown, options: ClientErrorReportOptions): boolean {
  try {
    if (typeof window === 'undefined') return false

    const payload = buildClientErrorPayload(error, options, window.location?.pathname ?? '/')

    // A boundary can re-render with the same error, React runs effects twice in
    // development, and one bug can fire both a boundary and a listener.
    const key = `${payload.source}|${payload.boundary ?? ''}|${payload.digest ?? payload.message}`
    if (sentKeys.has(key) || sentKeys.size >= MAX_REPORTS_PER_PAGE) return false
    sentKeys.add(key)

    const body = JSON.stringify(payload)

    if (typeof navigator !== 'undefined' && typeof navigator.sendBeacon === 'function') {
      const queued = navigator.sendBeacon(
        CLIENT_ERROR_ENDPOINT,
        new Blob([body], { type: 'application/json' })
      )
      if (queued) return true
    }

    if (typeof fetch === 'function') {
      void fetch(CLIENT_ERROR_ENDPOINT, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body,
        keepalive: true,
        credentials: 'same-origin',
      }).catch(() => {})
      return true
    }
    return false
  } catch {
    // Reporting is best effort by design.
    return false
  }
}

/** Reports an error caught by an `error.tsx` / `global-error.tsx` boundary. */
export function reportClientError(error: unknown, boundary: ClientErrorBoundary): void {
  sendClientErrorReport(error, { source: 'boundary', boundary })
}
