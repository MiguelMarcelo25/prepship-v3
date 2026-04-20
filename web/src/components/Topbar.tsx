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
      <div className="flex items-center gap-1.5">{right}</div>
    </div>
  );
}
