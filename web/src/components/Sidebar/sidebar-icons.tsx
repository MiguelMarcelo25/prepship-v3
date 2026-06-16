import type { ReactNode } from 'react'
import {
  Home,
  Search,
  Warehouse,
  MapPinned,
  PackageOpen,
  BadgeDollarSign,
  TrendingUp,
  SlidersHorizontal,
  ReceiptText,
  ScrollText,
  ChevronRight,
  X,
  Inbox,
  Clock,
  AlertTriangle,
  RotateCcw,
  Truck,
  User,
  LogOut,
  ChevronDown,
  CircleCheckBig,
  CircleX,
  Moon,
  Sun,
} from 'lucide-react'

const ICON_SIZE = 18
const STROKE_WIDTH = 2

export type IconTone =
  | 'indigo'
  | 'emerald'
  | 'rose'
  | 'amber'
  | 'violet'
  | 'sky'
  | 'teal'
  | 'slate'

const TONE_STYLES: Record<IconTone, { idle: string; active: string }> = {
  indigo: {
    idle: 'bg-indigo-100/70 text-indigo-600 dark:bg-indigo-500/15 dark:text-indigo-300',
    active:
      'bg-gradient-to-br from-indigo-500 to-indigo-600 text-white shadow-md shadow-indigo-500/40',
  },
  emerald: {
    idle: 'bg-emerald-100/70 text-emerald-600 dark:bg-emerald-500/15 dark:text-emerald-300',
    active:
      'bg-gradient-to-br from-emerald-500 to-emerald-600 text-white shadow-md shadow-emerald-500/40',
  },
  rose: {
    idle: 'bg-rose-100/70 text-rose-600 dark:bg-rose-500/15 dark:text-rose-300',
    active:
      'bg-gradient-to-br from-rose-500 to-rose-600 text-white shadow-md shadow-rose-500/40',
  },
  amber: {
    idle: 'bg-amber-100/70 text-amber-600 dark:bg-amber-500/15 dark:text-amber-300',
    active:
      'bg-gradient-to-br from-amber-500 to-amber-600 text-white shadow-md shadow-amber-500/40',
  },
  violet: {
    idle: 'bg-violet-100/70 text-violet-600 dark:bg-violet-500/15 dark:text-violet-300',
    active:
      'bg-gradient-to-br from-violet-500 to-violet-600 text-white shadow-md shadow-violet-500/40',
  },
  sky: {
    idle: 'bg-sky-100/70 text-sky-600 dark:bg-sky-500/15 dark:text-sky-300',
    active:
      'bg-gradient-to-br from-sky-500 to-sky-600 text-white shadow-md shadow-sky-500/40',
  },
  teal: {
    idle: 'bg-teal-100/70 text-teal-600 dark:bg-teal-500/15 dark:text-teal-300',
    active:
      'bg-gradient-to-br from-teal-500 to-teal-600 text-white shadow-md shadow-teal-500/40',
  },
  slate: {
    idle: 'bg-slate-200/70 text-slate-600 dark:bg-slate-500/15 dark:text-slate-300',
    active:
      'bg-gradient-to-br from-slate-600 to-slate-700 text-white shadow-md shadow-slate-500/40',
  },
}

export function IconBadge({
  tone,
  active = false,
  size = 'md',
  children,
}: {
  tone: IconTone
  active?: boolean
  size?: 'sm' | 'md'
  children: ReactNode
}) {
  const dims = size === 'sm' ? 'h-7 w-7' : 'h-8 w-8'
  return (
    <span
      className={[
        'flex shrink-0 items-center justify-center rounded-lg transition-all duration-200 ease-out',
        'group-hover:scale-110 group-hover:-rotate-3',
        dims,
        active ? TONE_STYLES[tone].active : TONE_STYLES[tone].idle,
      ].join(' ')}
    >
      {children}
    </span>
  )
}

export function IconHome({ className = '' }) {
  return <Home className={className} size={ICON_SIZE} strokeWidth={STROKE_WIDTH} />
}

export function IconSearch({ className = '' }) {
  return <Search className={className} size={16} strokeWidth={STROKE_WIDTH} />
}

export function IconBoxes({ className = '' }) {
  return <Warehouse className={className} size={ICON_SIZE} strokeWidth={STROKE_WIDTH} />
}

export function IconMapPin({ className = '' }) {
  return <MapPinned className={className} size={ICON_SIZE} strokeWidth={STROKE_WIDTH} />
}

export function IconPackage({ className = '' }) {
  return <PackageOpen className={className} size={ICON_SIZE} strokeWidth={STROKE_WIDTH} />
}

export function IconDollarSign({ className = '' }) {
  return <BadgeDollarSign className={className} size={ICON_SIZE} strokeWidth={STROKE_WIDTH} />
}

export function IconBarChart({ className = '' }) {
  return <TrendingUp className={className} size={ICON_SIZE} strokeWidth={STROKE_WIDTH} />
}

export function IconSettings({ className = '' }) {
  return <SlidersHorizontal className={className} size={ICON_SIZE} strokeWidth={STROKE_WIDTH} />
}

export function IconReceipt({ className = '' }) {
  return <ReceiptText className={className} size={ICON_SIZE} strokeWidth={STROKE_WIDTH} />
}

export function IconFileText({ className = '' }) {
  return <ScrollText className={className} size={ICON_SIZE} strokeWidth={STROKE_WIDTH} />
}

export function IconChevronRight({ className = '' }) {
  return <ChevronRight className={className} size={14} strokeWidth={2.5} />
}

export function IconChevronDown({ className = '' }) {
  return <ChevronDown className={className} size={14} strokeWidth={2.5} />
}

export function IconX({ className = '' }) {
  return <X className={className} size={16} strokeWidth={STROKE_WIDTH} />
}

export function IconInbox({ className = '' }) {
  return <Inbox className={className} size={ICON_SIZE} strokeWidth={STROKE_WIDTH} />
}

export function IconClock({ className = '' }) {
  return <Clock className={className} size={ICON_SIZE} strokeWidth={STROKE_WIDTH} />
}

export function IconAlertTriangle({ className = '' }) {
  return <AlertTriangle className={className} size={ICON_SIZE} strokeWidth={STROKE_WIDTH} />
}

export function IconRotateCcw({ className = '' }) {
  return <RotateCcw className={className} size={ICON_SIZE} strokeWidth={STROKE_WIDTH} />
}

export function IconTruck({ className = '' }) {
  return <Truck className={className} size={ICON_SIZE} strokeWidth={STROKE_WIDTH} />
}

export function IconUser({ className = '' }) {
  return <User className={className} size={ICON_SIZE} strokeWidth={STROKE_WIDTH} />
}

export function IconLogOut({ className = '' }) {
  return <LogOut className={className} size={ICON_SIZE} strokeWidth={STROKE_WIDTH} />
}

export function IconCheckCircle({ className = '' }) {
  return <CircleCheckBig className={className} size={ICON_SIZE} strokeWidth={STROKE_WIDTH} />
}

export function IconXCircle({ className = '' }) {
  return <CircleX className={className} size={ICON_SIZE} strokeWidth={STROKE_WIDTH} />
}

export function IconMoon({ className = '' }) {
  return <Moon className={className} size={ICON_SIZE} strokeWidth={STROKE_WIDTH} />
}

export function IconSun({ className = '' }) {
  return <Sun className={className} size={ICON_SIZE} strokeWidth={STROKE_WIDTH} />
}
