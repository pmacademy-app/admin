/**
 * Release tag for incident reports: the first 12 characters of the deployed commit.
 *
 * Vercel sets `VERCEL_GIT_COMMIT_SHA` on the server automatically. The browser only
 * sees `NEXT_PUBLIC_VERCEL_GIT_COMMIT_SHA`, which `next.config.ts` inlines at build
 * time (falling back to `VERCEL_GIT_COMMIT_SHA`), so both sides tag a report with the
 * same value. Undefined when neither is set, for example on a local build; callers
 * then omit the field rather than store an empty string.
 *
 * The `process.env.NEXT_PUBLIC_...` reference must stay literal: Next.js replaces that
 * exact expression in client bundles, and a computed lookup would not be inlined.
 */

export const RELEASE_LENGTH = 12

function shorten(value: string | undefined): string | undefined {
  const trimmed = value?.trim()
  return trimmed ? trimmed.slice(0, RELEASE_LENGTH) : undefined
}

/** Release for a report raised on the server. */
export function serverRelease(): string | undefined {
  return shorten(process.env.VERCEL_GIT_COMMIT_SHA) ?? shorten(process.env.NEXT_PUBLIC_VERCEL_GIT_COMMIT_SHA)
}

/** Release for a report raised in the browser. */
export function clientRelease(): string | undefined {
  return shorten(process.env.NEXT_PUBLIC_VERCEL_GIT_COMMIT_SHA)
}
