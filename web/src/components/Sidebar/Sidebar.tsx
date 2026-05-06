// @ts-nocheck
// Sidebar dispatcher — 25 variants total.
//   A–E: hand-crafted custom layouts (each in its own file).
//   F–Y: spec-driven via SidebarTemplated + sidebar-specs.ts.
import SidebarA from './variants/SidebarA'
import SidebarB from './variants/SidebarB'
import SidebarC from './variants/SidebarC'
import SidebarD from './variants/SidebarD'
import SidebarE from './variants/SidebarE'
import SidebarTemplated from './variants/SidebarTemplated'
import { SIDEBAR_SPECS } from './variants/sidebar-specs'
import type { SidebarVariantProps } from './variants/useSidebarController'
import { useSidebarVariant } from '../../lib/useSidebarVariant'

const HANDCRAFTED: Record<string, React.ComponentType<SidebarVariantProps>> = {
  A: SidebarA,
  B: SidebarB,
  C: SidebarC,
  D: SidebarD,
  E: SidebarE,
}

export default function Sidebar(props: SidebarVariantProps) {
  const { variant } = useSidebarVariant()
  const Hand = HANDCRAFTED[variant]
  if (Hand) return <Hand {...props} />
  const spec = SIDEBAR_SPECS[variant]
  if (spec) return <SidebarTemplated spec={spec} {...props} />
  // Fallback to A if the stored variant key disappeared.
  return <SidebarA {...props} />
}
