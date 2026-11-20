import type { MetadataRoute } from 'next'

/** Lets an admin add the console to a phone home screen and open it full screen. */
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: 'Prodily Admin',
    short_name: 'Prodily Admin',
    description: 'Operational control center for Prodily administrators.',
    start_url: '/admin',
    scope: '/',
    display: 'standalone',
    background_color: '#F8FAFC',
    theme_color: '#FFFFFF',
    icons: [
      { src: '/favicon.svg', sizes: 'any', type: 'image/svg+xml' },
      { src: '/apple-touch-icon.png', sizes: '180x180', type: 'image/png' },
    ],
  }
}
