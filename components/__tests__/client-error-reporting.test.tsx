/**
 * @vitest-environment jsdom
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import * as React from 'react'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

import {
  CLIENT_ERROR_ENDPOINT,
  MAX_REPORTS_PER_PAGE,
  buildClientErrorPayload,
  reportClientError,
  resetClientErrorBeaconForTests,
  sendClientErrorReport,
} from '@/lib/monitoring/client-error-beacon'
import {
  installClientErrorListeners,
  isClientErrorNoise,
  resetClientErrorListenersForTests,
} from '@/lib/monitoring/client-error-listeners'

/**
 * Browser side of client error monitoring: the beacon (payload, cap, dedupe), the
 * global listeners (noise filter, installed once) and every error boundary reporting
 * through the beacon with source 'boundary'.
 */

const beacon = vi.fn<(url: string, body?: BodyInit | null) => boolean>(() => true)

async function sentPayloads(): Promise<Array<Record<string, unknown>>> {
  return Promise.all(
    beacon.mock.calls.map(async ([, body]) => JSON.parse(await (body as Blob).text()) as Record<string, unknown>)
  )
}

beforeEach(() => {
  beacon.mockClear()
  Object.defineProperty(navigator, 'sendBeacon', { value: beacon, configurable: true, writable: true })
  resetClientErrorBeaconForTests()
  resetClientErrorListenersForTests()
  window.history.replaceState({}, '', '/admin/users?token=secret#frag')
  vi.spyOn(console, 'error').mockImplementation(() => {})
})

afterEach(() => {
  resetClientErrorListenersForTests()
  vi.restoreAllMocks()
  delete process.env.NEXT_PUBLIC_VERCEL_GIT_COMMIT_SHA
})

describe('client error beacon', () => {
  it('posts message, path without query, source, boundary, stack and release', async () => {
    process.env.NEXT_PUBLIC_VERCEL_GIT_COMMIT_SHA = '0123456789abcdef0123'
    const error = new Error('render failed')
    reportClientError(error, 'admin')
    expect(beacon).toHaveBeenCalledTimes(1)
    expect(beacon.mock.calls[0][0]).toBe(CLIENT_ERROR_ENDPOINT)
    const [payload] = await sentPayloads()
    expect(payload).toMatchObject({
      message: 'render failed',
      path: '/admin/users',
      source: 'boundary',
      boundary: 'admin',
      release: '0123456789ab',
    })
    expect(String(payload.stack)).toContain('render failed')
    expect(JSON.stringify(payload)).not.toContain('secret')
  })

  it('omits release when the build has no commit SHA', () => {
    const payload = buildClientErrorPayload(new Error('x'), { source: 'window.onerror' }, '/admin')
    expect('release' in payload).toBe(false)
    expect('boundary' in payload).toBe(false)
  })

  it('deduplicates the same error and caps reports per page at 5', () => {
    const error = new Error('same')
    sendClientErrorReport(error, { source: 'window.onerror' })
    sendClientErrorReport(error, { source: 'window.onerror' })
    expect(beacon).toHaveBeenCalledTimes(1)

    for (let i = 0; i < 10; i += 1) {
      sendClientErrorReport(new Error(`distinct ${i}`), { source: 'unhandledrejection' })
    }
    expect(beacon).toHaveBeenCalledTimes(MAX_REPORTS_PER_PAGE)
  })

  it('falls back to fetch with keepalive when sendBeacon refuses', () => {
    beacon.mockReturnValueOnce(false)
    const fetchSpy = vi.fn(async () => new Response(null, { status: 204 }))
    vi.stubGlobal('fetch', fetchSpy)
    sendClientErrorReport(new Error('queued'), { source: 'window.onerror' })
    expect(fetchSpy).toHaveBeenCalledTimes(1)
    const [, init] = fetchSpy.mock.calls[0] as unknown as [string, RequestInit]
    expect(init.keepalive).toBe(true)
    vi.unstubAllGlobals()
  })
})

