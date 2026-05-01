// @ts-nocheck
import { useEffect, useRef } from 'react'
import './ColumnResizeHandle.css'

const DEFAULT_MIN_WIDTH = 60
const DEFAULT_MAX_WIDTH = 600

interface ColumnResizeHandleProps {
  getStartWidth: () => number
  onChange: (width: number) => void
  onReset?: () => void
  minWidth?: number
  maxWidth?: number
  className?: string
}

export function ColumnResizeHandle({
  getStartWidth,
  onChange,
  onReset,
  minWidth = DEFAULT_MIN_WIDTH,
  maxWidth = DEFAULT_MAX_WIDTH,
  className = 'analysis-col-resize-handle',
}: ColumnResizeHandleProps) {
  const dragRef = useRef<{ startX: number; startWidth: number } | null>(null)

  useEffect(() => {
    function handleMove(event: MouseEvent) {
      const drag = dragRef.current
      if (!drag) return
      const next = Math.min(maxWidth, Math.max(minWidth, drag.startWidth + (event.clientX - drag.startX)))
      onChange(next)
    }
    function handleUp() {
      if (!dragRef.current) return
      dragRef.current = null
      document.body.style.cursor = ''
      document.body.style.userSelect = ''
    }
    document.addEventListener('mousemove', handleMove)
    document.addEventListener('mouseup', handleUp)
    return () => {
      document.removeEventListener('mousemove', handleMove)
      document.removeEventListener('mouseup', handleUp)
    }
  }, [onChange, minWidth, maxWidth])

  return (
    <span
      className={className}
      role="separator"
      aria-orientation="vertical"
      aria-label="Resize column"
      onMouseDown={(event) => {
        event.preventDefault()
        event.stopPropagation()
        dragRef.current = { startX: event.clientX, startWidth: getStartWidth() }
        document.body.style.cursor = 'col-resize'
        document.body.style.userSelect = 'none'
      }}
      onDoubleClick={(event) => {
        event.preventDefault()
        event.stopPropagation()
        onReset?.()
      }}
      onClick={(event) => {
        event.stopPropagation()
      }}
      title="Drag to resize · Double-click to reset"
    />
  )
}
