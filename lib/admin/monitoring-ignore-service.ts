import { createServiceRoleClient } from '@/lib/supabase'
import { PublicError } from '@/lib/errors/public-error'
import {
  IGNORED_FINGERPRINTS_SETTING_KEY,
  MAX_IGNORED_FINGERPRINTS,
  invalidateIgnoredFingerprintsCache,
  parseIgnoredFingerprints,
} from '@/lib/monitoring/logger'

/**
 * The monitoring ignore list (contract C), as the admin console reads and writes it.
 *
 * Stored in `system_settings` under `monitoring_ignored_fingerprints` as a JSON array
 * of fingerprint strings, at most 500. The logger in both apps reads the same key:
 * an ignored fingerprint is still recorded (the occurrence count stays honest) but
 * never alerts. The console hides ignored groups from the default Errors list.
 *
 * Unlike the logger, which fails open, these reads throw: the console must not show
 * an empty list as "nothing ignored" when the setting could not be read, and a
 * write must not replace a list it failed to load.
 */

type SupabaseClient = ReturnType<typeof createServiceRoleClient>

/** Reads the current list. Throws when the setting cannot be read. */
export async function readIgnoredFingerprints(supabase: SupabaseClient = createServiceRoleClient()): Promise<string[]> {
  const { data, error } = await supabase
    .from('system_settings')
    .select('value')
    .eq('key', IGNORED_FINGERPRINTS_SETTING_KEY)
    .maybeSingle()
  if (error) throw new Error(error.message || 'ignore list read failed')
  return parseIgnoredFingerprints((data as { value?: unknown } | null)?.value)
}

export interface IgnoreListUpdate {
  fingerprints: string[]
  /** False when the fingerprint was already in the requested state. */
  changed: boolean
}

/**
 * Adds or removes one fingerprint and writes the list back.
 *
 * Read-modify-write on a single row. Two admins editing within the same instant can
 * lose one edit; at this volume (a handful of operators, rare edits) that is
 * accepted over a migration for an atomic array operation.
 *
 * @throws PublicError (409) when adding would exceed the 500-entry cap.
 */
export async function setFingerprintIgnored(fingerprint: string, ignored: boolean): Promise<IgnoreListUpdate> {
  const supabase = createServiceRoleClient()
  const current = await readIgnoredFingerprints(supabase)
  const present = current.includes(fingerprint)

  if (ignored === present) return { fingerprints: current, changed: false }

  if (ignored && current.length >= MAX_IGNORED_FINGERPRINTS) {
    throw new PublicError(
      `The ignore list is full (${MAX_IGNORED_FINGERPRINTS} entries). Unignore an error group first.`,
      { status: 409, code: 'IGNORE_LIST_FULL' }
    )
  }

  const next = ignored ? [...current, fingerprint] : current.filter((entry) => entry !== fingerprint)

  type Upsert = { upsert: (row: unknown) => PromiseLike<{ error: { message?: string } | null }> }
  const { error } = await (supabase.from('system_settings') as unknown as Upsert).upsert({
    key: IGNORED_FINGERPRINTS_SETTING_KEY,
    value: next,
    updated_at: new Date().toISOString(),
  })
  if (error) throw new Error(error.message || 'ignore list write failed')

  // This instance stops alerting at once; other instances pick it up within 60 s.
  invalidateIgnoredFingerprintsCache()
  return { fingerprints: next, changed: true }
}
