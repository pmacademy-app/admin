import React from 'react'
import { Inbox, ArrowUp, ArrowDown, ChevronsUpDown, ChevronRight } from 'lucide-react'
import { cn } from '@/lib/utils'

export interface Column<T> {
  header: string | React.ReactNode
  accessorKey?: keyof T | string
  cell?: (row: T) => React.ReactNode
  className?: string
  headerClassName?: string
  /** Renders the header as a sortable button. `sortKey` defaults to `accessorKey`. */
  sortable?: boolean
  sortKey?: string
  /** Leave this column out of the phone card view (e.g. a duplicate avatar column). */
  hideOnMobile?: boolean
}

export interface TableSort {
  key: string
  dir: 'asc' | 'desc'
}

export interface AdminDataTableProps<T> {
  columns: Column<T>[]
  data: T[]
  keyExtractor: (item: T) => string
  emptyTitle?: string
  emptyDescription?: string
  className?: string
  /** Active sort state (renders indicators on matching sortable headers). */
  sort?: TableSort | null
  onSortChange?: (sort: TableSort) => void
  /** Row click handler — rows become keyboard-focusable and clickable. */
  onRowClick?: (row: T) => void
  /** Accessible label for each clickable row (defaults to "Open details"). */
  rowAriaLabel?: (row: T) => string
  /** Optional per-row action cell rendered after the last column. */
  rowActions?: (row: T) => React.ReactNode
}

function cellValue<T>(col: Column<T>, item: T): React.ReactNode {
  if (col.cell) return col.cell(item)
  if (col.accessorKey) {
    return (item as unknown as Record<string, unknown>)[col.accessorKey as string] as React.ReactNode
  }
  return null
}

const isEmpty = (node: React.ReactNode) => node === null || node === undefined || node === false || node === ''

/**
 * Presentational data table with optional sorting, row clicks and per-row
 * actions. Column `cell` render callbacks and `keyExtractor` are defined by
 * the caller (server page or client wrapper). Interactive features (search,
 * pagination, sorting, row clicks) are wired through props — the table itself
 * stays presentational.
 *
 * Below md the same rows render as tappable cards: the first column is the card
 * title and the rest become label/value pairs, so nothing needs sideways scrolling.
 */
