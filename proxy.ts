import { NextResponse } from 'next/server'
import type { NextRequest } from 'next/server'
import { createClient } from '@supabase/supabase-js'
import { REQUEST_ID_HEADER, resolveRequestId } from '@/lib/monitoring/request-id'
import { setSessionCookies } from '@/lib/auth/session-cookies'
import { isAllowedApiOrigin } from '@/lib/security/origin-check'

/**
 * Admin console proxy (Next 16 `proxy.ts`, formerly middleware).
 *
 * A trimmed version of the web repo's proxy with no learner gates (no maintenance mode,
 * onboarding, consent, referral or lesson redirects). It does four things:
 *   1. same-origin check for cookie-bearing non-GET API calls (SEC-12),
 *   2. session refresh: verifies the access token, falls back to the refresh token and
 *      persists a rotated pair on the response,
 *   3. /admin/* guard: guests go to /admin/login, signed-in non-admins to /admin/access-denied,
 *   4. `/` goes to /admin.
 * Static security headers (CSP and friends) come from next.config.ts.
 */

const ADMIN_HOME = '/admin'
const ADMIN_LOGIN_PAGE = '/admin/login'
const ACCESS_DENIED_PAGE = '/admin/access-denied'
/** Vercel cron path: authenticated by the CRON_SECRET bearer in the route, never by a session. */
const SECURITY_DIGEST_CRON_PATH = '/api/admin/cron/security-digest'

type Session = { access_token: string; refresh_token: string; expires_in?: number }

interface ProxyUser {
  id: string
  app_metadata: Record<string, unknown>
}

function passThrough(request: NextRequest, requestId: string): NextResponse {
  const headers = new Headers(request.headers)
  headers.set(REQUEST_ID_HEADER, requestId)
  const response = NextResponse.next({ request: { headers } })
  response.headers.set(REQUEST_ID_HEADER, requestId)
  return response
}

function withSession(response: NextResponse, session: Session | null): NextResponse {
  return session ? setSessionCookies(response, session) : response
}

export async function proxy(request: NextRequest) {
  const requestId = resolveRequestId(request)
  const response = await routeRequest(request, requestId)
  if (!response.headers.has(REQUEST_ID_HEADER)) {
    response.headers.set(REQUEST_ID_HEADER, requestId)
  }
  return response
}

async function resolveUser(
  request: NextRequest,
  supabaseUrl: string,
  supabaseAnonKey: string
): Promise<{ user: ProxyUser | null; session: Session | null; accessToken: string | null }> {
  const accessToken = request.cookies.get('sb-access-token')?.value ?? null
  const refreshToken = request.cookies.get('sb-refresh-token')?.value ?? null
  if (!accessToken && !refreshToken) return { user: null, session: null, accessToken: null }

  const supabase = createClient(supabaseUrl, supabaseAnonKey, { auth: { persistSession: false } })

  if (accessToken) {
    try {
      const { data, error } = await supabase.auth.getClaims(accessToken)
      const claims = data?.claims
      if (!error && claims?.sub && typeof claims.sub === 'string') {
        return {
          user: { id: claims.sub, app_metadata: (claims.app_metadata as Record<string, unknown>) || {} },
          session: null,
          accessToken,
        }
      }
    } catch (err) {
      console.error('[proxy] auth verification error:', err)
    }
  }

  if (refreshToken) {
    try {
      const { data, error } = await supabase.auth.refreshSession({ refresh_token: refreshToken })
      if (!error && data?.session && data?.user) {
        return {
          user: { id: data.user.id, app_metadata: (data.user.app_metadata as Record<string, unknown>) || {} },
          session: data.session,
          accessToken: data.session.access_token,
        }
      }
    } catch (err) {
      console.error('[proxy] refresh session error:', err)
    }
  }
  return { user: null, session: null, accessToken: null }
}

/**
 * Admin status: the signed `app_metadata.is_admin` claim first (no DB call), else the
 * `users.is_admin` row read with the user's own token (RLS lets a user read their own row).
 * Fails closed. Email addresses never grant admin.
 */
