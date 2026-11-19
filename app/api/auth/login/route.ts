import { NextResponse } from 'next/server'
import { z } from 'zod'
import { withRoute } from '@/lib/api/with-route'
import { createServiceRoleClient } from '@/lib/supabase'
import { isAdminUser } from '@/lib/admin/authorization'
import { AUTH_SERVICE_UNAVAILABLE_MESSAGE } from '@/lib/errors/api-response'
import { evaluatePersistentRateLimit } from '@/lib/rate-limit'
import { getClientIpBucket } from '@/lib/security/client-ip'
import { log } from '@/lib/monitoring/log'
import { setSessionCookies } from '@/lib/auth/session-cookies'
import { recordSecurityEvent } from '@/lib/security/security-events'

export const runtime = 'nodejs'

/**
 * POST /api/auth/login (admin console copy)
 *
 * Admin split: this host only signs in administrators. It is the web repo's password login with
 * every learner branch removed (no signup, no Google OAuth, no email auto-confirm, no profile
 * creation, no referral or onboarding redirect), plus one rule the learner copy does not have:
 * after the password check, a non-admin account is signed out at the provider and refused with
 * 403 AUTH_NOT_ADMIN, and no session cookie is ever written for it.
 *
 * Session cookies are host-only (no Domain attribute, see lib/auth/session-cookies.ts), so an
 * admin session on the admin host is never sent to the learner site and the reverse.
 */

const loginSchema = z.object({
  email: z.string().min(1, 'Email is required.').email('Please enter a valid email address.').trim().toLowerCase(),
  password: z.string().min(1, 'Password is required.'),
})

// Same abuse controls as the learner login: per IP and per email, fail closed.
const IP_LOGIN_LIMIT = { windowMs: 15 * 60 * 1000, limit: 10, failClosed: true }
const EMAIL_LOGIN_LIMIT = { windowMs: 15 * 60 * 1000, limit: 5, failClosed: true }

const LOGIN_PATH = '/api/auth/login'

const NOT_ADMIN_MESSAGE = 'This account does not have administrator access.'

function canonicalizeEmailForLogin(email: string): string {
  const [local, domain] = email.toLowerCase().split('@')
  if (!domain) return email.toLowerCase()
  if (domain === 'gmail.com' || domain === 'googlemail.com') {
    return `${local.split('+')[0]}@${domain}`
  }
  return `${local}@${domain}`
}

export const POST = withRoute(
  {
    actor: { allow: ['anonymous'] },
    operation: 'auth.login',
    domain: 'auth',
    summary: 'Unexpected failure while signing an administrator in',
    errorMessage: AUTH_SERVICE_UNAVAILABLE_MESSAGE,
    errorCode: 'SERVER_ERROR',
    body: loginSchema,
  },
  async ({ request, body }) => {
    const { email, password } = body

    const clientIp = getClientIpBucket(request)
    const canonicalEmail = canonicalizeEmailForLogin(email)
    const [ipLimit, emailLimit] = await Promise.all([
      evaluatePersistentRateLimit(`admin_login_ip:${clientIp}`, IP_LOGIN_LIMIT),
      evaluatePersistentRateLimit(`admin_login_email:${canonicalEmail}`, EMAIL_LOGIN_LIMIT),
    ])
    if (!ipLimit.success || !emailLimit.success) {
      recordSecurityEvent('admin_login_rate_limited', { app: 'admin', ipBucket: clientIp, subject: canonicalEmail, path: LOGIN_PATH })
      return NextResponse.json(
        {
          success: false,
          error: 'Too many login attempts. Please wait a while before trying again.',
          code: 'AUTH_RATE_LIMITED',
          resetInMs: Math.max(ipLimit.resetInMs, emailLimit.resetInMs),
        },
        { status: 429 }
      )
    }

    // Two service-role clients on purpose (SEC-07): `authClient` holds the signed-in session,
    // `supabase` never does, so the admin lookup below runs as service_role.
    const authClient = createServiceRoleClient()
    const supabase = createServiceRoleClient()

    const { data: authData, error: authError } = await authClient.auth.signInWithPassword({ email, password })

    if (authError || !authData?.session || !authData?.user) {
      const unconfirmed = Boolean(
        authError &&
          (authError.code === 'email_not_confirmed' || authError.message.toLowerCase().includes('email not confirmed'))
      )
      // Wrong password, unknown account and unconfirmed account all count as a failed attempt.
      recordSecurityEvent('admin_login_failed', { app: 'admin', ipBucket: clientIp, subject: canonicalEmail, path: LOGIN_PATH })
      if (unconfirmed) {
        return NextResponse.json(
          { success: false, error: 'Please verify your email address before logging in.', code: 'AUTH_EMAIL_NOT_CONFIRMED' },
          { status: 403 }
        )
      }
      return NextResponse.json(
        {
          success: false,
          error: 'Invalid email or password. Please check your credentials and try again.',
          code: 'AUTH_INVALID_CREDENTIALS',
        },
        { status: 401 }
      )
    }

    // Authorization: users.is_admin is the only source of admin status (fail closed).
    let authorized = false
    try {
      authorized = await isAdminUser(supabase, authData.user.id)
    } catch (err) {
      log.warnException('auth.admin_login.admin_check_failed', err)
      authorized = false
    }

    if (!authorized) {
      // End the session that the password check just created, so a refused login leaves nothing
      // valid behind. Best effort: no cookie is written either way.
      try {
        await authClient.auth.signOut({ scope: 'local' })
      } catch (err) {
        log.warnException('auth.admin_login.sign_out_failed', err)
      }
      log.warn('auth.admin_login.not_admin', { userId: authData.user.id })
      recordSecurityEvent('admin_login_non_admin', { app: 'admin', ipBucket: clientIp, subject: canonicalEmail, path: LOGIN_PATH })
      return NextResponse.json(
        { success: false, error: NOT_ADMIN_MESSAGE, code: 'AUTH_NOT_ADMIN', redirect: '/admin/access-denied' },
        { status: 403 }
      )
    }

    // A browser caller never receives the tokens in the body (F-SEC-8 / B13-A): httpOnly cookies only.
    const response = NextResponse.json({
      success: true,
      user: { id: authData.user.id, email: authData.user.email },
      redirect: '/admin',
    })
    setSessionCookies(response, authData.session)
    return response
  }
)
