import type { DigestSummary, Finding } from './types'

/** Upper bound for the webhook text. Most chat webhooks cap a message near 4000 chars. */
export const DIGEST_TEXT_MAX_CHARS = 3500

const TRUNCATION_NOTE = '\n(truncated, open /admin/security for the full summary)'

function formatChange(changePct: number | null): string {
  if (changePct === null) return 'new'
  if (changePct === 0) return 'flat'
  return `${changePct > 0 ? '+' : ''}${changePct}%`
}

/**
 * Plain-text version of a digest for the out-of-band webhook: headline, findings
 * as bullets, then the non-zero totals. Fixed templates only.
 */
export function buildDigestText(summary: DigestSummary, findings: Finding[]): string {
  const lines: string[] = [`Prodily security summary for ${summary.day} (${summary.timezone})`, summary.headline, '']

  if (findings.length > 0) {
    lines.push('Findings:')
    for (const f of findings) {
      lines.push(`- [${f.severity.toUpperCase()}] ${f.title}: ${f.detail}`)
      if (f.evidence.topIpBuckets.length > 0) {
        lines.push(`  Networks: ${f.evidence.topIpBuckets.map((e) => `${e.label} (${e.count})`).join(', ')}`)
      }
      if (f.evidence.maskedSubjects.length > 0) {
        lines.push(`  Accounts: ${f.evidence.maskedSubjects.map((e) => `${e.label} (${e.count})`).join(', ')}`)
      }
      for (const item of f.evidence.items?.slice(0, 5) ?? []) lines.push(`  * ${item}`)
    }
    lines.push('')
  }

  const nonZero = summary.totals.filter((t) => t.count > 0)
  if (nonZero.length > 0) {
    lines.push('Totals (vs 7-day average):')
    for (const t of nonZero) lines.push(`- ${t.type}: ${t.count} (avg ${t.avg7}, ${formatChange(t.changePct)})`)
  }
  lines.push(
    `Signups: ${summary.signups.count} (avg ${summary.signups.avg7}). Errors: ${summary.errors.total} (critical ${summary.errors.bySeverity.critical}).`
  )
  if (summary.dataGaps.length > 0) lines.push(`Incomplete data from: ${summary.dataGaps.join(', ')}`)

  const text = lines.join('\n')
  if (text.length <= DIGEST_TEXT_MAX_CHARS) return text
  return text.slice(0, DIGEST_TEXT_MAX_CHARS - TRUNCATION_NOTE.length) + TRUNCATION_NOTE
}

/** The once-a-day line sent for an empty day when SECURITY_DIGEST_SEND_EMPTY=true. */
export function buildEmptyDigestText(day: string): string {
  return `Prodily security summary for ${day}: no findings.`
}
