'use client'

import React, { useState } from 'react'
import { useRouter } from 'next/navigation'
import {
  Activity,
  ArrowRight,
  Eye,
  EyeOff,
  Loader2,
  Lock,
  Mail,
  MessagesSquare,
  ShieldAlert,
  ShieldCheck,
  Users,
} from 'lucide-react'
import { apiPost } from '@/lib/api/client'
import { BrandMarkProdily } from '@/components/brand/BrandLogo'
import { classifyAuthError, resolveApiAuthError } from '@/lib/auth/errors'
import { recordAuthTelemetry } from '@/lib/auth/telemetry'

/**
 * Admin Console login.
 *
 * This app has a SINGLE authentication system: this page authenticates the
 * user with the same Supabase account used for the learner side. After
 * authentication, authorization (users.is_admin database flag) is verified
 * server-side before routing:
 *   - authorized  -> /admin
 *   - unauthorized-> /admin/access-denied
 *
 * ## B13-A — the browser no longer authenticates
 *
 * This page used to call `supabase.auth.signInWithPassword()` on the browser client and
 * then POST the resulting session to `/api/auth/session` so the server could mirror it
 * into cookies. That is the bridge F-02 describes, and it meant the admin console's
 * tokens passed through JavaScript on their way to being "httpOnly".
 *
 * It now posts credentials to `POST /api/auth/login`, the same route the learner side
 * uses, which authenticates server-side and sets the cookies directly. The session never
 * exists in this page. Authorization is unchanged: `/api/admin/verify` still runs the
 * server-side RBAC guard (users.is_admin database flag) before the console opens, and
 * a successful login is not by itself admin access.
 *
 * Admin split: this host has its own login route, which refuses a non-admin account after
 * the password check (403 AUTH_NOT_ADMIN, session revoked, no cookies). The page then shows
 * the access denied screen. There is no Google sign-in and no signup here.
 */

/** What the console is for, shown beside the form on wide screens. */
const CAPABILITIES = [
  { icon: Users, title: 'Learners', body: 'Look up any account, progress, fellow status and proof.' },
  { icon: MessagesSquare, title: 'Inbox and email', body: 'Answer messages, send broadcasts, retry failed emails.' },
  { icon: ShieldAlert, title: 'Moderation', body: 'Review capstones, testimonials and feedback.' },
  { icon: Activity, title: 'System health', body: 'Errors, scheduled jobs and the daily security summary.' },
] as const

const RESET_PASSWORD_URL = 'https://prodily.app/reset-password'

