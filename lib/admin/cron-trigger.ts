/**
 * Server-side trigger for the learner site's scheduled jobs (admin split).
 *
 * The cron routes live on the learner site and no longer accept the admin session cookie, so
 * the console calls them server to server: `POST ${LEARNER_SITE_URL}/api/cron/<name>` with
 * `Authorization: Bearer ${CRON_SECRET}`. The secret never reaches the browser.
 */

/** The learner cron jobs an admin may run on demand. */
export const LEARNER_CRON_JOBS = [
  { name: 'process-email-queue', label: 'Process Email Queue' },
  { name: 'retry-failed', label: 'Retry Failed Emails' },
  { name: 'daily-reminder', label: 'Daily Reminder' },
  { name: 'weekly-recap', label: 'Weekly Recap' },
  { name: 'cleanup', label: 'Cleanup' },
  { name: 'lifecycle', label: 'Lifecycle Emails' },
  { name: 'process-broadcasts', label: 'Process Broadcasts' },
] as const

export type LearnerCronName = (typeof LEARNER_CRON_JOBS)[number]['name']

export const LEARNER_CRON_NAMES: readonly LearnerCronName[] = LEARNER_CRON_JOBS.map((j) => j.name)

/** Generous: a queue run can take a while, but an admin request must not hang forever. */
export const CRON_TRIGGER_TIMEOUT_MS = 55_000

export function isLearnerCronName(value: unknown): value is LearnerCronName {
  return typeof value === 'string' && (LEARNER_CRON_NAMES as readonly string[]).includes(value)
}

/** The learner URL of a cron job, or null when LEARNER_SITE_URL is missing or invalid. */
export function learnerCronUrl(name: LearnerCronName): string | null {
  const raw = process.env.LEARNER_SITE_URL?.trim()
  if (!raw) return null
  try {
    const url = new URL(raw)
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return null
    return `${url.origin}/api/cron/${name}`
  } catch {
    return null
  }
}

export type CronTriggerResult =
  | { ok: true; status: number; body: unknown }
  | { ok: false; reason: 'not_configured' | 'unknown_job' | 'request_failed' | 'rejected'; status?: number; body?: unknown }

/**
 * The JSON body sent to each job. The learner cleanup route deletes rows when called with no
 * body and RETENTION_DELETE_ENABLED=true; an admin "run now" must be a dry run unless the
 * caller explicitly opts into deleting.
 */
export function cronRequestBody(name: LearnerCronName, options: { deleteRows?: boolean } = {}): string {
  if (name === 'cleanup') return JSON.stringify({ dryRun: options.deleteRows !== true })
  return '{}'
}

export async function triggerLearnerCron(
  name: string,
  options: { deleteRows?: boolean } = {}
): Promise<CronTriggerResult> {
  if (!isLearnerCronName(name)) return { ok: false, reason: 'unknown_job' }
  const url = learnerCronUrl(name)
  const secret = process.env.CRON_SECRET?.trim()
  if (!url || !secret) return { ok: false, reason: 'not_configured' }

  let res: Response
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: { Authorization: `Bearer ${secret}`, 'Content-Type': 'application/json' },
      body: cronRequestBody(name, options),
      cache: 'no-store',
      signal: AbortSignal.timeout(CRON_TRIGGER_TIMEOUT_MS),
    })
  } catch {
    return { ok: false, reason: 'request_failed' }
  }

  let body: unknown = null
  try {
    body = await res.json()
  } catch {
    body = null
  }
  if (!res.ok) return { ok: false, reason: 'rejected', status: res.status, body }
  return { ok: true, status: res.status, body }
}
