export type DirectLabelPersistenceInput = {
  orderId: number;
  carrierProvider: string;
  carrierAccountId: number | null;
  carrierLabel: string | null;
  carrierCode: string | null;
  serviceCode: string | null;
  trackingNumber: string;
  labelUrl: string | null;
  labelFormat: string | null;
  cost: number;
  currency: string;
  weightOz: number;
  dimsL: number | null;
  dimsW: number | null;
  dimsH: number | null;
  selectedRateJson: Record<string, unknown>;
  labelProvider: number | null;
  labelShipmentId?: number | null;
  selectedPid: number | null;
  selectedPackageId: string | null;
  source: string;
};

export type DirectLabelPersistenceResult = {
  localShipmentId: number;
  orderNumber: string | null;
  clientId: number | null;
  orderStatus: string;
};

export async function persistDirectCarrierLabel(
  sql: any,
  input: DirectLabelPersistenceInput,
): Promise<DirectLabelPersistenceResult> {
  return sql.begin(async (tx: any) => {
    const [order] = await tx<Array<{
      id: number;
      client_id: number | null;
      order_number: string | null;
      order_status: string;
    }>>`
      SELECT id, client_id, order_number, order_status
      FROM orders
      WHERE id = ${Math.trunc(input.orderId)}
      FOR UPDATE
    `;
    if (!order) throw new Error('Order not found');
    if (order.order_status === 'shipped' || order.order_status === 'cancelled') {
      throw new Error(`Cannot create ${input.carrierProvider} label for ${order.order_status} order`);
    }

    const [shipment] = await tx<Array<{ id: number }>>`
      INSERT INTO shipments (
        order_id, client_id, order_number,
        carrier_code, service_code, tracking_number,
        ship_date, create_date, weight_oz, dims_l, dims_w, dims_h,
        cost, other_cost, label_url, label_created_at, label_format,
        label_carrier, label_service, label_tracking, label_cost,
        label_ship_date, label_provider, label_shipment_id,
        selected_rate_json, selected_pid, selected_package_id,
        provider_account_id, provider_account_nickname,
        carrier_provider, carrier_account_id, label_provider_key,
        confirmation_provider, confirmation_status,
        voided, source, is_return, created_at, updated_at
      )
      VALUES (
        ${order.id}, ${order.client_id}, ${order.order_number},
        ${input.carrierCode}, ${input.serviceCode}, ${input.trackingNumber},
        NOW(), NOW(), ${input.weightOz}, ${input.dimsL}, ${input.dimsW}, ${input.dimsH},
        ${input.cost.toFixed(2)}, ${'0.00'}, ${input.labelUrl}, NOW(), ${input.labelFormat},
        ${input.carrierCode}, ${input.serviceCode}, ${input.trackingNumber}, ${input.cost.toFixed(2)},
        NOW(), ${input.labelProvider}, ${input.labelShipmentId ?? null},
        ${sql.json(input.selectedRateJson)}, ${input.selectedPid}, ${input.selectedPackageId},
        ${input.carrierAccountId}, ${input.carrierLabel},
        ${input.carrierProvider}, ${input.carrierAccountId == null ? null : String(input.carrierAccountId)}, ${input.carrierProvider},
        ${null}, ${input.trackingNumber ? 'pending' : 'not_required'},
        ${false}, ${input.source}, ${false}, NOW(), NOW()
      )
      RETURNING id
    `;

    const updated = await tx<Array<{ order_status: string }>>`
      UPDATE orders
      SET order_status = 'shipped', updated_at = NOW()
      WHERE id = ${order.id} AND order_status = 'awaiting_shipment'
      RETURNING order_status
    `;

    await tx`
      DELETE FROM print_queue_orders
      WHERE order_id = ${String(order.id)}
    `;

    return {
      localShipmentId: shipment.id,
      orderNumber: order.order_number,
      clientId: order.client_id,
      orderStatus: updated[0]?.order_status ?? order.order_status,
    };
  });
}
