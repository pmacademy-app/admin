import React from 'react'
import { ShieldAlert } from 'lucide-react'
import { BrandMarkProdily } from '@/components/brand/BrandLogo'
import { AccessDeniedActions } from '@/components/admin/AccessDeniedActions'

export const metadata = {
  title: 'Access Denied',
  description: 'Administrator privileges are required to access this area.',
}

export default function AccessDeniedPage() {
  return (
    <div className="admin-console flex min-h-[100dvh] flex-col bg-admin-bg px-5 pt-[calc(2.5rem+env(safe-area-inset-top))] pb-[calc(2rem+env(safe-area-inset-bottom))] text-admin-fg antialiased sm:items-center sm:justify-center sm:px-8 sm:py-12">
      <div className="w-full sm:max-w-sm">
        <BrandMarkProdily size="md" badgeText="Admin" onDark={false} />

        <div className="mt-8 space-y-4">
          <span className="flex h-12 w-12 items-center justify-center rounded-2xl border border-admin-danger/20 bg-admin-danger-soft text-admin-danger">
            <ShieldAlert className="h-6 w-6" aria-hidden="true" />
          </span>
          <h1 className="text-[28px] font-bold leading-tight tracking-tight">This account is not an admin</h1>
          <p className="text-sm leading-relaxed text-admin-fg-muted">
            You are signed in, but this account does not have admin access to the Prodily console.
          </p>
          <p className="text-sm leading-relaxed text-admin-fg-muted">
            If you need access, ask an existing Prodily admin to grant it to your account.
          </p>
        </div>

        <div className="mt-8 space-y-3">
          <AccessDeniedActions />
          <a
            href="https://prodily.app"
            className="flex h-12 w-full items-center justify-center rounded-xl border border-admin-border bg-admin-surface text-base font-semibold text-admin-fg transition-colors hover:bg-admin-surface-raised focus:outline-none focus-visible:ring-4 focus-visible:ring-admin-accent/20 sm:text-sm"
          >
            Go to prodily.app
          </a>
        </div>
      </div>
    </div>
  )
}