export function AdminDataTable<T>({
  columns,
  data,
  keyExtractor,
  emptyTitle = 'No records found',
  emptyDescription = 'There are no items matching your criteria at this time.',
  className,
  sort,
  onSortChange,
  onRowClick,
  rowAriaLabel,
  rowActions,
}: AdminDataTableProps<T>) {
  const handleSort = (col: Column<T>) => {
    if (!onSortChange) return
    const key = col.sortKey || String(col.accessorKey || col.header)
    const nextDir = sort?.key === key && sort.dir === 'asc' ? 'desc' : 'asc'
    onSortChange({ key, dir: nextDir })
  }

  const renderHeader = (col: Column<T>, idx: number) => {
    if (col.sortable && onSortChange) {
      const key = col.sortKey || String(col.accessorKey || col.header)
      const active = sort?.key === key
      const dir = active ? sort!.dir : null
      return (
        <th
          key={idx}
          className={cn('px-5 py-3.5', col.headerClassName)}
          aria-sort={active ? (dir === 'asc' ? 'ascending' : 'descending') : 'none'}
        >
          <button
            type="button"
            onClick={() => handleSort(col)}
            className="inline-flex items-center gap-1.5 uppercase tracking-wider text-[10px] font-bold text-admin-fg-subtle transition-colors hover:text-admin-fg cursor-pointer rounded focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-admin-accent/50"
          >
            {col.header}
            {active ? (
              dir === 'asc' ? (
                <ArrowUp className="w-3 h-3 text-admin-accent" />
              ) : (
                <ArrowDown className="w-3 h-3 text-admin-accent" />
              )
            ) : (
              <ChevronsUpDown className="w-3 h-3 opacity-50" />
            )}
          </button>
        </th>
      )
    }
    return (
      <th key={idx} className={cn('px-5 py-3.5', col.headerClassName)}>
        {col.header}
      </th>
    )
  }

  const sortableCols = onSortChange ? columns.filter((c) => c.sortable) : []
  const keyOf = (col: Column<T>) => col.sortKey || String(col.accessorKey || col.header)
  const [titleCol, ...restCols] = columns
  const mobileCols = restCols.filter((c) => !c.hideOnMobile)

  return (
    <div className={cn('space-y-4', className)}>
      {/* Phone: card list */}
      <div className="md:hidden space-y-3">
        {sortableCols.length > 0 && data.length > 1 && (
          <div className="flex items-center justify-end gap-2 text-xs text-admin-fg-muted">
            <label htmlFor={`sort-${sortableCols.map(keyOf).join('-')}`}>Sort by</label>
            <select
              id={`sort-${sortableCols.map(keyOf).join('-')}`}
              value={sort ? `${sort.key}:${sort.dir}` : ''}
              onChange={(e) => {
                const [key, dir] = e.target.value.split(':')
                if (key) onSortChange?.({ key, dir: dir === 'desc' ? 'desc' : 'asc' })
              }}
              className="h-10 rounded-lg border border-admin-border bg-admin-surface px-2 font-semibold text-admin-fg"
            >
              {!sort && <option value="">Default</option>}
              {sortableCols.map((col) => {
                const label = typeof col.header === 'string' ? col.header : keyOf(col)
                return (
                  <React.Fragment key={keyOf(col)}>
                    <option value={`${keyOf(col)}:asc`}>{label} (A to Z, low to high)</option>
                    <option value={`${keyOf(col)}:desc`}>{label} (Z to A, high to low)</option>
                  </React.Fragment>
                )
              })}
            </select>
          </div>
        )}

        {data.length === 0 ? (
          <div className="rounded-2xl border border-admin-border bg-admin-surface px-5 py-10 text-center">
            <Inbox className="w-8 h-8 text-admin-fg-subtle mx-auto stroke-[1.5]" />
            <p className="mt-2 text-sm font-bold text-admin-fg">{emptyTitle}</p>
            <p className="mt-1 text-xs text-admin-fg-muted">{emptyDescription}</p>
          </div>
        ) : (
          <ul className="space-y-3">
            {data.map((item) => {
              const clickable = Boolean(onRowClick)
              return (
                <li
                  key={keyExtractor(item)}
                  onClick={clickable ? () => onRowClick!(item) : undefined}
                  onKeyDown={
                    clickable
                      ? (e) => {
                          if (e.target !== e.currentTarget) return
                          if (e.key === 'Enter' || e.key === ' ') {
                            e.preventDefault()
                            onRowClick!(item)
                          }
                        }
                      : undefined
                  }
                  tabIndex={clickable ? 0 : undefined}
                  role={clickable ? 'button' : undefined}
                  aria-label={clickable ? (rowAriaLabel ? rowAriaLabel(item) : 'Open details') : undefined}
                  className={cn(
                    'rounded-2xl border border-admin-border bg-admin-surface p-4 text-xs text-admin-fg-muted shadow-xs',
                    clickable &&
                      'cursor-pointer transition-colors active:bg-admin-surface-raised focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-admin-accent/50'
                  )}
                >
                  {titleCol && (
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0 flex-1 text-sm text-admin-fg">{cellValue(titleCol, item)}</div>
                      {clickable && <ChevronRight className="mt-0.5 h-4 w-4 shrink-0 text-admin-fg-subtle" aria-hidden="true" />}
                    </div>
                  )}
                  {mobileCols.length > 0 && (
                    <dl className="mt-3 grid grid-cols-2 gap-x-4 gap-y-2.5 border-t border-admin-border pt-3">
                      {mobileCols.map((col, idx) => {
                        const value = cellValue(col, item)
                        if (isEmpty(value)) return null
                        return (
                          <div key={idx} className="min-w-0">
                            {typeof col.header === 'string' && col.header && (
                              <dt className="text-[10px] font-bold uppercase tracking-wider text-admin-fg-subtle">
                                {col.header}
                              </dt>
                            )}
                            <dd className="mt-0.5 min-w-0 break-words font-medium text-admin-fg">{value}</dd>
                          </div>
                        )
                      })}
                    </dl>
                  )}
                  {rowActions && (
                    <div
                      className="mt-3 flex flex-wrap items-center justify-end gap-2 border-t border-admin-border pt-3"
                      onClick={(e) => e.stopPropagation()}
                      onKeyDown={(e) => e.stopPropagation()}
                    >
                      {rowActions(item)}
                    </div>
                  )}
                </li>
              )
            })}
          </ul>
        )}
      </div>

      {/* Tablet and desktop: table */}
      <div className="hidden md:block bg-admin-surface border border-admin-border rounded-xl overflow-hidden shadow-xs">
        <div className="overflow-x-auto scrollbar-thin">
          <table className="w-full text-left text-xs text-admin-fg-muted min-w-[640px]">
            <thead className="bg-admin-surface-raised text-admin-fg-subtle uppercase tracking-wider text-[10px] font-bold border-b border-admin-border sticky top-0 z-10">
              <tr>
                {columns.map((col, idx) => renderHeader(col, idx))}
                {rowActions && <th className="px-5 py-3.5 text-right">Actions</th>}
              </tr>
            </thead>
            <tbody className="divide-y divide-admin-border font-medium">
              {data.length === 0 ? (
                <tr>
                  <td colSpan={columns.length + (rowActions ? 1 : 0)} className="px-5 py-12 text-center text-admin-fg-muted">
                    <div className="max-w-sm mx-auto space-y-2">
                      <Inbox className="w-8 h-8 text-admin-fg-subtle mx-auto stroke-[1.5]" />
                      <p className="text-sm font-bold text-admin-fg">{emptyTitle}</p>
                      <p className="text-xs text-admin-fg-muted">{emptyDescription}</p>
                    </div>
                  </td>
                </tr>
              ) : (
                data.map((item) => (
                  <tr
                    key={keyExtractor(item)}
                    onClick={onRowClick ? () => onRowClick(item) : undefined}
                    onKeyDown={
                      onRowClick
                        ? (e) => {
                            if (e.key === 'Enter' || e.key === ' ') {
                              e.preventDefault()
                              onRowClick(item)
                            }
                          }
                        : undefined
                    }
                    tabIndex={onRowClick ? 0 : undefined}
                    aria-label={onRowClick ? (rowAriaLabel ? rowAriaLabel(item) : 'Open details') : undefined}
                    className={cn(
                      'transition-colors group',
                      onRowClick && 'cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-admin-accent/50'
                    )}
                  >
                    {columns.map((col, idx) => (
                      <td key={idx} className={cn('px-5 py-4', col.className)}>
                        {cellValue(col, item)}
                      </td>
                    ))}
                    {rowActions && (
                      <td
                        className="px-5 py-4 text-right"
                        onClick={(e) => e.stopPropagation()}
                        onKeyDown={(e) => e.stopPropagation()}
                      >
                        {rowActions(item)}
                      </td>
                    )}
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  )
}