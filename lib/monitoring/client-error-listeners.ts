/**
 * Global browser error listeners.
 *
 * Error boundaries only see errors thrown while React renders. An exception in an
 * event handler, a timer or a rejected promise nobody awaited never reaches one, so
 * before these listeners it was invisible. They feed the same beacon as the
 * boundaries (same per-page cap of 5 and the same dedupe), with `source` set to
 * 'window.onerror' or 'unhandledrejection'.
 *
 * Noise that says nothing about our code is dropped before it is reported:
 *   - "ResizeObserver loop ..." warnings, which browsers raise as errors but are benign;
 *   - a cross-origin "Script error." with no stack, which carries no information;
 *   - anything whose source file or stack points at a browser extension.
 *
 * Installed once per page by the console shell. Installing again is a no-op, so a
 * remount or React's development double effect cannot attach a second pair.
 */

import { sendClientErrorReport } from './client-error-beacon'

const EXTENSION_URL = /(chrome|moz|safari|safari-web|ms-browser)-extension:\/\/|webkit-masked-url:\/\//i
const RESIZE_OBSERVER_NOISE = /ResizeObserver loop/i
const OPAQUE_SCRIPT_ERROR = /^(Uncaught )?Script error\.?$/i

export interface ClientErrorNoiseInput {
  message?: unknown
  filename?: unknown
  error?: unknown
}

function stackOf(error: unknown): string {
  if (error && typeof error === 'object') {
    const stack = (error as { stack?: unknown }).stack
    if (typeof stack === 'string') return stack
  }
  return ''
}

function messageOf(input: ClientErrorNoiseInput): string {
  if (typeof input.message === 'string' && input.message) return input.message
  if (input.error && typeof input.error === 'object') {
    const message = (input.error as { message?: unknown }).message
    if (typeof message === 'string') return message
  }
  return typeof input.error === 'string' ? input.error : ''
}

/** True for an error event that should not be reported. Exported for tests. */
export function isClientErrorNoise(input: ClientErrorNoiseInput): boolean {
  const message = messageOf(input)
  const stack = stackOf(input.error)
  const filename = typeof input.filename === 'string' ? input.filename : ''

  if (RESIZE_OBSERVER_NOISE.test(message)) return true
  if (OPAQUE_SCRIPT_ERROR.test(message.trim()) && !stack) return true
  if (EXTENSION_URL.test(filename) || EXTENSION_URL.test(stack)) return true
  return false
}

let uninstall: (() => void) | null = null

/**
 * Attaches the two listeners to `window`, once. Returns a function that removes
 * them; calling `installClientErrorListeners` again before that returns the same
 * function without attaching anything.
 */
export function installClientErrorListeners(): () => void {
  if (typeof window === 'undefined') return () => {}
  if (uninstall) return uninstall

  const onError = (event: ErrorEvent) => {
    try {
      const input = { message: event.message, filename: event.filename, error: event.error }
      if (isClientErrorNoise(input)) return
      sendClientErrorReport(event.error ?? event.message ?? 'Unknown error', { source: 'window.onerror' })
    } catch {
      // Never let reporting raise from inside an error handler.
    }
  }

  const onRejection = (event: PromiseRejectionEvent) => {
    try {
      const reason: unknown = event.reason
      if (isClientErrorNoise({ error: reason })) return
      sendClientErrorReport(reason ?? 'Unhandled promise rejection', { source: 'unhandledrejection' })
    } catch {
      // Never let reporting raise from inside an error handler.
    }
  }

  window.addEventListener('error', onError)
  window.addEventListener('unhandledrejection', onRejection)

  uninstall = () => {
    window.removeEventListener('error', onError)
    window.removeEventListener('unhandledrejection', onRejection)
    uninstall = null
  }
  return uninstall
}

/** Test hook: removes the listeners if they are attached. */
export function resetClientErrorListenersForTests(): void {
  uninstall?.()
}
