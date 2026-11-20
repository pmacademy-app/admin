import type { Metadata, Viewport } from 'next'
import { Inter, Plus_Jakarta_Sans } from 'next/font/google'
import { Analytics } from '@vercel/analytics/react'
import { BRAND } from '@/lib/brand'
import { ApiClientProvider } from '@/lib/api/hooks'
import '@/app/globals.css'

const inter = Inter({
  subsets: ['latin'],
  display: 'swap',
  variable: '--font-inter',
  preload: true,
})

// Wordmark only: the word "Prodily" beside the logo mark.
const wordmark = Plus_Jakarta_Sans({
  subsets: ['latin'],
  weight: '800',
  display: 'swap',
  variable: '--font-jakarta',
  preload: false,
})

function adminSiteUrl(): URL {
  try {
    return new URL(process.env.NEXT_PUBLIC_SITE_URL || 'http://localhost:3000')
  } catch {
    return new URL('http://localhost:3000')
  }
}

export const metadata: Metadata = {
  metadataBase: adminSiteUrl(),
  title: {
    default: `${BRAND.fullName} Admin`,
    template: `%s | ${BRAND.fullName} Admin`,
  },
  description: 'Operational control center for Prodily administrators.',
  icons: {
    icon: [
      { url: '/favicon.svg', type: 'image/svg+xml' },
      { url: '/favicon.ico', sizes: 'any' },
    ],
    apple: [{ url: '/apple-touch-icon.png', sizes: '180x180', type: 'image/png' }],
  },
  // Added to a phone home screen, the console opens full screen like an app.
  appleWebApp: {
    capable: true,
    title: 'Prodily Admin',
    statusBarStyle: 'default',
  },
  // The whole admin host stays out of search engines.
  robots: {
    index: false,
    follow: false,
    nocache: true,
    googleBot: { index: false, follow: false, noimageindex: true },
  },
}

export const viewport: Viewport = {
  themeColor: '#FFFFFF',
  width: 'device-width',
  initialScale: 1,
  // Lets the app bar and tab bar pad themselves around the notch and home indicator.
  viewportFit: 'cover',
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${inter.variable} ${wordmark.variable}`} suppressHydrationWarning>
      <body>
        <ApiClientProvider>{children}</ApiClientProvider>
        {/* Vercel Web Analytics: cookieless, no identifiers. Collects nothing until enabled in Vercel. */}
        <Analytics />
      </body>
    </html>
  )
}
