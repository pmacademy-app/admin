import type { MetadataRoute } from 'next'

/** The admin host is never crawled. */
export default function robots(): MetadataRoute.Robots {
  return {
    rules: [{ userAgent: '*', disallow: '/' }],
  }
}
