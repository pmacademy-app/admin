/**
 * The narrow, structural view of a Supabase client that the security summary
 * needs. Structural on purpose: the tables are created by a held migration and
 * are not in the generated `types/database.ts` yet, and tests pass an in-memory
 * fake. Call sites cast the real client once (`asDigestDb`).
 */

export interface DigestDbError {
  code?: string
  message?: string
}

export interface DigestDbResult {
  data: unknown
  error: DigestDbError | null
  count?: number | null
}

export interface DigestQuery extends PromiseLike<DigestDbResult> {
  select(columns?: string, options?: { count?: 'exact'; head?: boolean }): DigestQuery
  eq(column: string, value: unknown): DigestQuery
  gte(column: string, value: unknown): DigestQuery
  lt(column: string, value: unknown): DigestQuery
  in(column: string, values: unknown[]): DigestQuery
  order(column: string, options?: { ascending?: boolean }): DigestQuery
  range(from: number, to: number): DigestQuery
  limit(count: number): DigestQuery
  maybeSingle(): DigestQuery
  upsert(values: Record<string, unknown>, options?: { onConflict?: string }): DigestQuery
}

export interface DigestDb {
  from(table: string): DigestQuery
}

export function asDigestDb(client: unknown): DigestDb {
  return client as DigestDb
}

const MISSING_RELATION_CODES = new Set(['42P01', 'PGRST205'])

/** True when the error says the table does not exist (migration not applied). */
export function isMissingRelationError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false
  const code = (error as DigestDbError).code
  return typeof code === 'string' && MISSING_RELATION_CODES.has(code)
}

export class MissingRelationError extends Error {
  readonly table: string
  constructor(table: string) {
    super(`Table ${table} does not exist yet`)
    this.name = 'MissingRelationError'
    this.table = table
  }
}

export class DigestQueryError extends Error {
  readonly table: string
  readonly code: string | null
  constructor(table: string, error: DigestDbError) {
    super(`Query on ${table} failed${error.code ? ` (${error.code})` : ''}`)
    this.name = 'DigestQueryError'
    this.table = table
    this.code = error.code ?? null
  }
}

/** Throws MissingRelationError / DigestQueryError for a failed result, else returns its rows. */
export function rowsOrThrow<T>(table: string, result: DigestDbResult): T[] {
  if (result.error) {
    if (isMissingRelationError(result.error)) throw new MissingRelationError(table)
    throw new DigestQueryError(table, result.error)
  }
  return Array.isArray(result.data) ? (result.data as T[]) : []
}

export const PAGE_SIZE = 1000
/** Hard cap so a runaway table cannot make the job unbounded (50k rows). */
export const MAX_PAGES = 50

/** Reads every page of a query (PostgREST caps a response at its max-rows setting). */
export async function fetchAllPages<T>(
  table: string,
  build: () => DigestQuery
): Promise<T[]> {
  const rows: T[] = []
  for (let page = 0; page < MAX_PAGES; page++) {
    const from = page * PAGE_SIZE
    const batch = rowsOrThrow<T>(table, await build().range(from, from + PAGE_SIZE - 1))
    rows.push(...batch)
    if (batch.length < PAGE_SIZE) break
  }
  return rows
}
