import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'

const requireAdminUser = vi.fn()
const logAdminAction = vi.fn()
const enqueueNotificationItem = vi.fn()
const createInAppNotification = vi.fn()
const callOrder: string[] = []

vi.mock('@/lib/admin/guard', () => ({
  requireAdminUser: (req: Request) => requireAdminUser(req),
  logAdminAction: (...args: unknown[]) => {
    callOrder.push(`audit:${String(args[2])}`)
    return logAdminAction(...args)
  },
}))

vi.mock('@/lib/notifications/queue/processor', () => ({
  enqueueNotificationItem: (params: unknown) => {
    callOrder.push('enqueue')
    return enqueueNotificationItem(params)
  },
  processEmailQueue: vi.fn(async () => undefined),
}))

vi.mock('@/lib/notifications/in-app/service', () => ({
  createInAppNotification: (params: unknown) => createInAppNotification(params),
}))

vi.mock('next/cache', () => ({ revalidatePath: vi.fn(), revalidateTag: vi.fn(), unstable_cache: (fn: unknown) => fn }))

let users: Array<{ id: string; email: string; name: string }> = []

vi.mock('@/lib/supabase', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/supabase')>()
  const builder = (table: string) => {
    const b: Record<string, unknown> = {
      select: () => b,
      eq: () => b,
      order: () => b,
      limit: () => b,
      maybeSingle: async () => ({ data: table === 'users' ? users[0] ?? null : null, error: null }),
      then: (resolve: (v: unknown) => unknown) => resolve({ data: table === 'users' ? users : [], error: null }),
    }
    return b
  }
  return { ...actual, createServiceRoleClient: () => ({ from: builder }) }
})

const { POST } = await import('../../app/api/admin/notifications/broadcast/route')

const ADMIN = { authorized: true, userId: 'admin-1', email: 'admin@prodily.app' }
let keyCounter = 0

function send(body: Record<string, unknown>) {
  return POST(
    new NextRequest('https://admin.prodily.app/api/admin/notifications/broadcast', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })
  )
}

function baseBody(overrides: Record<string, unknown> = {}) {
  keyCounter += 1
  return {
    audience: 'all',
    channel: 'both',
    subject: 'Hello',
    content: 'News',
    idempotencyKey: `bcast-1764000000000-test${keyCounter}`,
    ...overrides,
  }
}

beforeEach(() => {
  callOrder.length = 0
  users = [
    { id: 'u-1', email: 'one@example.com', name: 'One' },
    { id: 'u-2', email: 'two@example.com', name: 'Two' },
  ]
  requireAdminUser.mockReset().mockResolvedValue(ADMIN)
  logAdminAction.mockReset().mockResolvedValue(undefined)
  enqueueNotificationItem.mockReset().mockResolvedValue({ success: true })
  createInAppNotification.mockReset().mockResolvedValue({ success: true })
})

describe('Quick broadcast (POST /api/admin/notifications/broadcast)', () => {
  it('refuses a second send with the same key, so a double click cannot send twice', async () => {
    const body = baseBody()

    const first = await send(body)
    const second = await send(body)

    expect(first.status).toBe(200)
    expect(second.status).toBe(409)
    expect(enqueueNotificationItem).toHaveBeenCalledTimes(users.length)
    expect(createInAppNotification).toHaveBeenCalledTimes(users.length)
  })

  it('queues email as an opt-out-able product update with a per-recipient idempotency key', async () => {
    const body = baseBody({ channel: 'email' })

    await send(body)

    expect(enqueueNotificationItem).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: 'u-1',
        category: 'product_updates',
        priorityLevel: 'low',
        idempotencyKey: `admin-broadcast:${body.idempotencyKey}:u-1`,
      })
    )
    expect(enqueueNotificationItem).toHaveBeenCalledWith(
      expect.objectContaining({ userId: 'u-2', idempotencyKey: `admin-broadcast:${body.idempotencyKey}:u-2` })
    )
  })

  it('writes a started audit row before sending anything', async () => {
    await send(baseBody({ channel: 'email' }))

    expect(callOrder[0]).toBe('audit:notification_broadcast_started')
    expect(callOrder.indexOf('enqueue')).toBeGreaterThan(0)
    expect(callOrder.at(-1)).toBe('audit:notification_broadcast_sent')
  })

  it('uses the full key in the in-app event id, so two broadcasts never collide', async () => {
    const a = baseBody({ channel: 'in_app' })
    const b = baseBody({ channel: 'in_app' })

    await send(a)
    await send(b)

    const eventIds = createInAppNotification.mock.calls
      .map(([params]) => (params as { userId: string; eventId: string }))
      .filter((p) => p.userId === 'u-1')
      .map((p) => p.eventId)
    expect(new Set(eventIds).size).toBe(2)
  })

  it('refuses audiences larger than the direct-send limit before sending anything', async () => {
    users = Array.from({ length: 501 }, (_, i) => ({ id: `u-${i}`, email: `${i}@example.com`, name: `U${i}` }))

    const res = await send(baseBody())

    expect(res.status).toBe(400)
    expect(enqueueNotificationItem).not.toHaveBeenCalled()
    expect(createInAppNotification).not.toHaveBeenCalled()
    expect(logAdminAction).not.toHaveBeenCalled()
  })
})
