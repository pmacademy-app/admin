import Link from 'next/link'

export default function NotFound() {
  return (
    <div className="admin-console min-h-screen bg-admin-bg text-admin-fg flex items-center justify-center p-4">
      <div className="max-w-md w-full p-8 rounded-2xl bg-admin-surface border border-admin-border space-y-4 text-center">
        <h1 className="text-xl font-bold">Page not found</h1>
        <p className="text-sm text-admin-fg-muted">This page does not exist in the admin console.</p>
        <Link href="/admin" className="text-sm font-semibold text-admin-accent hover:underline">
          Back to the console
        </Link>
      </div>
    </div>
  )
}
