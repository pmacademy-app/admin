#!/usr/bin/env node
/**
 * Re-copies the shared (non-admin) modules and the content snapshot from the web repo.
 *
 * Usage:
 *   npm run sync:web                 copy and report
 *   npm run sync:web -- --dry-run    report only
 *
 * The web repo is read from WEB_REPO_DIR (default: ../web next to this repo). Nothing in the
 * web repo is ever written.
 *
 * Rules:
 *   - Only files that already exist here AND under a shared root are synced. A new shared file
 *     is not pulled in automatically; the report lists imports that no longer resolve so it can
 *     be copied by hand.
 *   - Admin-owned files (the console, admin APIs, admin libs, tests, configs, this script) are
 *     never touched: after the split they belong to this repo.
 *   - Files modified for the split (PROTECTED below) are never overwritten. When the web copy
 *     changed since the split (its hash no longer matches scripts/sync-baseline.json) a warning
 *     is printed so the change can be merged by hand.
 *   - Every synced file gets the split transform: `process.env.NEXT_PUBLIC_SITE_URL` becomes
 *     `process.env.LEARNER_SITE_URL`, because in this repo NEXT_PUBLIC_SITE_URL is the admin host
 *     and learner-facing links (emails, certificates, portfolios) must point at the learner site.
 *   - Content: content/dist and content/.ids are mirrored from web/content. Files that exist
 *     here but no longer upstream are reported, not deleted.
 */
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const WEB_REPO = path.resolve(ROOT, process.env.WEB_REPO_DIR || '../web')
const WEB_APP = path.join(WEB_REPO, 'apps', 'web')
const WEB_CONTENT = path.join(WEB_REPO, 'content')
const DRY_RUN = process.argv.includes('--dry-run')
const BASELINE_FILE = path.join(ROOT, 'scripts', 'sync-baseline.json')

/** Directories (and single files) whose files are shared copies of the web app. */
export const SHARED_ROOTS = [
  'lib/',
  'components/',
  'emails/',
  'blocks/',
  'renderer/',
  'config/',
  'contexts/',
  'theme/',
  'types/',
  'eslint-rules/',
  'public/brand/',
  'instrumentation.ts',
]

/** Owned by this repo after the split: never synced. */
export const ADMIN_OWNED = [
  'components/admin/',
  'components/__tests__/',
  'lib/admin/',
  'lib/notifications/admin/',
  'lib/__tests__/',
  'lib/api/contracts/admin.ts',
  'emails/templates/admin/',
  'lib/learner-revalidate.ts',
  'lib/learner-url.ts',
]

/**
 * Shared files modified for the split. Never overwritten; a warning is printed when the web copy
 * changed since the split. Keep this list in step with the README.
 */
export const PROTECTED = [
  'lib/lesson-loader.ts', // content path: process.cwd()/content
  'lib/academy/lessons-db.ts', // content path: process.cwd()/content
  'lib/portfolio-revalidate.ts', // purges through revalidateLearner
  'lib/og/revalidate-capstone-cards.ts', // purges through revalidateLearner
  'lib/leaderboard-db.ts', // invalidateLeaderboardCache also calls revalidateLearner
  'lib/security/origin-check.ts', // canonical origin is the admin host
  'lib/auth/logout.ts', // no Quick Start, admin login fallback
  'lib/brand.ts', // siteUrl reads LEARNER_SITE_URL
  // Outside the shared roots, listed so upstream changes are still reported:
  'app/api/auth/login/route.ts', // admin-only login, refuses non-admins
  'app/api/auth/session/route.ts',
  'app/api/auth/refresh/route.ts',
  'app/api/auth/logout/route.ts',
  'vitest.setup.ts', // Turnstile env removed
  // Diverged when the web repo removed the admin console (web PR #103): web dropped the admin
  // actor and moved shared modules out of lib/admin (lib/settings, lib/broadcasts, lib/time ...).
  // The admin copies keep the admin actor and the lib/admin import paths, so these must never be
  // overwritten; a changed web copy is reported for a hand merge.
  'lib/api/actor.ts', // keeps the admin actor and requireAdminUser
  'lib/auth.ts',
  'lib/time.ts',
  'lib/xp/xp.ts',
  'lib/db/escape-like.ts',
  'lib/monitoring/logger.ts',
  'lib/notifications/queue/processor.ts',
  'lib/referral/referral-service.ts',
  'lib/flashcards-service.ts',
  'lib/certificates/presentation.ts',
  'lib/academy/module-completion.ts',
]

function sha(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex')
}

function splitTransform(rel, text) {
  if (rel === 'lib/security/origin-check.ts') return text
  return text.replace(/process\.env\.NEXT_PUBLIC_SITE_URL/g, 'process.env.LEARNER_SITE_URL')
}

const isUnder = (rel, list) => list.some((p) => (p.endsWith('/') ? rel.startsWith(p) : rel === p))

function walk(dir, base = dir) {
  if (!fs.existsSync(dir)) return []
  const out = []
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const abs = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name === '.next') continue
      out.push(...walk(abs, base))
    } else {
      out.push(path.relative(base, abs).split(path.sep).join('/'))
    }
  }
  return out
}

function writeFile(abs, data) {
  if (DRY_RUN) return
  fs.mkdirSync(path.dirname(abs), { recursive: true })
  fs.writeFileSync(abs, data)
}

