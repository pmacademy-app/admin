import { logErrorReport } from '@/lib/monitoring/logger'

/**
 * Records a failure that an admin route answers itself (a 500 or `failed: true`)
 * instead of letting it reach `withRoute`, which would have logged it.
 *
 * Several System routes catch their own errors to return admin-readable copy; before
 * this they did so without writing an incident, so the console's own failures never
 * showed up in the console. Never throws, so the response the route returns is the
 * same whether or not the write succeeds.
 */
export async function logAdminRouteFailure(options: {
  operation: string
  summary: string
  error: unknown
  requestId?: string
  userId?: string
}): Promise<void> {
  try {
    await logErrorReport(
      {
        domain: 'admin',
        kind: 'unexpected',
        operation: options.operation,
        summary: options.summary,
        requestId: options.requestId,
        ...(options.userId ? { subject: { userId: options.userId } } : {}),
        details: {
          error:
            options.error instanceof Error
              ? `${options.error.name}: ${options.error.message}`
              : String(options.error),
        },
      },
      { error: options.error }
    )
  } catch {
    // Instrumentation must not change the response.
  }
}
