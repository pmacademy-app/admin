'use client'

import React from 'react'
import { XIcon } from 'lucide-react'
import { cn } from '@/lib/utils'
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog'

interface AdminModalProps {
  open: boolean
  onClose: () => void
  title: string
  description?: string
  children: React.ReactNode
  className?: string
}

/**
 * Accessible modal dialog shared across the admin panel, built on base-ui Dialog.
 *
 * - base-ui Dialog primitive provides focus trap, Escape dismissal, and focus restoration
 * - Labelled by DialogTitle and DialogDescription
 */
/**
 * Phones: dock to the bottom as a full-width sheet. `max-sm:` keeps these out of the
 * way of callers' own `max-w-*` / `p-*`, which still apply from 640px up.
 */
const PHONE_SHEET =
  'max-sm:top-auto max-sm:bottom-0 max-sm:left-0 max-sm:translate-x-0 max-sm:translate-y-0 max-sm:max-w-none max-sm:max-h-[92dvh] max-sm:rounded-b-none max-sm:rounded-t-3xl max-sm:p-5 max-sm:pb-[calc(1.25rem+env(safe-area-inset-bottom))]'

export function AdminModal({ open, onClose, title, description, children, className }: AdminModalProps) {
  return (
    <Dialog open={open} onOpenChange={(nextOpen) => !nextOpen && onClose()}>
      <DialogContent
        showCloseButton={false}
        className={cn('bg-admin-surface border border-admin-border rounded-2xl max-w-lg w-full max-h-[calc(100dvh-2rem)] overflow-y-auto p-6 shadow-2xl space-y-5 relative', PHONE_SHEET, className)}
      >
        <div className="flex items-center justify-between border-b border-admin-border pb-4">
          <div>
            <DialogTitle className="text-base font-bold text-admin-fg">
              {title}
            </DialogTitle>
            {description && (
              <DialogDescription className="text-xs text-admin-fg-muted mt-0.5">
                {description}
              </DialogDescription>
            )}
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="p-1.5 text-admin-fg-muted hover:text-admin-fg rounded-lg transition-colors cursor-pointer"
          >
            <XIcon className="w-5 h-5" />
          </button>
        </div>
        {children}
      </DialogContent>
    </Dialog>
  )
}