export default function AdminLoginPage() {
  const router = useRouter()
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [showPassword, setShowPassword] = useState(false)
  const [capsLock, setCapsLock] = useState(false)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const handleAdminLogin = async (e: React.FormEvent) => {
    e.preventDefault()
    setLoading(true)
    setError(null)

    try {
      // Authenticate server-side. The response sets the httpOnly cookies and, for a
      // browser caller, carries no tokens at all.
      const result = await apiPost('/api/auth/login', { email: email.trim(), password })

      if (!result.ok && result.error.code === 'AUTH_NOT_ADMIN') {
        router.push('/admin/access-denied')
        router.refresh()
        return
      }

      if (!result.ok) {
        const classified = resolveApiAuthError(
          { error: result.error.message, code: result.error.code },
          'admin_login'
        )
        setError(classified.message)
        recordAuthTelemetry(classified, 'login')
        setLoading(false)
        return
      }

      // The admin login route only answers success for an administrator. The console layout
      // and the proxy still re-check users.is_admin on every request.
      router.push('/admin')
      router.refresh()
    } catch (err) {
      const classified = classifyAuthError(err, 'admin_login')
      setError(classified.message)
      recordAuthTelemetry(classified, 'login')
      setLoading(false)
    }
  }

  const onPasswordKey = (e: React.KeyboardEvent<HTMLInputElement>) => {
    setCapsLock(e.getModifierState?.('CapsLock') ?? false)
  }

  const fieldClass =
    'h-12 w-full rounded-xl border bg-admin-surface pl-11 text-base text-admin-fg placeholder:text-admin-fg-subtle shadow-xs transition-[border-color,box-shadow] focus:outline-none focus:border-admin-accent focus:ring-4 focus:ring-admin-accent/15 disabled:opacity-60 sm:text-sm'

  return (
    <div className="admin-console grid min-h-[100dvh] bg-admin-bg text-admin-fg antialiased selection:bg-admin-accent/30 selection:text-admin-accent lg:grid-cols-[minmax(0,1fr)_minmax(0,36rem)]">
      {/* Brand panel: wide screens only. Decorative shapes are aria-hidden. */}
      <aside className="relative hidden overflow-hidden bg-admin-accent text-white lg:flex lg:flex-col lg:justify-between lg:p-12 xl:p-16">
        <div aria-hidden="true" className="pointer-events-none absolute -right-24 -top-24 h-80 w-80 rounded-full bg-white/[0.07]" />
        <div aria-hidden="true" className="pointer-events-none absolute -bottom-32 -left-20 h-96 w-96 rounded-full bg-white/[0.05]" />

        <span className="relative self-start">
          <BrandMarkProdily size="md" onDark />
        </span>

        <div className="relative max-w-md space-y-8">
          <div className="space-y-3">
            <p className="text-xs font-semibold uppercase tracking-[0.14em] text-white/85">Admin console</p>
            <h2 className="text-3xl font-bold leading-tight tracking-tight text-balance xl:text-4xl">
              Run Prodily from your desk or your phone.
            </h2>
          </div>
          <ul className="space-y-5">
            {CAPABILITIES.map(({ icon: Icon, title, body }) => (
              <li key={title} className="flex gap-4">
                <span className="mt-0.5 flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-white/12">
                  <Icon className="h-5 w-5" aria-hidden="true" />
                </span>
                <span>
                  <span className="block font-semibold">{title}</span>
                  <span className="mt-0.5 block text-sm leading-relaxed text-white/85">{body}</span>
                </span>
              </li>
            ))}
          </ul>
        </div>

        <p className="relative flex items-center gap-2 text-sm text-white/85">
          <ShieldCheck className="h-4 w-4" aria-hidden="true" />
          Every action here is checked against your admin role and logged.
        </p>
      </aside>

      {/* Form column */}
      <main className="flex flex-col px-5 pt-[calc(2.5rem+env(safe-area-inset-top))] pb-[calc(2rem+env(safe-area-inset-bottom))] sm:items-center sm:justify-center sm:px-8 sm:py-12">
        <div className="w-full sm:max-w-sm">
          <div className="mb-8 flex flex-col items-start gap-6">
            <span className="lg:hidden">
              <BrandMarkProdily size="md" badgeText="Admin" onDark={false} />
            </span>
            <div className="space-y-2">
              <h1 className="text-[28px] font-bold leading-tight tracking-tight text-admin-fg">Sign in</h1>
              <p className="text-sm text-admin-fg-muted">
                Admin accounts only. Use the email and password of your Prodily account.
              </p>
            </div>
          </div>

          <form onSubmit={handleAdminLogin} className="space-y-5">
            <div className="space-y-1.5">
              <label htmlFor="admin-email" className="block text-sm font-medium text-admin-fg">
                Email
              </label>
              <div className="relative">
                <Mail className="pointer-events-none absolute left-4 top-1/2 h-4 w-4 -translate-y-1/2 text-admin-fg-subtle" aria-hidden="true" />
                <input
                  id="admin-email"
                  name="email"
                  type="email"
                  inputMode="email"
                  autoComplete="username"
                  autoCapitalize="none"
                  spellCheck={false}
                  required
                  disabled={loading}
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  placeholder="you@prodily.app"
                  aria-invalid={error ? true : undefined}
                  aria-describedby={error ? 'admin-login-error' : undefined}
                  className={`${fieldClass} pr-4 ${error ? 'border-admin-danger/60' : 'border-admin-border'}`}
                />
              </div>
            </div>

            <div className="space-y-1.5">
              <div className="flex items-center justify-between">
                <label htmlFor="admin-password" className="block text-sm font-medium text-admin-fg">
                  Password
                </label>
                <a
                  href={RESET_PASSWORD_URL}
                  className="rounded text-sm font-medium text-admin-accent hover:underline focus:outline-none focus-visible:ring-2 focus-visible:ring-admin-accent/40"
                >
                  Forgot password?
                </a>
              </div>
              <div className="relative">
                <Lock className="pointer-events-none absolute left-4 top-1/2 h-4 w-4 -translate-y-1/2 text-admin-fg-subtle" aria-hidden="true" />
                <input
                  id="admin-password"
                  name="password"
                  type={showPassword ? 'text' : 'password'}
                  autoComplete="current-password"
                  required
                  disabled={loading}
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  onKeyUp={onPasswordKey}
                  onKeyDown={onPasswordKey}
                  onBlur={() => setCapsLock(false)}
                  aria-invalid={error ? true : undefined}
                  aria-describedby={
                    [error ? 'admin-login-error' : '', capsLock ? 'admin-caps-lock' : ''].filter(Boolean).join(' ') || undefined
                  }
                  className={`${fieldClass} pr-12 ${error ? 'border-admin-danger/60' : 'border-admin-border'}`}
                />
                <button
                  type="button"
                  onClick={() => setShowPassword((v) => !v)}
                  aria-label={showPassword ? 'Hide password' : 'Show password'}
                  aria-pressed={showPassword}
                  aria-controls="admin-password"
                  className="absolute right-1.5 top-1/2 inline-flex size-10 -translate-y-1/2 items-center justify-center rounded-lg text-admin-fg-subtle transition-colors hover:bg-admin-surface-raised hover:text-admin-fg focus:outline-none focus-visible:ring-2 focus-visible:ring-admin-accent/40 cursor-pointer"
                >
                  {showPassword ? <EyeOff className="h-4 w-4" aria-hidden="true" /> : <Eye className="h-4 w-4" aria-hidden="true" />}
                </button>
              </div>
              {capsLock && (
                <p id="admin-caps-lock" className="text-xs font-medium text-admin-warning">
                  Caps Lock is on.
                </p>
              )}
            </div>

            <div aria-live="polite">
              {error && (
                <p
                  id="admin-login-error"
                  role="alert"
                  className="rounded-xl border border-admin-danger/25 bg-admin-danger-soft px-4 py-3 text-sm font-medium text-admin-danger"
                >
                  {error}
                </p>
              )}
            </div>

            <button
              type="submit"
              disabled={loading}
              className="flex h-12 w-full items-center justify-center gap-2 rounded-xl bg-admin-accent px-4 text-base font-semibold text-admin-accent-fg shadow-sm transition-[background-color,transform] hover:bg-admin-accent/90 active:translate-y-px focus:outline-none focus-visible:ring-4 focus-visible:ring-admin-accent/30 disabled:cursor-not-allowed disabled:opacity-70 sm:text-sm cursor-pointer"
            >
              {loading ? (
                <>
                  <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
                  Signing in...
                </>
              ) : (
                <>
                  Sign in
                  <ArrowRight className="h-4 w-4" aria-hidden="true" />
                </>
              )}
            </button>
          </form>

          <div className="mt-8 flex items-center justify-between gap-4 border-t border-admin-border pt-5 text-sm text-admin-fg-muted">
            <span className="flex items-center gap-1.5">
              <ShieldCheck className="h-4 w-4 text-admin-accent" aria-hidden="true" />
              Secure admin sign-in
            </span>
            <a
              href="https://prodily.app"
              className="rounded font-medium text-admin-fg hover:underline focus:outline-none focus-visible:ring-2 focus-visible:ring-admin-accent/40"
            >
              Go to prodily.app
            </a>
          </div>
        </div>
      </main>
    </div>
  )
}