function loadBaseline() {
  try {
    return JSON.parse(fs.readFileSync(BASELINE_FILE, 'utf8'))
  } catch {
    return {}
  }
}

function syncCode(report) {
  const baseline = loadBaseline()
  for (const rel of PROTECTED) {
    const upstream = path.join(WEB_APP, rel)
    if (!fs.existsSync(upstream)) {
      report.warnings.push(`${rel}: removed or moved in the web repo; check whether the admin copy still applies`)
      continue
    }
    // Line endings normalized so a CRLF or LF checkout of the same content gives the same hash.
    const hash = sha(fs.readFileSync(upstream, 'utf8').replace(/\r/g, ''))
    if (!baseline[rel]) {
      report.warnings.push(`${rel}: no baseline hash recorded; compare with the web copy by hand`)
    } else if (baseline[rel] !== hash) {
      report.warnings.push(`${rel}: changed in the web repo since the split; merge by hand (not overwritten)`)
    }
  }

  const localFiles = walk(ROOT).filter(
    (rel) => isUnder(rel, SHARED_ROOTS) && !isUnder(rel, ADMIN_OWNED) && !PROTECTED.includes(rel)
  )
  for (const rel of localFiles) {
    const upstream = path.join(WEB_APP, rel)
    if (!fs.existsSync(upstream)) {
      report.missingUpstream.push(rel)
      continue
    }
    const raw = fs.readFileSync(upstream)
    const isText = /\.(ts|tsx|js|mjs|cjs|json|css|md)$/.test(rel)
    const next = isText ? Buffer.from(splitTransform(rel, raw.toString('utf8')), 'utf8') : raw
    const local = fs.readFileSync(path.join(ROOT, rel))
    // Line endings alone are not a change (git may normalize them on checkout).
    const same = isText
      ? local.toString('utf8').replace(/\r\n/g, '\n') === next.toString('utf8').replace(/\r\n/g, '\n')
      : local.equals(next)
    if (!same) {
      report.changed.push(rel)
      writeFile(path.join(ROOT, rel), next)
    }
  }
}

function syncContent(report) {
  if (!fs.existsSync(WEB_CONTENT)) {
    report.warnings.push(`content: ${WEB_CONTENT} not found, snapshot not refreshed`)
    return
  }
  for (const sub of ['dist', '.ids']) {
    const from = path.join(WEB_CONTENT, sub)
    const to = path.join(ROOT, 'content', sub)
    const upstream = new Set(walk(from))
    for (const rel of upstream) {
      const src = fs.readFileSync(path.join(from, rel))
      const dst = path.join(to, rel)
      if (!fs.existsSync(dst) || !fs.readFileSync(dst).equals(src)) {
        report.changed.push(`content/${sub}/${rel}`)
        writeFile(dst, src)
      }
    }
    for (const rel of walk(to)) {
      if (!upstream.has(rel)) report.stale.push(`content/${sub}/${rel}`)
    }
  }
}

/** '@/...' imports in synced files that no longer resolve locally (a new shared dependency). */
function findUnresolved() {
  const exts = ['', '.ts', '.tsx', '.js', '.mjs', '.json', '/index.ts', '/index.tsx']
  const out = []
  const files = walk(ROOT).filter((rel) => /\.(ts|tsx)$/.test(rel) && !rel.startsWith('content/'))
  const patterns = [
    /^\s*(?:import|export)\b[^'"]*?from\s*['"]@\/([^'"]+)['"]/gm,
    /\bimport\(\s*['"]@\/([^'"]+)['"]\s*\)/g,
  ]
  for (const rel of files) {
    const src = fs.readFileSync(path.join(ROOT, rel), 'utf8')
    for (const m of patterns.flatMap((re) => [...src.matchAll(re)])) {
      if (!exts.some((e) => fs.existsSync(path.join(ROOT, m[1] + e)))) out.push(`${rel} -> @/${m[1]}`)
    }
  }
  return out
}

function main() {
  if (!fs.existsSync(WEB_APP)) {
    console.error(`[sync:web] web app not found at ${WEB_APP}. Set WEB_REPO_DIR to the web repo root.`)
    process.exit(1)
  }
  const report = { changed: [], warnings: [], missingUpstream: [], stale: [] }
  syncCode(report)
  syncContent(report)
  const unresolved = findUnresolved()

  const verb = DRY_RUN ? 'would change' : 'changed'
  console.log(`[sync:web] source: ${WEB_REPO}${DRY_RUN ? ' (dry run)' : ''}`)
  console.log(`[sync:web] ${report.changed.length} file(s) ${verb}`)
  for (const f of report.changed) console.log(`  ${verb}: ${f}`)
  for (const f of report.missingUpstream) console.log(`  not in web repo (kept): ${f}`)
  for (const f of report.stale) console.log(`  stale content (kept, delete by hand if unused): ${f}`)
  for (const w of report.warnings) console.warn(`  WARNING: ${w}`)
  for (const u of unresolved) console.warn(`  WARNING: unresolved import (copy it from the web repo): ${u}`)
  if (!DRY_RUN && report.changed.length > 0) {
    console.log('[sync:web] next: npx tsc --noEmit && npx eslint . && npx vitest run')
  }
}

main()
