import { useMemo, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import OrdersView from '../components/Views/OrdersView'
import type { OrdersDateFilter } from '../components/Views/orders-view-filters'

type OrderStatus = 'awaiting_shipment' | 'shipped' | 'cancelled'

const VALID_STATUSES: OrderStatus[] = ['awaiting_shipment', 'shipped', 'cancelled']

export default function Orders() {
  const { status, orderId } = useParams()
  const navigate = useNavigate()
  const [searchQuery, setSearchQuery] = useState('')
  const [dateFilter, setDateFilter] = useState<OrdersDateFilter>('last-30')

  const currentStatus: OrderStatus = useMemo(() => {
    if (status && (VALID_STATUSES as string[]).includes(status)) {
      return status as OrderStatus
    }
    return 'awaiting_shipment'
  }, [status])

  const activeOrderId = orderId ? Number.parseInt(orderId, 10) || null : null

  return (
    <OrdersView
      currentStatus={currentStatus}
      searchQuery={searchQuery}
      onSearchQueryChange={setSearchQuery}
      dateFilter={dateFilter}
      onDateFilterChange={setDateFilter}
      activeOrderId={activeOrderId}
      onActiveOrderIdChange={(id) => {
        if (id == null) navigate(`/orders/${currentStatus}`)
        else navigate(`/orders/${currentStatus}/${id}`)
      }}
    />
  )
}
