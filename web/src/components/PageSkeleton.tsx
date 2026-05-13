export default function PageSkeleton() {
  return (
    <div className="flex-1 min-h-0 w-full bg-page p-4 animate-pulse">
      <div className="h-8 w-48 rounded-md bg-surface-2 ring-1 ring-line" />
      <div className="mt-4 rounded-card border border-line bg-surface overflow-hidden">
        <div className="h-10 border-b border-line bg-surface-2" />
        <div className="space-y-2 p-3">
          <div className="h-8 rounded bg-surface-2" />
          <div className="h-8 rounded bg-surface-2" />
          <div className="h-8 rounded bg-surface-2" />
        </div>
      </div>
    </div>
  )
}
