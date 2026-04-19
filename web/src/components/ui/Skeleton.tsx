type Props = {
  className?: string;
  rounded?: 'sm' | 'md' | 'full';
};

const radii: Record<NonNullable<Props['rounded']>, string> = {
  sm: 'rounded',
  md: 'rounded-btn',
  full: 'rounded-full',
};

export function Skeleton({ className = '', rounded = 'md' }: Props) {
  return (
    <div
      className={`animate-pulse bg-surface-3 ${radii[rounded]} ${className}`}
    />
  );
}

export function SkeletonRow({
  cols = 6,
  className = '',
}: {
  cols?: number;
  className?: string;
}) {
  return (
    <tr className={`border-b border-line ${className}`}>
      {Array.from({ length: cols }).map((_, i) => (
        <td key={i} className="px-2 py-2">
          <Skeleton className="h-3 w-full" />
        </td>
      ))}
    </tr>
  );
}