async function isAdmin(user: ProxyUser, accessToken: string | null, supabaseUrl: string, supabaseAnonKey: string) {
  if (user.app_metadata?.is_admin === true) return true
  if (!accessToken) return false
  try {
    const client = createClient(supabaseUrl, supabaseAnonKey, {
      global: { headers: { Authorization: `Bearer ${accessToken}` } },
      auth: { persistSession: false },
    })
    const { data, error } = await client.from('users').select('is_admin').eq('id', user.id).maybeSingle()
    if (error) {
      console.error('[proxy] admin lookup error:', { userId: user.id, code: error.code })
      return false
    }
    return (data as { is_admin?: boolean } | null)?.is_admin === true
  } catch (err) {
    console.error('[proxy] admin lookup error:', err)
    return false
  }
}

async function routeRequest(request: NextRequest, requestId: string): Promise<NextResponse> {
  const path = request.nextUrl.pathname
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL || 'https://mock.supabase.co'
  const supabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || 'mock-anon-key'

  const isApiRoute = path.startsWith('/api/')
  if (isApiRoute && !isAllowedApiOrigin(request, path)) {
    return NextResponse.json(
      { success: false, error: 'Cross-origin request forbidden.', code: 'FORBIDDEN', requestId },
      { status: 403, headers: { [REQUEST_ID_HEADER]: requestId } }
    )
  }

  if (path === '/') {
    return NextResponse.redirect(new URL(ADMIN_HOME, request.url))
  }

  // /api/auth/* manages the session itself.
  if (path.startsWith('/api/auth/')) return passThrough(request, requestId)

  // The client error beacon must reach its route without a session: a crashed page
  // (the login page, an expired session) still reports. The same-origin check above
  // still applies; the route rate limits and attributes the report itself.
  if (path === '/api/client-errors') return passThrough(request, requestId)

  // The security digest cron carries no session: Vercel calls it with
  // `Authorization: Bearer ${CRON_SECRET}`, and the route's cron actor refuses any
  // request without that secret (401). No session is read or refreshed for it.
  if (path === SECURITY_DIGEST_CRON_PATH) return passThrough(request, requestId)

  const isAdminApi = path.startsWith('/api/admin/')
  const isAdminArea = path === ADMIN_HOME || path.startsWith(`${ADMIN_HOME}/`)
  if (!isAdminApi && !isAdminArea) return passThrough(request, requestId)

  if (path === ACCESS_DENIED_PAGE) return passThrough(request, requestId)

  const { user, session, accessToken } = await resolveUser(request, supabaseUrl, supabaseAnonKey)

  // Admin APIs authorize the caller themselves (withRoute admin policy) and answer their own
  // 401/403. The proxy only persists a refreshed token pair for them.
  if (isAdminApi) return withSession(passThrough(request, requestId), session)

  if (path === ADMIN_LOGIN_PAGE) {
    if (!user) return passThrough(request, requestId)
    const target = (await isAdmin(user, accessToken, supabaseUrl, supabaseAnonKey)) ? ADMIN_HOME : ACCESS_DENIED_PAGE
    return withSession(NextResponse.redirect(new URL(target, request.url)), session)
  }

  if (!user) {
    const response = NextResponse.redirect(new URL(ADMIN_LOGIN_PAGE, request.url))
    response.cookies.delete('sb-access-token')
    response.cookies.delete('sb-refresh-token')
    return response
  }

  if (!(await isAdmin(user, accessToken, supabaseUrl, supabaseAnonKey))) {
    return withSession(NextResponse.redirect(new URL(ACCESS_DENIED_PAGE, request.url)), session)
  }

  return withSession(passThrough(request, requestId), session)
}

export const config = {
  matcher: [
    // Everything except static assets and files with an extension (robots.txt, favicon.ico).
    '/((?!_next/static|_next/image|brand/|[^/]*\\.[^/]*$).*)',
  ],
}
