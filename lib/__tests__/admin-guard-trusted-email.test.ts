import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type { User, SupabaseClient } from '@supabase/supabase-js'
import { requireAdminUser } from '../admin/guard'
import * as authModule from '../auth'
import * as supabaseModule from '../supabase'
import type { Database } from '@/lib/supabase'

/**
 * Security regression: the admin guard grants access only from the users.is_admin database
 * flag. No email address, whether from the verified auth session or from `public.users.email`
 * (which a signed-in learner can edit), ever grants admin access.
 */

function authUser(id: string, email: string): User {
  return {
    id,
    email,
    app_metadata: {},
    user_metadata: {},
    aud: 'authenticated',
    created_at: new Date().toISOString(),
  }
}

function serviceClient(row: { is_admin: boolean; email: string }) {
  return {
    from: () => ({
      select: () => ({ eq: () => ({ single: async () => ({ data: row, error: null }) }) }),
      insert: async () => ({ error: null }),
    }),
  } as unknown as SupabaseClient<Database>
}

describe('requireAdminUser ignores emails entirely', () => {
  const originalEnv = process.env.ADMIN_EMAILS

  beforeEach(() => {
    vi.restoreAllMocks()
  })

  afterEach(() => {
    vi.restoreAllMocks()
    // Restore the legacy env var exactly; tests below set it to prove it is ignored.
    if (originalEnv === undefined) delete process.env.ADMIN_EMAILS
    else process.env.ADMIN_EMAILS = originalEnv
  })

  it('denies a learner whose users.email was rewritten to an admin address', async () => {
    vi.spyOn(authModule, 'getAuthenticatedUserFromRequest').mockResolvedValue(
      authUser('usr-learner', 'learner@example.com')
    )
    vi.spyOn(supabaseModule, 'createServiceRoleClient').mockReturnValue(
      serviceClient({ is_admin: false, email: 'boss@example.com' })
    )

    const result = await requireAdminUser(new Request('http://localhost:3000/api/admin/summary'))

    expect(result.authorized).toBe(false)
    expect(result.statusCode).toBe(403)
  })

  it('denies a case-variant of an admin address written to users.email', async () => {
    vi.spyOn(authModule, 'getAuthenticatedUserFromRequest').mockResolvedValue(
      authUser('usr-learner', 'learner@example.com')
    )
    vi.spyOn(supabaseModule, 'createServiceRoleClient').mockReturnValue(
      serviceClient({ is_admin: false, email: 'Boss@Example.com' })
    )

    const result = await requireAdminUser(new Request('http://localhost:3000/api/admin/users'))

    expect(result.authorized).toBe(false)
  })

  it('denies a former env-admin email whose users.is_admin is false', async () => {
    // The legacy variable is set to this exact address: the old code would have let it in.
    process.env.ADMIN_EMAILS = 'admin@prodily.app'
    vi.spyOn(authModule, 'getAuthenticatedUserFromRequest').mockResolvedValue(
      authUser('usr-boss', 'admin@prodily.app')
    )
    vi.spyOn(supabaseModule, 'createServiceRoleClient').mockReturnValue(
      serviceClient({ is_admin: false, email: 'admin@prodily.app' })
    )

    const result = await requireAdminUser(new Request('http://localhost:3000/api/admin/summary'))

    expect(result.authorized).toBe(false)
    expect(result.statusCode).toBe(403)
  })

  it('allows a database is_admin admin regardless of email', async () => {
    vi.spyOn(authModule, 'getAuthenticatedUserFromRequest').mockResolvedValue(
      authUser('usr-db-admin', 'dbadmin@example.com')
    )
    vi.spyOn(supabaseModule, 'createServiceRoleClient').mockReturnValue(
      serviceClient({ is_admin: true, email: 'stale-profile@example.com' })
    )

    const result = await requireAdminUser(new Request('http://localhost:3000/api/admin/summary'))

    expect(result.authorized).toBe(true)
    expect(result.userId).toBe('usr-db-admin')
    expect(result.email).toBe('dbadmin@example.com')
  })
})

// Admin split: the 20261017000001 migration static check stays in the web repo, which owns
// supabase/migrations.
