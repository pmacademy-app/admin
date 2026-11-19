/**
 * A recording Supabase stand-in for the monitoring tests.
 *
 * Every `from(table)` chain is captured as a `RecordedQuery` (operation, payload,
 * filters, ordering, select list) and answered by the `respond` callback the test
 * supplies, so a test can script exactly what the database returns and then assert
 * on exactly what was written. No network, no shared state between tests.
 */

export interface RecordedQuery {
  table: string
  op: 'select' | 'insert' | 'update' | 'upsert' | 'delete'
  columns?: string
  payload?: unknown
  filters: Array<{ column: string; op: string; value: unknown }>
  order: Array<{ column: string; ascending: boolean }>
  limit?: number
  range?: [number, number]
  single?: 'single' | 'maybeSingle'
  head?: boolean
}

export interface QueryResult {
  data?: unknown
  error?: { message: string; code?: string } | null
  count?: number | null
}

export type Responder = (query: RecordedQuery) => QueryResult | Promise<QueryResult>

class RecordingBuilder implements PromiseLike<QueryResult> {
  constructor(
    private readonly query: RecordedQuery,
    private readonly respond: Responder,
    private readonly calls: RecordedQuery[]
  ) {}

  select(columns = '*', options?: { count?: string; head?: boolean }): this {
    this.query.columns = columns
    if (options?.head) this.query.head = true
    return this
  }
  insert(payload: unknown): this {
    this.query.op = 'insert'
    this.query.payload = payload
    return this
  }
  update(payload: unknown): this {
    this.query.op = 'update'
    this.query.payload = payload
    return this
  }
  upsert(payload: unknown): this {
    this.query.op = 'upsert'
    this.query.payload = payload
    return this
  }
  delete(): this {
    this.query.op = 'delete'
    return this
  }
  private filter(op: string, column: string, value: unknown): this {
    this.query.filters.push({ column, op, value })
    return this
  }
  eq(column: string, value: unknown) { return this.filter('eq', column, value) }
  neq(column: string, value: unknown) { return this.filter('neq', column, value) }
  gte(column: string, value: unknown) { return this.filter('gte', column, value) }
  lte(column: string, value: unknown) { return this.filter('lte', column, value) }
  gt(column: string, value: unknown) { return this.filter('gt', column, value) }
  lt(column: string, value: unknown) { return this.filter('lt', column, value) }
  in(column: string, value: unknown) { return this.filter('in', column, value) }
  ilike(column: string, value: unknown) { return this.filter('ilike', column, value) }
  or(value: string) { return this.filter('or', '', value) }
  not(column: string, op: string, value: unknown) { return this.filter(`not.${op}`, column, value) }
  order(column: string, options?: { ascending?: boolean }): this {
    this.query.order.push({ column, ascending: options?.ascending !== false })
    return this
  }
  limit(n: number): this {
    this.query.limit = n
    return this
  }
  range(from: number, to: number): this {
    this.query.range = [from, to]
    return this
  }
  single(): this {
    this.query.single = 'single'
    return this
  }
  maybeSingle(): this {
    this.query.single = 'maybeSingle'
    return this
  }

  then<TResult1 = QueryResult, TResult2 = never>(
    onfulfilled?: ((value: QueryResult) => TResult1 | PromiseLike<TResult1>) | null,
    onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null
  ): PromiseLike<TResult1 | TResult2> {
    this.calls.push(this.query)
    return Promise.resolve()
      .then(() => this.respond(this.query))
      .then((result) => ({ data: null, error: null, count: null, ...result }))
      .then(onfulfilled, onrejected)
  }
}

export function createRecordingSupabase(respond: Responder) {
  const calls: RecordedQuery[] = []
  const client = {
    from(table: string) {
      return new RecordingBuilder({ table, op: 'select', filters: [], order: [] }, respond, calls)
    },
    rpc: async () => ({ data: null, error: { message: 'rpc not available in test' } }),
    auth: {
      admin: { listUsers: async () => ({ data: { users: [] }, error: null }) },
      getUser: async () => ({ data: { user: null }, error: null }),
    },
  }
  return { client, calls }
}

/** The value of an `eq` filter on a recorded query, if any. */
export function eqValue(query: RecordedQuery, column: string): unknown {
  return query.filters.find((f) => f.op === 'eq' && f.column === column)?.value
}
