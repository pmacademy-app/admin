import type { NextConfig } from 'next'

const isProduction = process.env.NODE_ENV === 'production'

/**
 * The Supabase project origin, read at build time. Null when the variable is absent or
 * malformed; callers then fall back to the wider Supabase pattern so nothing breaks.
 */
function supabaseOrigin(): URL | null {
  try {
    const url = new URL(process.env.NEXT_PUBLIC_SUPABASE_URL || '')
    return url.protocol === 'https:' || url.protocol === 'http:' ? url : null
  } catch {
    return null
  }
}

const supabase = supabaseOrigin()

/**
 * Content-Security-Policy, the web repo's builder trimmed for the admin host: no Google
 * Analytics, Tag Manager or Turnstile (the admin login has no CAPTCHA). Vercel Web Analytics
 * posts to same-origin /_vercel, so 'self' covers it. 'unsafe-eval' is development only.
 */
function contentSecurityPolicy(): string {
  const supabaseConnect = supabase
    ? [supabase.origin, `${supabase.protocol === 'https:' ? 'wss' : 'ws'}://${supabase.host}`]
    : ['https://*.supabase.co', 'wss://*.supabase.co', 'https://*.supabase.in', 'wss://*.supabase.in']
  const devConnect = isProduction ? [] : ['ws:', 'http://localhost:*', 'http://127.0.0.1:*']

  const directives: Record<string, string[]> = {
    'default-src': ["'self'"],
    'script-src': [
      "'self'",
      "'unsafe-inline'",
      ...(isProduction ? [] : ["'unsafe-eval'", 'https://va.vercel-scripts.com']),
    ],
    'style-src': ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com'],
    'img-src': ["'self'", 'data:', 'blob:', 'https:'],
    'font-src': ["'self'", 'data:', 'https://fonts.gstatic.com'],
    // Email template previews render in a srcdoc iframe.
    'frame-src': ["'self'"],
    'connect-src': ["'self'", ...supabaseConnect, ...devConnect],
    'object-src': ["'none'"],
    'base-uri': ["'self'"],
    'form-action': ["'self'"],
    'frame-ancestors': ["'none'"],
  }
  return (
    Object.entries(directives)
      .map(([name, values]) => `${name} ${values.join(' ')}`)
      .join('; ') + ';'
  )
}

/** Remote image hosts for next/image: the Supabase project host, plus local hosts outside production. */
function imageRemotePatterns() {
  const patterns: Array<{ protocol: 'http' | 'https'; hostname: string }> = supabase
    ? [{ protocol: supabase.protocol === 'http:' ? 'http' : 'https', hostname: supabase.hostname }]
    : [
        { protocol: 'https', hostname: '**.supabase.co' },
        { protocol: 'https', hostname: '**.supabase.in' },
      ]
  if (!isProduction) {
    patterns.push({ protocol: 'http', hostname: '127.0.0.1' }, { protocol: 'http', hostname: 'localhost' })
  }
  return patterns
}

const nextConfig: NextConfig = {
  poweredByHeader: false,

  // React Compiler: automatic memoization of client components (babel-plugin-react-compiler).
  reactCompiler: true,

  images: {
    formats: ['image/avif', 'image/webp'],
    remotePatterns: imageRemotePatterns(),
  },

  turbopack: {
    root: process.cwd(),
  },

  // The lesson loader reads the content snapshot through fs at runtime, which the tracer cannot
  // see. Ship it with every server route so the curriculum pages work on Vercel.
  outputFileTracingIncludes: {
    '/**': ['./content/dist/**/*', './content/.ids/**/*'],
  },

  async headers() {
    return [
      {
        source: '/(.*)',
        headers: [
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'X-Frame-Options', value: 'DENY' },
          { key: 'X-XSS-Protection', value: '0' },
          { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
          { key: 'Strict-Transport-Security', value: 'max-age=63072000; includeSubDomains; preload' },
          { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=()' },
          { key: 'X-Robots-Tag', value: 'noindex, nofollow' },
          { key: 'Content-Security-Policy', value: contentSecurityPolicy() },
        ],
      },
    ]
  },
}

export default nextConfig
