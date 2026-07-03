import type { PackageDto } from '../../types/api'
import BulkBoxCostModal from './BulkBoxCostModal'
import BoxReviewSweepModal from './BoxReviewSweepModal'
import type { BillingEditModalViewState } from './BillingEditDetailModal'
import { HugrabShippingFloorModal } from './HugrabShippingFloorModal'

type BillingDetailModalStackProps = {
  bulkBoxCostOpen: boolean
  boxReviewSweepOpen: boolean
  hugrabShippingFloorOpen: boolean
  billingEditModal: BillingEditModalViewState | null
  clientId: number | null
  clientName: string
  dateFrom: string
  dateTo: string
  packages: PackageDto[]
  onCloseBulkBoxCost: () => void
  onBulkBoxCostApplied: () => void
  onCloseBoxReviewSweep: () => void
  onBoxReviewSweepApplied: () => void
  onCloseHugrabShippingFloor: () => void
  onHugrabShippingFloorApplied: () => void
}

function packageLabel(packages: PackageDto[], packageId: string) {
  const numericPackageId = Number(packageId)
  return packages.find((pkg) => pkg.packageId === numericPackageId)?.name ?? `Box #${packageId}`
}

function reviewBoxLabel(modal: BillingEditModalViewState) {
  const reason = modal.row.packageCostReviewReason || ''
  const match = reason.match(/\(([^)]+)\)/)
  return match?.[1] ?? (reason || 'this box')
}

export function BillingDetailModalStack({
  bulkBoxCostOpen,
  boxReviewSweepOpen,
  hugrabShippingFloorOpen,
  billingEditModal,
  clientId,
  clientName,
  dateFrom,
  dateTo,
  packages,
  onCloseBulkBoxCost,
  onBulkBoxCostApplied,
  onCloseBoxReviewSweep,
  onBoxReviewSweepApplied,
  onCloseHugrabShippingFloor,
  onHugrabShippingFloorApplied,
}: BillingDetailModalStackProps) {
  const clientLabel = clientId == null ? '' : clientName || `Client ${clientId}`

  return (
    <>
      {bulkBoxCostOpen && billingEditModal && billingEditModal.draft.packageId && clientId != null ? (
        <BulkBoxCostModal
          clientId={clientId}
          clientName={clientLabel}
          dateFrom={dateFrom}
          dateTo={dateTo}
          packageId={Number(billingEditModal.draft.packageId)}
          packageLabel={packageLabel(packages, billingEditModal.draft.packageId)}
          initialCost={billingEditModal.draft.packageCost}
          onClose={onCloseBulkBoxCost}
          onApplied={onBulkBoxCostApplied}
        />
      ) : null}

      {boxReviewSweepOpen && billingEditModal && billingEditModal.row.orderId != null && clientId != null ? (
        <BoxReviewSweepModal
          clientId={clientId}
          clientName={clientLabel}
          sourceOrderId={Number(billingEditModal.row.orderId)}
          boxLabel={reviewBoxLabel(billingEditModal)}
          initialFrom={dateFrom}
          initialTo={dateTo}
          onClose={onCloseBoxReviewSweep}
          onApplied={onBoxReviewSweepApplied}
        />
      ) : null}

      {hugrabShippingFloorOpen ? (
        <HugrabShippingFloorModal
          dateFrom={dateFrom}
          dateTo={dateTo}
          onClose={onCloseHugrabShippingFloor}
          onApplied={onHugrabShippingFloorApplied}
        />
      ) : null}
    </>
  )
}
