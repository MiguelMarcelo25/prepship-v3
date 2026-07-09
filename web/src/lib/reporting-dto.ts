export function requiredReportingNumber(value: unknown, field: string): number {
  const parsed = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(parsed)) throw new Error(`Reporting field ${field} is unavailable`);
  return parsed;
}

function nullableNumber(value: unknown, field: string): number | null {
  if (value === null || value === undefined || value === '') return null;
  return requiredReportingNumber(value, field);
}

function firstValue(row: Record<string, unknown>, keys: string[]): unknown {
  for (const key of keys) {
    if (row[key] !== undefined) return row[key];
  }
  return undefined;
}

export function reportingSkuDtoFromBackend(raw: unknown): Record<string, unknown> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('Reporting SKU row is unavailable');
  }
  const row = raw as Record<string, unknown>;
  const rawInventoryId = firstValue(row, ['inv_sku_id', 'invSkuId']);
  const inventoryId = rawInventoryId == null || rawInventoryId === ''
    ? null
    : requiredReportingNumber(rawInventoryId, 'invSkuId');
  const dailyRaw = firstValue(row, ['daily_qty', 'dailyQty']);
  if (!Array.isArray(dailyRaw)) throw new Error('Reporting field dailyQty is unavailable');

  return {
    sku: String(row.sku ?? ''),
    name: String(row.name ?? ''),
    imageUrl: firstValue(row, ['image_url', 'imageUrl']) ?? null,
    invSkuId: inventoryId,
    clientId: firstValue(row, ['client_id', 'clientId']) ?? null,
    clientName: firstValue(row, ['client_name', 'clientName']) ?? '',
    dailyQty: dailyRaw.map((value, index) => requiredReportingNumber(value, `dailyQty[${index}]`)),
    orders: requiredReportingNumber(row.orders, 'orders'),
    pendingOrders: requiredReportingNumber(firstValue(row, ['pending', 'pendingOrders']), 'pendingOrders'),
    externalOrders: requiredReportingNumber(firstValue(row, ['ext_shipped', 'externalOrders']), 'externalOrders'),
    qty: requiredReportingNumber(firstValue(row, ['total_qty', 'qty']), 'qty'),
    standardOrders: requiredReportingNumber(firstValue(row, ['std_orders', 'standardOrders']), 'standardOrders'),
    standardShipCount: requiredReportingNumber(firstValue(row, ['std_ship_count', 'standardShipCount']), 'standardShipCount'),
    standardShipQtyTotal: requiredReportingNumber(firstValue(row, ['std_qty_total', 'standardShipQtyTotal']), 'standardShipQtyTotal'),
    standardTotalShipping: nullableNumber(firstValue(row, ['std_total', 'standardTotalShipping']), 'standardTotalShipping'),
    standardShipTotal: nullableNumber(firstValue(row, ['std_total', 'standardShipTotal']), 'standardShipTotal'),
    standardAvgShipping: nullableNumber(row.standardAvgShipping, 'standardAvgShipping'),
    expeditedOrders: requiredReportingNumber(firstValue(row, ['exp_orders', 'expeditedOrders']), 'expeditedOrders'),
    expeditedShipCount: requiredReportingNumber(firstValue(row, ['exp_ship_count', 'expeditedShipCount']), 'expeditedShipCount'),
    expeditedShipQtyTotal: requiredReportingNumber(firstValue(row, ['exp_qty_total', 'expeditedShipQtyTotal']), 'expeditedShipQtyTotal'),
    expeditedTotalShipping: nullableNumber(firstValue(row, ['exp_total', 'expeditedTotalShipping']), 'expeditedTotalShipping'),
    expeditedShipTotal: nullableNumber(firstValue(row, ['exp_total', 'expeditedShipTotal']), 'expeditedShipTotal'),
    expeditedAvgShipping: nullableNumber(row.expeditedAvgShipping, 'expeditedAvgShipping'),
    shipCountWithCost: requiredReportingNumber(firstValue(row, ['ship_count_with_cost', 'shipCountWithCost']), 'shipCountWithCost'),
    blendedAvgShipping: nullableNumber(row.blendedAvgShipping, 'blendedAvgShipping'),
    totalShipping: nullableNumber(row.totalShipping, 'totalShipping'),
    totalRevenue: nullableNumber(row.totalRevenue, 'totalRevenue'),
    avgSellingPrice: nullableNumber(row.avgSellingPrice, 'avgSellingPrice'),
    totalSellingFee: nullableNumber(row.totalSellingFee, 'totalSellingFee'),
    profit: nullableNumber(row.profit, 'profit'),
    financialsState: row.financialsState,
    sellingFeeComplete: row.selling_fee_complete === true,
  };
}

export function reportingTotalsFromBackend(raw: unknown): Record<string, unknown> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('Reporting totals are unavailable');
  }
  const totals = raw as Record<string, unknown>;
  return {
    skuCount: requiredReportingNumber(totals.skuCount, 'totals.skuCount'),
    totalOrders: requiredReportingNumber(totals.totalOrders, 'totals.totalOrders'),
    totalPending: requiredReportingNumber(totals.totalPending, 'totals.totalPending'),
    totalExternal: requiredReportingNumber(totals.totalExternal, 'totals.totalExternal'),
    totalQty: requiredReportingNumber(totals.totalQty, 'totals.totalQty'),
    totalStdCount: requiredReportingNumber(totals.totalStdCount, 'totals.totalStdCount'),
    totalExpCount: requiredReportingNumber(totals.totalExpCount, 'totals.totalExpCount'),
    totalStdQty: requiredReportingNumber(totals.totalStdQty, 'totals.totalStdQty'),
    totalExpQty: requiredReportingNumber(totals.totalExpQty, 'totals.totalExpQty'),
    totalStdShipping: nullableNumber(totals.totalStdShipping, 'totals.totalStdShipping'),
    totalExpShipping: nullableNumber(totals.totalExpShipping, 'totals.totalExpShipping'),
    standardAvgShipping: nullableNumber(totals.standardAvgShipping, 'totals.standardAvgShipping'),
    expeditedAvgShipping: nullableNumber(totals.expeditedAvgShipping, 'totals.expeditedAvgShipping'),
    totalShipping: nullableNumber(totals.totalShipping, 'totals.totalShipping'),
    totalRevenue: nullableNumber(totals.totalRevenue, 'totals.totalRevenue'),
    avgSellingPrice: nullableNumber(totals.avgSellingPrice, 'totals.avgSellingPrice'),
    totalSellingFee: nullableNumber(totals.totalSellingFee, 'totals.totalSellingFee'),
    totalProfit: nullableNumber(totals.totalProfit, 'totals.totalProfit'),
    financialsState: totals.financialsState,
  };
}
