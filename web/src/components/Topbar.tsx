import { RefreshCw } from 'lucide-react';
import { Button } from './ui/Button';

export default function Topbar({
  title,
  right,
}: {
  title: string;
  right?: React.ReactNode;
}) {
  return (
    <div className="flex items-center gap-2 px-4 py-[9px] bg-white border-b border-line shadow-sm">
      <div className="text-[14px] font-bold text-ink">{title}</div>
      <div className="flex-1" />
      <div className="flex items-center gap-1.5">
        {right}
        <Button variant="outline" size="sm">
          <RefreshCw size={12} />
          Refresh
        </Button>
      </div>
    </div>
  );
}
