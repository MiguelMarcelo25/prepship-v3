import Topbar from '../components/Topbar';

export default function ComingSoon({
  title,
  icon,
}: {
  title: string;
  icon?: string;
}) {
  return (
    <>
      <Topbar title={title} />
      <div className="flex-1 min-h-0 flex items-center justify-center bg-page">
        <div className="text-center text-ink-3 max-w-sm">
          {icon && <div className="text-5xl mb-3">{icon}</div>}
          <div className="text-[15px] font-bold text-ink-2 mb-1">{title}</div>
          <div className="text-tiny leading-relaxed">
            Still porting this from the old stack. Coming soon.
          </div>
        </div>
      </div>
    </>
  );
}
