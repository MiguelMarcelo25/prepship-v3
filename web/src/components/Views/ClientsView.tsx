// @ts-nocheck
/**
 * ClientsView — top-level destination for the Clients management UI.
 *
 * Background: Clients used to live as a tab inside InventoryView (next
 * to Stock, Receive, Alerts, Parents, History). That nesting was
 * confusing — clients are an organizational concept that drives most
 * of the rest of the app (orders, billing, manifests, rate selection),
 * not a sub-feature of inventory. The operator asked on 2026-05-10
 * to move Clients to its own top-level sidebar entry.
 *
 * Implementation choice: thin wrapper, not full extraction.
 * The Clients tab inside InventoryView shares ~5 hooks and ~500 lines
 * of JSX with three other tabs (History client-filter, Parent SKUs
 * client-filter, the rate-source dropdown). A full extraction would
 * have rippled changes through every consumer. Instead, InventoryView
 * gained two new props (`initialTab`, `hideTabs`) and this component
 * mounts it in "Clients-only" mode:
 *
 *   <InventoryView initialTab="clients" hideTabs viewTitle="Clients" />
 *
 * From the user's perspective the page reads as a standalone Clients
 * page (no tab strip, no Inventory action buttons, title says
 * "Clients"). From the codebase's perspective nothing moved — all the
 * Clients state still lives in InventoryView, all its handlers still
 * fire, and the History/Parent-SKUs tabs that depend on the same
 * `clients` array keep working in the normal /inventory route.
 *
 * Trade-off: visiting /clients fetches the full Inventory bootstrap
 * data even though only the Clients tab is rendered. Mildly wasteful;
 * acceptable for v1. If this becomes a perf issue, the next move is
 * to lift the shared `clients` fetch into `useClients()` (which
 * already exists) and refactor InventoryView to read from it.
 */

import InventoryView from './InventoryView'

interface ClientsViewProps {
  onOpenOrder?: (orderId: number, status?: string | null) => void
}

export default function ClientsView({ onOpenOrder }: ClientsViewProps = {}) {
  return (
    <InventoryView
      initialTab="clients"
      hideTabs
      viewTitle="Clients"
      onOpenOrder={onOpenOrder}
    />
  )
}
