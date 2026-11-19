import { createHash } from 'node:crypto'
import { after } from 'next/server'

import { maskEmailAddress } from '@/lib/monitoring/redaction'
import { createServiceRoleClient } from '@/lib/supabase'

/**
 * Security event counters (admin copy).
 *
 * Writes one increment into `public.security_event_counts` through the
 * `record_security_event` RPC (service role only, upsert increment). The daily
 * security summary (lib/admin/security-digest) reads these counters; nothing
 * else depends on them, so recording is strictly best effort:
 *
 * - Never throws and never delays the response: the RPC runs in `after()` when a
 *   request scope exists, otherwise as a caught, un-awaited promise.
 * - Stores no raw identifiers: the subject (usually an email) becomes the first
 *   16 hex chars of sha256(lowercased, trimmed subject), plus a masked hint.
 * - Disables itself for 10 minutes when the RPC does not exist yet (PGRST202 or
 *   42883), so an unapplied migration costs one failed call per instance per
 *   10 minutes instead of one per request.
 *
 * Same API as the learner helper in the web repo; this repo passes `app: 'admin'`.
 * Admin-owned (see scripts/sync-from-web.mjs) so a sync never overwrites it.
 */

export const SECURITY_EVENT_TYPES = [
  'login_failed',
  'login_rate_limited',
  'admin_login_failed',
  'admin_login_rate_limited',
  'admin_login_non_admin',
  'signup_blocked',
  'turnstile_failed',
  'password_reset_requested',
  'password_reset_rate_limited',
  'origin_rejected',
  'webhook_auth_failed',
  'email_hook_auth_failed',
  'cron_auth_failed',
  'internal_revalidate_auth_failed',
  'client_errors_flood',
  'quiz_check_rate_limited',
] as const

export type SecurityEventType = (typeof SECURITY_EVENT_TYPES)[number]

export type SecurityEventApp = 'web' | 'admin'

export interface RecordSecurityEventOptions {
  app: SecurityEventApp
  /** From getClientIpBucket(request) (the full IP); coarsened to /24 or /48 before storage. */
  ipBucket?: string | null
  /** The targeted account, usually an email. Hashed before it leaves this module. */
  subject?: string | null
  /** Request path, stored as a sample only. Query strings are dropped. */
  path?: string | null
}

/** How long recording stays off after the RPC turned out to be missing. */
export const SECURITY_EVENTS_DISABLE_MS = 10 * 60 * 1000

const MISSING_RPC_CODES = new Set(['PGRST202', '42883'])

let disabledUntil = 0

/** First 16 hex chars of sha256 over the lowercased, trimmed subject; '' when there is none. */
export function hashSecuritySubject(subject: string | null | undefined): string {
  const normalized = (subject ?? '').trim().toLowerCase()
  if (!normalized) return ''
  return createHash('sha256').update(normalized, 'utf8').digest('hex').slice(0, 16)
}

/** Masked hint for a subject: an email is masked, anything else is not stored. */
export function securitySubjectHint(subject: string | null | undefined): string | null {
  const normalized = (subject ?? '').trim().toLowerCase()
  if (!normalized || !normalized.includes('@')) return null
  return maskEmailAddress(normalized).slice(0, 120)
}

/** Expands an IPv6 address to its 8 hextets, or null when it is not one. */
function ipv6Hextets(ip: string): string[] | null {
  if (!/^[0-9a-f:]+$/i.test(ip) || !ip.includes(':')) return null
  const halves = ip.split('::')
  if (halves.length > 2) return null
  const head = halves[0] ? halves[0].split(':') : []
  const tail = halves.length === 2 && halves[1] ? halves[1].split(':') : []
  const missing = 8 - head.length - tail.length
  if (halves.length === 1 ? missing !== 0 : missing < 1) return null
  const all = [...head, ...new Array(halves.length === 2 ? missing : 0).fill('0'), ...tail]
  if (all.some((h) => h.length === 0 || h.length > 4)) return null
  return all.map((h) => h.toLowerCase().replace(/^0+(?=.)/, ''))
}

/**
 * Coarsens a client IP before storage: IPv4 to its /24 (203.0.113.0/24), IPv6 to its
 * /48 (2001:db8:abcd::/48). 'unresolved', '' and an already coarsened value pass
 * through; anything else that is not an address becomes 'unresolved'.
 */
export function coarsenIpBucket(ip: string | null | undefined): string {
  const value = (ip ?? '').trim().toLowerCase()
  if (!value || value === 'unresolved') return value
  if (value.includes('/')) return value.slice(0, 64)
  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(value)
  if (v4) {
    const octets = v4.slice(1, 4).map(Number)
    if (octets.every((o) => o <= 255) && Number(v4[4]) <= 255) return `${octets.join('.')}.0/24`
    return 'unresolved'
  }
  const hextets = ipv6Hextets(value)
  if (hextets) return `${hextets.slice(0, 3).join(':')}::/48`
  return 'unresolved'
}

/** Pathname only: query and fragment dropped, a full URL reduced to its path. */
export function samplePath(path: string | null | undefined): string | null {
  if (!path) return null
  let candidate = path.trim()
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(candidate)) {
    try {
      candidate = new URL(candidate).pathname
    } catch {
      return null
    }
  }
  const withoutQuery = candidate.split('?')[0].split('#')[0]
  return withoutQuery ? withoutQuery.slice(0, 200) : null
}

function errorCode(error: unknown): string | null {
  if (error && typeof error === 'object' && 'code' in error) {
    const code = (error as { code?: unknown }).code
    return typeof code === 'string' ? code : null
  }
  return null
}

async function write(type: SecurityEventType, options: RecordSecurityEventOptions): Promise<void> {
  try {
    const client = createServiceRoleClient() as unknown as {
      rpc?: (fn: string, args: Record<string, unknown>) => PromiseLike<{ error: unknown }>
    }
    // A partial test double without rpc is treated like a missing RPC, silently.
    if (typeof client?.rpc !== 'function') return
    const { error } = await client.rpc('record_security_event', {
      p_event_type: type,
      p_app: options.app,
      p_ip_bucket: coarsenIpBucket(options.ipBucket),
      p_subject_hash: hashSecuritySubject(options.subject),
      p_subject_hint: securitySubjectHint(options.subject),
      p_path: samplePath(options.path),
    })
    if (error) {
      const code = errorCode(error)
      if (code && MISSING_RPC_CODES.has(code)) {
        disabledUntil = Date.now() + SECURITY_EVENTS_DISABLE_MS
        return
      }
      console.warn('[security-events] record failed', { type, code })
    }
  } catch (err) {
    // Only the code is logged: an error message could echo the arguments.
    console.warn('[security-events] record failed', { type, code: errorCode(err) })
  }
}

/**
 * Records one security event. Fire and forget: returns immediately, never throws.
 */
export function recordSecurityEvent(type: SecurityEventType, options: RecordSecurityEventOptions): void {
  try {
    if (Date.now() < disabledUntil) return
    const task = () => write(type, options)
    try {
      after(task)
    } catch {
      // Outside a request scope (a script, a unit test): run it detached.
      void task().catch(() => {})
    }
  } catch {
    // Instrumentation must never change the outcome of the request it observes.
  }
}

/** Test hook: clears the missing-RPC back-off. */
export function resetSecurityEventsStateForTests(): void {
  disabledUntil = 0
}

/** Test hook: true while recording is backed off. */
export function isSecurityEventsDisabled(): boolean {
  return Date.now() < disabledUntil
}
