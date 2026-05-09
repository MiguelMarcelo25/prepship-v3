import type { CSSProperties, ReactNode, ThHTMLAttributes } from 'react'

export type SortDirection = 'asc' | 'desc'

export type SortState<K extends string = string> = {
  key: K
  direction: SortDirection
} | null

export type SortValue = string | number | boolean | Date | null | undefined

const sortCollator = new Intl.Collator(undefined, {
  numeric: true,
  sensitivity: 'base',
})

function isBlank(value: SortValue) {
  return value == null || value === ''
}

function normalizeDateValue(value: Date) {
  const time = value.getTime()
  return Number.isFinite(time) ? time : 0
}

export function compareSortValues(left: SortValue, right: SortValue) {
  const leftBlank = isBlank(left)
  const rightBlank = isBlank(right)

  if (leftBlank && rightBlank) return 0
  if (leftBlank) return 1
  if (rightBlank) return -1

  if (left instanceof Date || right instanceof Date) {
    const leftTime = left instanceof Date ? normalizeDateValue(left) : Date.parse(String(left))
    const rightTime = right instanceof Date ? normalizeDateValue(right) : Date.parse(String(right))

    if (Number.isFinite(leftTime) && Number.isFinite(rightTime)) {
      return leftTime - rightTime
    }
  }

  if (typeof left === 'number' || typeof right === 'number') {
    const leftNumber = Number(left)
    const rightNumber = Number(right)

    if (Number.isFinite(leftNumber) && Number.isFinite(rightNumber)) {
      return leftNumber - rightNumber
    }
  }

  if (typeof left === 'boolean' || typeof right === 'boolean') {
    return Number(Boolean(left)) - Number(Boolean(right))
  }

  return sortCollator.compare(String(left), String(right))
}

export function sortRows<T, K extends string>(
  rows: readonly T[],
  sortState: SortState<K>,
  getValue: (row: T, key: K) => SortValue,
  getFallback?: (row: T) => SortValue,
) {
  const nextRows = [...rows]

  if (!sortState) return nextRows

  const direction = sortState.direction === 'asc' ? 1 : -1

  nextRows.sort((left, right) => {
    const comparison = compareSortValues(getValue(left, sortState.key), getValue(right, sortState.key))

    if (comparison !== 0) return comparison * direction

    if (getFallback) {
      return compareSortValues(getFallback(left), getFallback(right))
    }

    return 0
  })

  return nextRows
}

export function nextSortState<K extends string>(
  current: SortState<K>,
  key: K,
  initialDirection: SortDirection = 'asc',
): SortState<K> {
  if (current?.key !== key) {
    return { key, direction: initialDirection }
  }

  return {
    key,
    direction: current.direction === 'asc' ? 'desc' : 'asc',
  }
}

type SortableHeaderProps<K extends string> = Omit<ThHTMLAttributes<HTMLTableCellElement>, 'children' | 'onClick'> & {
  children: ReactNode
  sortKey: K
  sortState: SortState<K>
  onSort: (key: K) => void
  align?: CSSProperties['textAlign']
}

export function SortableHeader<K extends string>({
  children,
  sortKey,
  sortState,
  onSort,
  align,
  style,
  className,
  title,
  ...rest
}: SortableHeaderProps<K>) {
  const isActive = sortState?.key === sortKey
  const textAlign = align ?? style?.textAlign ?? 'left'
  const justifyContent =
    textAlign === 'right'
      ? 'flex-end'
      : textAlign === 'center'
        ? 'center'
        : 'flex-start'

  return (
    <th
      {...rest}
      aria-sort={isActive ? (sortState.direction === 'asc' ? 'ascending' : 'descending') : 'none'}
      className={className}
      style={style}
      title={title}
    >
      <button
        type="button"
        onClick={() => onSort(sortKey)}
        style={{
          alignItems: 'center',
          background: 'transparent',
          border: 0,
          color: 'inherit',
          cursor: 'pointer',
          display: 'inline-flex',
          font: 'inherit',
          gap: 4,
          justifyContent,
          letterSpacing: 'inherit',
          margin: 0,
          padding: 0,
          textAlign,
          textTransform: 'inherit',
          width: '100%',
        }}
      >
        <span>{children}</span>
        <span
          aria-hidden="true"
          style={{
            display: 'inline-block',
            fontSize: '0.85em',
            lineHeight: 1,
            minWidth: '1ch',
            opacity: isActive ? 1 : 0.45,
          }}
        >
          {isActive ? (sortState.direction === 'asc' ? '^' : 'v') : ''}
        </span>
      </button>
    </th>
  )
}
