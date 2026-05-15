import SidebarA from './variants/SidebarA'
import type { SidebarVariantProps } from './variants/useSidebarController'

export default function Sidebar(props: SidebarVariantProps) {
  return <SidebarA {...props} />
}
