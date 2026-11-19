/**
 * Calendar-day helpers for the security summary.
 *
 * A "day" is a YYYY-MM-DD calendar date in the admin timezone (ADMIN_TIMEZONE,
 * default Asia/Kolkata). Its bounds are the UTC instants of local midnight at the
 * start and at the end, half open: [start, end).
 */

export const DEFAULT_ADMIN_TIMEZONE = 'Asia/Kolkata'

const DAY_PATTERN = /^\d{4}-\d{2}-\d{2}$/

function isValidTimezone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz })
    return true
  } catch {
    return false
  }
}

/** ADMIN_TIMEZONE when it names a real IANA zone, else Asia/Kolkata. */
export function getAdminTimezone(): string {
  const raw = process.env.ADMIN_TIMEZONE?.trim()
  return raw && isValidTimezone(raw) ? raw : DEFAULT_ADMIN_TIMEZONE
}

/** True for a real calendar date written as YYYY-MM-DD. */
export function isValidDay(value: unknown): value is string {
  if (typeof value !== 'string' || !DAY_PATTERN.test(value)) return false
  const [y, m, d] = value.split('-').map(Number)
  const date = new Date(Date.UTC(y, m - 1, d))
  return date.getUTCFullYear() === y && date.getUTCMonth() === m - 1 && date.getUTCDate() === d
}

/** Shifts a YYYY-MM-DD date by whole days (calendar arithmetic, no timezone involved). */
export function addDays(day: string, delta: number): string {
  const [y, m, d] = day.split('-').map(Number)
  const date = new Date(Date.UTC(y, m - 1, d + delta))
  return date.toISOString().slice(0, 10)
}

/** Offset of `tz` from UTC at `instantMs`, in milliseconds (positive east of UTC). */
function timezoneOffsetMs(instantMs: number, tz: string): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(new Date(instantMs))
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? 0)
  const asUtc = Date.UTC(get('year'), get('month') - 1, get('day'), get('hour') % 24, get('minute'), get('second'))
  return asUtc - Math.floor(instantMs / 1000) * 1000
}

/** UTC instant of local midnight at the start of `day` in `tz`. */
export function zonedDayStart(day: string, tz: string): Date {
  const [y, m, d] = day.split('-').map(Number)
  const guess = Date.UTC(y, m - 1, d)
  const firstOffset = timezoneOffsetMs(guess, tz)
  let start = guess - firstOffset
  // Second pass for zones whose offset differs between the guess and the answer (DST).
  const secondOffset = timezoneOffsetMs(start, tz)
  if (secondOffset !== firstOffset) start = guess - secondOffset
  return new Date(start)
}

/** Half-open UTC bounds of `day` in `tz`, as ISO strings. */
export function dayBounds(day: string, tz: string): { startIso: string; endIso: string } {
  return {
    startIso: zonedDayStart(day, tz).toISOString(),
    endIso: zonedDayStart(addDays(day, 1), tz).toISOString(),
  }
}

/** The calendar date of `instant` in `tz`. */
export function localDay(instant: Date, tz: string): string {
  // en-CA formats as YYYY-MM-DD.
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(instant)
}

/** Yesterday in `tz`: the day the nightly job summarizes. */
export function previousDay(now: Date, tz: string): string {
  return addDays(localDay(now, tz), -1)
}