describe('global listeners', () => {
  it('filters ResizeObserver, opaque Script error. and extension noise', () => {
    expect(isClientErrorNoise({ message: 'ResizeObserver loop completed with undelivered notifications.' })).toBe(true)
    expect(isClientErrorNoise({ message: 'Script error.', error: null })).toBe(true)
    expect(isClientErrorNoise({ message: 'boom', filename: 'chrome-extension://abc/content.js' })).toBe(true)
    const extError = new Error('ext')
    extError.stack = 'Error: ext\n    at x (moz-extension://abc/inject.js:1:1)'
    expect(isClientErrorNoise({ error: extError })).toBe(true)
    expect(isClientErrorNoise({ message: 'x is undefined', error: new Error('x is undefined') })).toBe(false)
  })

  it('attaches the listeners only once, however often it is installed', () => {
    const add = vi.spyOn(window, 'addEventListener')
    const first = installClientErrorListeners()
    const second = installClientErrorListeners()
    expect(second).toBe(first)
    const types = add.mock.calls.map((call) => call[0]).filter((t) => t === 'error' || t === 'unhandledrejection')
    expect(types).toEqual(['error', 'unhandledrejection'])
  })

  it('reports window errors and unhandled rejections with their source, and skips noise', async () => {
    installClientErrorListeners()

    window.dispatchEvent(new ErrorEvent('error', { message: 'ResizeObserver loop limit exceeded' }))
    window.dispatchEvent(new ErrorEvent('error', { message: 'Script error.' }))
    expect(beacon).not.toHaveBeenCalled()

    window.dispatchEvent(new ErrorEvent('error', { message: 'x is undefined', error: new TypeError('x is undefined') }))
    const rejection = new Event('unhandledrejection') as Event & { reason?: unknown }
    Object.defineProperty(rejection, 'reason', { value: new Error('promise failed') })
    window.dispatchEvent(rejection)

    const payloads = await sentPayloads()
    expect(payloads.map((p) => p.source)).toEqual(['window.onerror', 'unhandledrejection'])
    expect(payloads[1].message).toBe('promise failed')
  })

  it('stops reporting after uninstall', () => {
    const uninstall = installClientErrorListeners()
    uninstall()
    window.dispatchEvent(new ErrorEvent('error', { message: 'after uninstall' }))
    expect(beacon).not.toHaveBeenCalled()
  })
})

describe('error boundaries report through the beacon', () => {
  let container: HTMLDivElement
  let root: Root

  beforeEach(() => {
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
  })

  afterEach(() => {
    act(() => root.unmount())
    container.remove()
  })

  const cases: Array<{ file: string; boundary: string; load: () => Promise<{ default: React.ComponentType<Record<string, unknown>> }> }> = [
    { file: 'app/error.tsx', boundary: 'root', load: () => import('@/app/error') as never },
    { file: 'app/admin/(console)/error.tsx', boundary: 'admin', load: () => import('@/app/admin/(console)/error') as never },
    {
      file: 'app/admin/(console)/communications/error.tsx',
      boundary: 'communications',
      load: () => import('@/app/admin/(console)/communications/error') as never,
    },
  ]

  for (const { file, boundary, load } of cases) {
    it(`${file} reports with source 'boundary' and boundary '${boundary}', and Try again calls retry`, async () => {
      const { default: Boundary } = await load()
      const retry = vi.fn()
      const error = Object.assign(new Error(`${boundary} crashed`), { digest: 'abc123' })
      await act(async () => {
        root.render(<Boundary error={error} retry={retry} reset={vi.fn()} />)
      })
      const [payload] = await sentPayloads()
      expect(payload).toMatchObject({ source: 'boundary', boundary, digest: 'abc123', message: `${boundary} crashed` })
      expect(container.textContent).toContain('abc123')

      const button = container.querySelector('button') as HTMLButtonElement
      await act(async () => button.click())
      expect(retry).toHaveBeenCalledTimes(1)
    })
  }

  it('app/global-error.tsx reports with boundary global', async () => {
    const { default: GlobalError } = await import('@/app/global-error')
    // global-error renders its own <html> and <body>. Mounting it in a container makes
    // React warn about the nesting, but it still runs the effect under test.
    const error = new Error('layout crashed')
    await act(async () => {
      root.render(<GlobalError error={error} retry={vi.fn()} />)
    })
    const payloads = await sentPayloads()
    expect(payloads.some((p) => p.boundary === 'global' && p.source === 'boundary')).toBe(true)
  })
})

describe('listener mounting', () => {
  it('the console shell installs the global listeners exactly once, in an effect', async () => {
    const { readFileSync } = await import('node:fs')
    const { join } = await import('node:path')
    const source = readFileSync(join(__dirname, '..', 'admin', 'AdminConsoleShell.tsx'), 'utf8')
    expect(source.match(/installClientErrorListeners\(\)/g)).toHaveLength(1)
    expect(source).toMatch(/useEffect\(\(\) => installClientErrorListeners\(\), \[\]\)/)
  })
})
