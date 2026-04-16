import type { DatabaseSync } from "node:sqlite";
import type {
  BackfillBillingReferenceRatesInput,
  BillingDetailsQuery,
  GenerateBillingInput,
  GenerateBillingResult,
  SaveBillingPackagePriceInput,
  BillingSummaryQuery,
  SetDefaultBillingPackagePriceResult,
  UpdateBillingConfigInput,
} from "../../../../../../../packages/contracts/src/billing/contracts.ts";
import { SS_BASELINE_CARRIER_CODES } from "../../../common/prepship-config.ts";
import type { BillingRepository } from "../application/billing-repository.ts";
import type {
  BillingClientPackagePriceRecord,
  BillingClientRecord,
  BillingConfigRecord,
  BillingBackfillReferenceRateOrderRecord,
  BillingDetailRecord,
  BillingFetchReferenceRateOrderRecord,
  BillingInvoiceDetailRecord,
  BillingInvoiceRecord,
  BillingLedgerEventRecord,
  BillingLedgerStockTotalRecord,
  BillingPackageDimensionRecord,
  BillingPackageNameRecord,
  BillingPackagePriceRecord,
  BillingReferenceRateRecord,
  BillingShipmentRecord,
  BillingSkuPackageRecord,
  BillingStorageSkuRecord,
  BillingStoreClientRecord,
  BillingSummaryRecord,
} from "../domain/billing.ts";
import type { RateDto } from "../../../../../../../packages/contracts/src/rates/contracts.ts";

const HOUSE_ACCOUNT_IDS = new Set([3, 4]);

interface RunResult {
  changes: number;
}

export class SqliteBillingRepository implements BillingRepository {
  private readonly db: DatabaseSync;

  constructor(db: DatabaseSync) {
    this.db = db;
  }

  async listBillableClients(): Promise<BillingClientRecord[]> {
    return this.db.prepare(`
      SELECT clientId, name
      FROM clients
      WHERE active = 1
        AND name NOT IN ('Manual Orders', 'Rate Browser', 'Api Shipments')
      ORDER BY name
    `).all() as BillingClientRecord[];
  }

  async listConfigRecords(): Promise<BillingConfigRecord[]> {
    return this.db.prepare(`
      SELECT
        clientId,
        pickPackFee,
        additionalUnitFee,
        packageCostMarkup,
        shippingMarkupPct,
        shippingMarkupFlat,
        billing_mode,
        storageFeePerCuFt,
        storageFeeMode,
        palletPricingPerMonth,
        palletCuFt
      FROM billing_config
    `).all() as BillingConfigRecord[];
  }

  async listReferenceRateStoreIds(): Promise<number[]> {
    const rows = this.db.prepare(`
      SELECT c.storeIds
      FROM billing_config bc
      JOIN clients c ON c.clientId = bc.clientId
      WHERE bc.billing_mode = 'reference_rate'
        AND c.active = 1
    `).all() as Array<{ storeIds: string | null }>;

    const storeIds = new Set<number>();
    for (const row of rows) {
      for (const storeId of this.parseJson<number[]>(row.storeIds, [])) {
        if (Number.isFinite(Number(storeId))) {
          storeIds.add(Number(storeId));
        }
      }
    }
    return [...storeIds];
  }

  async upsertConfig(clientId: number, input: UpdateBillingConfigInput): Promise<void> {
    const now = Date.now();
    this.db.prepare(`
      INSERT INTO billing_config (
        clientId, pickPackFee, additionalUnitFee, shippingMarkupPct, shippingMarkupFlat,
        billing_mode, storageFeePerCuFt, storageFeeMode, palletPricingPerMonth, palletCuFt,
        active, createdAt, updatedAt
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)
      ON CONFLICT(clientId) DO UPDATE SET
        pickPackFee = excluded.pickPackFee,
        additionalUnitFee = excluded.additionalUnitFee,
        shippingMarkupPct = excluded.shippingMarkupPct,
        shippingMarkupFlat = excluded.shippingMarkupFlat,
        billing_mode = excluded.billing_mode,
        storageFeePerCuFt = excluded.storageFeePerCuFt,
        storageFeeMode = excluded.storageFeeMode,
        palletPricingPerMonth = excluded.palletPricingPerMonth,
        palletCuFt = excluded.palletCuFt,
        updatedAt = excluded.updatedAt
    `).run(
      clientId,
      input.pickPackFee ?? 3,
      input.additionalUnitFee ?? 0.75,
      input.shippingMarkupPct ?? 0,
      input.shippingMarkupFlat ?? 0,
      input.billing_mode || "label_cost",
      input.storageFeePerCuFt ?? 0,
      input.storageFeeMode || "cubicft",
      input.palletPricingPerMonth ?? 0,
      input.palletCuFt ?? 80,
      now,
      now,
    );
  }

  async generate(input: Required<Pick<GenerateBillingInput, "from" | "to">> & Pick<GenerateBillingInput, "clientId">): Promise<GenerateBillingResult> {
    const storeToClient = this.getStoreToClientMap();
    const allConfigs = new Map(this.listConfigRecords().map((record) => [record.clientId, record]));
    const refRatesMap = new Map(this.listReferenceRates(input.from, input.to).map((record) => [record.orderId, record]));
    const dimsToPackageId = this.getDimsToPackageIdMap();
    const skuPackageMap = this.getSkuPackageMap();
    const clientPackagePrices = this.getClientPackagePriceMap();
    const packagesById = this.getPackageNameMap();
    const shipments = this.listBillingShipments(input.from, input.to);

    let generated = 0;
    let total = 0;

    const insertLine = this.db.prepare(`
      INSERT INTO billing_line_items
        (clientId, orderId, orderNumber, shipDate, lineType, description, qty, unitCost, totalCost, invoiced, createdAt)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?)
      ON CONFLICT(orderId, lineType, description) DO UPDATE SET
        unitCost = excluded.unitCost,
        totalCost = excluded.totalCost,
        clientId = excluded.clientId
    `);

    const insertStorageLine = this.db.prepare(`
      INSERT INTO billing_line_items
        (clientId, orderId, orderNumber, shipDate, lineType, description, qty, unitCost, totalCost, invoiced, createdAt)
      VALUES (?, 0, ?, ?, 'storage', ?, 1, ?, ?, 0, ?)
      ON CONFLICT(orderId, lineType, description) DO UPDATE SET
        unitCost = excluded.unitCost,
        totalCost = excluded.totalCost,
        clientId = excluded.clientId
    `);

    try {
      this.db.exec("BEGIN");

      for (const shipment of shipments) {
        const raw = this.parseJson<Record<string, unknown>>(shipment.raw, {});
        const advancedOptions = this.asRecord(raw.advancedOptions);
        const storeId = Number(advancedOptions.storeId ?? raw.storeId ?? 0) || null;
        const clientId = storeId != null ? (storeToClient.get(storeId) ?? null) : null;
        if (!clientId) continue;
        if (input.clientId && clientId !== input.clientId) continue;

        const config = allConfigs.get(clientId) ?? {
          clientId,
          pickPackFee: 3,
          additionalUnitFee: 0.75,
          packageCostMarkup: 0,
          shippingMarkupPct: 0,
          shippingMarkupFlat: 0,
          billing_mode: "label_cost",
          storageFeePerCuFt: 0,
          storageFeeMode: "cubicft",
          palletPricingPerMonth: 0,
          palletCuFt: 80,
        };
        const items = this.parseJson<Array<Record<string, unknown>>>(shipment.items, []).filter((item) => item.adjustment !== true);
        const totalUnits = items.reduce((sum, item) => sum + Number(item.quantity ?? 1), 0);
        const now = Date.now();
        const billDate = shipment.billingDate;
        const isExternal = !shipment.shipDate;

        {
          const result = insertLine.run(
            clientId,
            shipment.orderId,
            shipment.orderNumber,
            billDate,
            "pickpack",
            "Pick & Pack",
            1,
            config.pickPackFee ?? 3,
            config.pickPackFee ?? 3,
            now,
          ) as RunResult;
          if (result.changes > 0) {
            generated += 1;
            total += config.pickPackFee ?? 3;
          }
        }

        if (totalUnits > 1) {
          const extraUnits = totalUnits - 1;
          const extraUnitFee = config.additionalUnitFee ?? 0.75;
          const extraCost = extraUnits * extraUnitFee;
          const result = insertLine.run(
            clientId,
            shipment.orderId,
            shipment.orderNumber,
            billDate,
            "additional",
            `Additional units (×${extraUnits})`,
            extraUnits,
            extraUnitFee,
            extraCost,
            now,
          ) as RunResult;
          if (result.changes > 0) {
            generated += 1;
            total += extraCost;
          }
        }

        if (isExternal) {
          insertLine.run(clientId, shipment.orderId, shipment.orderNumber, billDate, "shipping", "Externally Shipped", 1, 0, 0, now);
        } else {
          const labelCost = Number(shipment.shipmentCost ?? 0) + Number(shipment.otherCost ?? 0);
          let billedCost = labelCost;
          if ((config.billing_mode ?? "label_cost") === "reference_rate" && !SS_BASELINE_CARRIER_CODES.has(shipment.carrierCode ?? "")) {
            const ref = refRatesMap.get(shipment.orderId);
            const candidates = [ref?.ref_usps_rate, ref?.ref_ups_rate].filter((value) => value != null && value > 0) as number[];
            if (candidates.length > 0) {
              const bestReference = Math.min(...candidates);
              billedCost = labelCost < bestReference ? bestReference : labelCost;
            }
          }

          const markup = billedCost * (Number(config.shippingMarkupPct ?? 0) / 100) + Number(config.shippingMarkupFlat ?? 0);
          const shippingTotal = billedCost + markup;
          const result = insertLine.run(
            clientId,
            shipment.orderId,
            shipment.orderNumber,
            billDate,
            "shipping",
            "Shipping label",
            1,
            shippingTotal,
            shippingTotal,
            now,
          ) as RunResult;
          if (result.changes > 0) {
            generated += 1;
            total += shippingTotal;
          }
        }

        let packageId: number | null = null;
        for (const item of items) {
          const sku = typeof item.sku === "string" ? item.sku : null;
          if (sku && skuPackageMap.has(sku)) {
            packageId = skuPackageMap.get(sku) ?? null;
            break;
          }
        }
        if (!packageId && shipment.dims_l != null && shipment.dims_w != null && shipment.dims_h != null) {
          packageId = dimsToPackageId.get(this.makeDimsKey(shipment.dims_l, shipment.dims_w, shipment.dims_h)) ?? null;
        }
        if (!packageId) {
          const ref = refRatesMap.get(shipment.orderId);
          if (ref?.rate_dims_l != null && ref.rate_dims_w != null && ref.rate_dims_h != null) {
            packageId = dimsToPackageId.get(this.makeDimsKey(ref.rate_dims_l, ref.rate_dims_w, ref.rate_dims_h)) ?? null;
          }
        }

        if (packageId) {
          const packagePrice = clientPackagePrices.get(clientId)?.get(packageId);
          if (packagePrice != null) {
            const packageName = packagesById.get(packageId) ?? `Box #${packageId}`;
            const result = insertLine.run(
              clientId,
              shipment.orderId,
              shipment.orderNumber,
              billDate,
              "package",
              `Box (${packageName})`,
              1,
              packagePrice,
              packagePrice,
              now,
            ) as RunResult;
            if (result.changes > 0) {
              generated += 1;
              if (packagePrice > 0) total += packagePrice;
            }
          }
        }
      }

      const fromMs = Date.parse(`${input.from}T00:00:00`);
      const toMs = Date.parse(`${input.to}T23:59:59`);
      if (Number.isNaN(fromMs) || Number.isNaN(toMs)) {
        throw new Error("Invalid from/to dates for storage");
      }

      for (const config of allConfigs.values()) {
        const rate = Number(config.storageFeePerCuFt ?? 0);
        if (rate <= 0) continue;
        if (input.clientId && config.clientId !== input.clientId) continue;

        let totalCuFtMs = 0;
        const skus = this.listStorageSkus(config.clientId);
        for (const sku of skus) {
          const cuFt = Number(sku.cuFtOverride ?? 0) > 0
            ? Number(sku.cuFtOverride)
            : (Number(sku.productLength ?? 0) * Number(sku.productWidth ?? 0) * Number(sku.productHeight ?? 0)) / 1728;
          if (cuFt <= 0) continue;

          let currentStock = this.getStockBefore(sku.id, fromMs).total;
          let prevTime = fromMs;
          for (const event of this.listLedgerEvents(sku.id, fromMs, toMs)) {
            const sliceMs = Math.max(0, event.createdAt - prevTime);
            if (currentStock > 0) totalCuFtMs += currentStock * cuFt * sliceMs;
            currentStock += event.qty;
            prevTime = event.createdAt;
          }

          const remainingMs = Math.max(0, toMs - prevTime);
          if (currentStock > 0) totalCuFtMs += currentStock * cuFt * remainingMs;
        }

        const totalCuFtDays = totalCuFtMs / (24 * 60 * 60 * 1000);
        const storageCharge = Number((totalCuFtDays * (rate / 30)).toFixed(4));
        if (storageCharge <= 0) continue;

        const result = insertStorageLine.run(
          config.clientId,
          `STORAGE-${input.from}-${input.to}`,
          input.to,
          `Storage ${input.from} to ${input.to}`,
          storageCharge,
          storageCharge,
          Date.now(),
        ) as RunResult;
        if (result.changes > 0) {
          generated += 1;
          total += storageCharge;
        }
      }

      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }

    return { ok: true, generated, total: Number(total.toFixed(2)) };
  }

  async listSummary(query: BillingSummaryQuery): Promise<BillingSummaryRecord[]> {
    let sql = `
      SELECT c.clientId,
             c.name AS clientName,
             COALESCE(SUM(CASE WHEN b.lineType = 'pickpack'   THEN b.totalCost ELSE 0 END), 0) AS pickPackTotal,
             COALESCE(SUM(CASE WHEN b.lineType = 'additional' THEN b.totalCost ELSE 0 END), 0) AS additionalTotal,
             COALESCE(SUM(CASE WHEN b.lineType = 'package'    THEN b.totalCost ELSE 0 END), 0) AS packageTotal,
             COALESCE(SUM(CASE WHEN b.lineType = 'shipping'   THEN b.totalCost ELSE 0 END), 0) AS shippingTotal,
             COALESCE(SUM(CASE WHEN b.lineType = 'storage'    THEN b.totalCost ELSE 0 END), 0) AS storageTotal,
             COUNT(DISTINCT CASE WHEN b.lineType = 'pickpack' THEN b.orderId END)              AS orderCount,
             COALESCE(SUM(b.totalCost), 0)                                                     AS grandTotal
      FROM clients c
      LEFT JOIN billing_line_items b
        ON b.clientId = c.clientId
        AND b.shipDate >= ? AND b.shipDate <= ?
      WHERE c.active = 1
        AND c.name NOT IN ('Manual Orders', 'Rate Browser', 'Api Shipments')
    `;
    const params: Array<string | number> = [query.from ?? "", query.to ?? ""];
    if (query.clientId) {
      sql += " AND c.clientId = ?";
      params.push(query.clientId);
    }
    sql += " GROUP BY c.clientId ORDER BY c.name";

    return this.db.prepare(sql).all(...params) as BillingSummaryRecord[];
  }

  async listDetails(query: Required<BillingDetailsQuery>): Promise<BillingDetailRecord[]> {
    return this.db.prepare(`
      SELECT
        b.orderId,
        b.orderNumber,
        b.shipDate,
        SUM(CASE WHEN b.lineType = 'pickpack'   THEN b.qty       ELSE 0 END) +
        SUM(CASE WHEN b.lineType = 'additional' THEN b.qty       ELSE 0 END) AS totalQty,
        SUM(CASE WHEN b.lineType = 'pickpack'   THEN b.totalCost ELSE 0 END) AS pickpackTotal,
        SUM(CASE WHEN b.lineType = 'additional' THEN b.totalCost ELSE 0 END) AS additionalTotal,
        SUM(CASE WHEN b.lineType = 'package'    THEN b.totalCost ELSE 0 END) AS packageTotal,
        SUM(CASE WHEN b.lineType = 'shipping'   THEN b.totalCost ELSE 0 END) AS shippingTotal,
        (SELECT ROUND(s2.shipmentCost + COALESCE(s2.otherCost, 0), 2)
         FROM shipments s2 WHERE s2.orderId = b.orderId AND s2.voided = 0 LIMIT 1) AS actualLabelCost,
        (SELECT s2.weight_oz FROM shipments s2 WHERE s2.orderId = b.orderId AND s2.voided = 0 LIMIT 1) AS label_weight_oz,
        (SELECT s2.dims_l    FROM shipments s2 WHERE s2.orderId = b.orderId AND s2.voided = 0 LIMIT 1) AS label_dims_l,
        (SELECT s2.dims_w    FROM shipments s2 WHERE s2.orderId = b.orderId AND s2.voided = 0 LIMIT 1) AS label_dims_w,
        (SELECT s2.dims_h    FROM shipments s2 WHERE s2.orderId = b.orderId AND s2.voided = 0 LIMIT 1) AS label_dims_h,
        ol.ref_usps_rate,
        ol.ref_ups_rate,
        COALESCE(
          (SELECT p.name FROM orders o2
           JOIN json_each(o2.items) je
           JOIN inventory_skus isk ON isk.sku = JSON_EXTRACT(je.value, '$.sku')
           JOIN packages p ON p.packageId = isk.packageId
           WHERE o2.orderId = b.orderId AND isk.packageId IS NOT NULL LIMIT 1),
          (SELECT p.name FROM packages p
           WHERE (SELECT s2.dims_l FROM shipments s2 WHERE s2.orderId = b.orderId AND s2.voided = 0 LIMIT 1) IS NOT NULL
             AND p.source = 'custom'
             AND ROUND(p.length) = ROUND((SELECT s2.dims_l FROM shipments s2 WHERE s2.orderId = b.orderId AND s2.voided = 0 LIMIT 1))
             AND ROUND(p.width)  = ROUND((SELECT s2.dims_w FROM shipments s2 WHERE s2.orderId = b.orderId AND s2.voided = 0 LIMIT 1))
             AND ROUND(p.height) = ROUND((SELECT s2.dims_h FROM shipments s2 WHERE s2.orderId = b.orderId AND s2.voided = 0 LIMIT 1))
           LIMIT 1),
          (SELECT p.name FROM packages p
           WHERE ol.rate_dims_l IS NOT NULL AND p.source = 'custom'
             AND ROUND(p.length) = ROUND(ol.rate_dims_l)
             AND ROUND(p.width)  = ROUND(ol.rate_dims_w)
             AND ROUND(p.height) = ROUND(ol.rate_dims_h)
           LIMIT 1)
        ) AS packageName,
        (SELECT GROUP_CONCAT(JSON_EXTRACT(je.value, '$.name'), ' | ')
         FROM orders o2 JOIN json_each(o2.items) je
         WHERE o2.orderId = b.orderId
           AND COALESCE(JSON_EXTRACT(je.value, '$.adjustment'), 0) = 0) AS itemNames,
        (SELECT GROUP_CONCAT(COALESCE(JSON_EXTRACT(je.value, '$.sku'), ''), ' | ')
         FROM orders o2 JOIN json_each(o2.items) je
         WHERE o2.orderId = b.orderId
           AND COALESCE(JSON_EXTRACT(je.value, '$.adjustment'), 0) = 0) AS itemSkus
      FROM billing_line_items b
      LEFT JOIN order_local ol ON ol.orderId = b.orderId
      WHERE b.clientId = ? AND b.shipDate >= ? AND b.shipDate <= ?
      GROUP BY b.orderId
      ORDER BY b.shipDate, b.orderId
    `).all(query.clientId, query.from, query.to) as BillingDetailRecord[];
  }

  async getInvoice(clientId: number, from: string, to: string): Promise<BillingInvoiceRecord | null> {
    const client = this.db.prepare(`
      SELECT clientId, name
      FROM clients
      WHERE clientId = ?
      LIMIT 1
    `).get(clientId) as BillingClientRecord | undefined;
    if (!client) return null;

    const summary = this.db.prepare(`
      SELECT
        COALESCE(SUM(CASE WHEN lineType = 'pickpack' THEN totalCost ELSE 0 END), 0) AS pickPackTotal,
        COALESCE(SUM(CASE WHEN lineType = 'additional' THEN totalCost ELSE 0 END), 0) AS additionalTotal,
        COALESCE(SUM(CASE WHEN lineType = 'package' THEN totalCost ELSE 0 END), 0) AS packageTotal,
        COALESCE(SUM(CASE WHEN lineType = 'shipping' THEN totalCost ELSE 0 END), 0) AS shippingTotal,
        COALESCE(SUM(CASE WHEN lineType = 'storage' THEN totalCost ELSE 0 END), 0) AS storageTotal,
        COUNT(DISTINCT CASE WHEN lineType = 'pickpack' THEN orderId END) AS orderCount,
        COALESCE(SUM(totalCost), 0) AS grandTotal
      FROM billing_line_items
      WHERE clientId = ? AND shipDate >= ? AND shipDate <= ?
    `).get(clientId, from, to) as BillingInvoiceRecord["summary"] | undefined;

    const details = this.db.prepare(`
      SELECT
        b.orderId,
        b.orderNumber,
        b.shipDate,
        SUM(CASE WHEN b.lineType = 'pickpack' THEN b.qty ELSE 0 END) AS baseQty,
        SUM(CASE WHEN b.lineType = 'additional' THEN b.qty ELSE 0 END) AS addlQty,
        SUM(CASE WHEN b.lineType = 'pickpack' THEN b.totalCost ELSE 0 END) AS pickpackAmt,
        SUM(CASE WHEN b.lineType = 'additional' THEN b.totalCost ELSE 0 END) AS additionalAmt,
        SUM(CASE WHEN b.lineType = 'shipping' THEN b.totalCost ELSE 0 END) AS shippingAmt,
        SUM(CASE WHEN b.lineType = 'storage' THEN b.totalCost ELSE 0 END) AS storageAmt,
        SUM(b.totalCost) AS rowTotal,
        (
          SELECT GROUP_CONCAT(JSON_EXTRACT(je.value, '$.sku'), ', ')
          FROM orders o2 JOIN json_each(o2.items) je
          WHERE o2.orderId = b.orderId
            AND COALESCE(JSON_EXTRACT(je.value, '$.adjustment'), 0) = 0
        ) AS skus
      FROM billing_line_items b
      WHERE b.clientId = ? AND b.shipDate >= ? AND b.shipDate <= ?
      GROUP BY b.orderId
      ORDER BY b.shipDate, b.orderId
    `).all(clientId, from, to) as BillingInvoiceDetailRecord[];

    return {
      clientId,
      clientName: client.name,
      from,
      to,
      summary: {
        pickPackTotal: Number(summary?.pickPackTotal ?? 0),
        additionalTotal: Number(summary?.additionalTotal ?? 0),
        packageTotal: Number(summary?.packageTotal ?? 0),
        shippingTotal: Number(summary?.shippingTotal ?? 0),
        storageTotal: Number(summary?.storageTotal ?? 0),
        orderCount: Number(summary?.orderCount ?? 0),
        grandTotal: Number(summary?.grandTotal ?? 0),
      },
      details: details.map((detail) => ({
        ...detail,
        baseQty: Number(detail.baseQty ?? 0),
        addlQty: Number(detail.addlQty ?? 0),
        pickpackAmt: Number(detail.pickpackAmt ?? 0),
        additionalAmt: Number(detail.additionalAmt ?? 0),
        shippingAmt: Number(detail.shippingAmt ?? 0),
        storageAmt: Number(detail.storageAmt ?? 0),
        rowTotal: Number(detail.rowTotal ?? 0),
      })),
    };
  }

  async listPackagePrices(clientId: number): Promise<BillingPackagePriceRecord[]> {
    return this.db.prepare(`
      SELECT cpp.packageId, cpp.price, cpp.is_custom, p.name, p.length, p.width, p.height
      FROM client_package_prices cpp
      JOIN packages p ON p.packageId = cpp.packageId
      WHERE cpp.clientId = ?
      ORDER BY p.name
    `).all(clientId) as BillingPackagePriceRecord[];
  }

  async savePackagePrices(input: { clientId: number; prices: SaveBillingPackagePriceInput[] | undefined }): Promise<void> {
    const now = Date.now();
    const upsert = this.db.prepare(`
      INSERT INTO client_package_prices (clientId, packageId, price, is_custom, updatedAt)
      VALUES (?, ?, ?, 1, ?)
      ON CONFLICT(clientId, packageId) DO UPDATE SET price = excluded.price, is_custom = 1, updatedAt = excluded.updatedAt
    `);
    try {
      this.db.exec("BEGIN");
      for (const price of input.prices ?? []) {
        upsert.run(input.clientId, price.packageId, Number(price.price) || 0, now);
      }
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  async setDefaultPackagePrice(packageId: number, price: number): Promise<SetDefaultBillingPackagePriceResult> {
    const clientIds = (this.db.prepare("SELECT clientId FROM clients").all() as Array<{ clientId: number }>)
      .map((record) => record.clientId)
      .filter((clientId) => !HOUSE_ACCOUNT_IDS.has(clientId));

    if (clientIds.length === 0) {
      return { ok: true, updated: 0, skipped: 0 };
    }

    const now = Date.now();
    const upsert = this.db.prepare(`
      INSERT INTO client_package_prices (clientId, packageId, price, is_custom, updatedAt)
      VALUES (?, ?, ?, 0, ?)
      ON CONFLICT(clientId, packageId) DO UPDATE
        SET price = excluded.price, updatedAt = excluded.updatedAt
        WHERE is_custom = 0
    `);

    let updated = 0;
    try {
      this.db.exec("BEGIN");
      for (const clientId of clientIds) {
        const result = upsert.run(clientId, packageId, Number(price) || 0, now) as RunResult;
        if (result.changes > 0) updated += 1;
      }
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }

    return {
      ok: true,
      updated,
      skipped: clientIds.length - updated,
    };
  }

  async listOrdersMissingReferenceRatesForFetch(storeIds: number[]): Promise<BillingFetchReferenceRateOrderRecord[]> {
    if (storeIds.length === 0) {
      return [];
    }

    const placeholders = storeIds.map(() => "?").join(",");
    return this.db.prepare(`
      SELECT
        s.orderId,
        s.weight_oz AS weightOz,
        s.dims_l,
        s.dims_w,
        s.dims_h,
        SUBSTR(COALESCE(JSON_EXTRACT(o.raw, '$.shipTo.postalCode'), o.shipToPostalCode), 1, 5) AS zip5
      FROM shipments s
      JOIN orders o ON o.orderId = s.orderId
      LEFT JOIN order_local ol ON ol.orderId = s.orderId
      WHERE COALESCE(JSON_EXTRACT(o.raw, '$.advancedOptions.storeId'), JSON_EXTRACT(o.raw, '$.storeId'), o.storeId) IN (${placeholders})
        AND s.voided = 0
        AND s.weight_oz IS NOT NULL
        AND s.dims_l IS NOT NULL
        AND s.dims_w IS NOT NULL
        AND s.dims_h IS NOT NULL
        AND (ol.ref_usps_rate IS NULL OR ol.ref_ups_rate IS NULL)
    `).all(...storeIds) as BillingFetchReferenceRateOrderRecord[];
  }

  async listOrdersMissingReferenceRatesForBackfill(input: BackfillBillingReferenceRatesInput): Promise<BillingBackfillReferenceRateOrderRecord[]> {
    const conditions = [
      "s.voided = 0",
      "bc.billing_mode = 'reference_rate'",
      "(ol.ref_usps_rate IS NULL AND ol.ref_ups_rate IS NULL)",
    ];
    const params: Array<string> = [];

    if (input.from) {
      conditions.push("s.shipDate >= ?");
      params.push(input.from);
    }
    if (input.to) {
      conditions.push("s.shipDate <= ?");
      params.push(input.to);
    }

    return this.db.prepare(`
      SELECT
        o.orderId,
        o.orderNumber,
        CAST(COALESCE(o.weightValue, s.weight_oz, 1) AS INTEGER) AS weightOz,
        SUBSTR(COALESCE(o.shipToPostalCode, JSON_EXTRACT(o.raw, '$.shipTo.postalCode')), 1, 5) AS zip5
      FROM orders o
      JOIN shipments s ON s.orderId = o.orderId
      JOIN clients c ON EXISTS (
        SELECT 1 FROM json_each(c.storeIds) si
        WHERE CAST(si.value AS INTEGER) = CAST(COALESCE(o.storeId, JSON_EXTRACT(o.raw, '$.advancedOptions.storeId'), JSON_EXTRACT(o.raw, '$.storeId')) AS INTEGER)
      )
      JOIN billing_config bc ON bc.clientId = c.clientId
      LEFT JOIN order_local ol ON ol.orderId = o.orderId
      WHERE ${conditions.join("\n        AND ")}
    `).all(...params) as BillingBackfillReferenceRateOrderRecord[];
  }

  async findCachedReferenceRateCandidates(weightOz: number, zip5: string): Promise<RateDto[] | null> {
    const row = this.db.prepare(`
      SELECT rates
      FROM rate_cache
      WHERE cache_key LIKE ?
      LIMIT 1
    `).get(`%|${weightOz}|${zip5}|%`) as { rates: string } | undefined;

    if (!row?.rates) {
      return null;
    }

    try {
      return JSON.parse(row.rates) as RateDto[];
    } catch {
      return null;
    }
  }

  async saveBackfilledReferenceRates(orderId: number, refUspsRate: number | null, refUpsRate: number | null): Promise<void> {
    this.db.prepare(`
      INSERT INTO order_local (orderId, ref_usps_rate, ref_ups_rate, updatedAt)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(orderId) DO UPDATE SET
        ref_usps_rate = CASE WHEN excluded.ref_usps_rate IS NOT NULL THEN excluded.ref_usps_rate ELSE ref_usps_rate END,
        ref_ups_rate = CASE WHEN excluded.ref_ups_rate IS NOT NULL THEN excluded.ref_ups_rate ELSE ref_ups_rate END,
        updatedAt = excluded.updatedAt
    `).run(orderId, refUspsRate, refUpsRate, Date.now());
  }

  private getStoreToClientMap(): Map<number, number> {
    const map = new Map<number, number>();
    const rows = this.db.prepare(`
      SELECT clientId, storeIds
      FROM clients
      WHERE active = 1
    `).all() as BillingStoreClientRecord[];
    for (const row of rows) {
      for (const storeId of this.parseJson<number[]>(row.storeIds, [])) {
        map.set(Number(storeId), row.clientId);
      }
    }
    return map;
  }

  private listReferenceRates(from: string, to: string): BillingReferenceRateRecord[] {
    return this.db.prepare(`
      SELECT ol.orderId, ol.ref_usps_rate, ol.ref_ups_rate, ol.rate_dims_l, ol.rate_dims_w, ol.rate_dims_h
      FROM order_local ol
      JOIN shipments s ON s.orderId = ol.orderId
      WHERE s.voided = 0 AND s.shipDate >= ? AND s.shipDate <= ?
    `).all(from, to) as BillingReferenceRateRecord[];
  }

  private getDimsToPackageIdMap(): Map<string, number> {
    const rows = this.db.prepare(`
      SELECT packageId, length, width, height
      FROM packages
      WHERE source = 'custom'
    `).all() as BillingPackageDimensionRecord[];
    return new Map(rows.map((row) => [this.makeDimsKey(row.length, row.width, row.height), row.packageId]));
  }

  private getSkuPackageMap(): Map<string, number> {
    const rows = this.db.prepare(`
      SELECT sku, packageId
      FROM inventory_skus
      WHERE packageId IS NOT NULL AND sku IS NOT NULL
    `).all() as BillingSkuPackageRecord[];
    return new Map(rows.filter((row) => row.sku && row.packageId != null).map((row) => [row.sku as string, row.packageId as number]));
  }

  private getClientPackagePriceMap(): Map<number, Map<number, number>> {
    const result = new Map<number, Map<number, number>>();
    const rows = this.db.prepare(`
      SELECT clientId, packageId, price
      FROM client_package_prices
    `).all() as BillingClientPackagePriceRecord[];
    for (const row of rows) {
      if (!result.has(row.clientId)) result.set(row.clientId, new Map());
      result.get(row.clientId)?.set(row.packageId, row.price);
    }
    return result;
  }

  private getPackageNameMap(): Map<number, string> {
    const rows = this.db.prepare(`
      SELECT packageId, name
      FROM packages
    `).all() as BillingPackageNameRecord[];
    return new Map(rows.map((row) => [row.packageId, row.name]));
  }

  private listBillingShipments(from: string, to: string): BillingShipmentRecord[] {
    return this.db.prepare(`
      WITH ship AS (
        SELECT orderId, shipDate, shipmentCost, otherCost, carrierCode, dims_l, dims_w, dims_h
        FROM shipments
        WHERE voided = 0
      )
      SELECT
        o.orderId, o.orderNumber, o.items, o.raw,
        ship.shipDate,
        COALESCE(ship.shipDate, o.orderDate) AS billingDate,
        COALESCE(ship.shipmentCost, 0) AS shipmentCost,
        COALESCE(ship.otherCost, 0) AS otherCost,
        ship.carrierCode,
        ship.dims_l, ship.dims_w, ship.dims_h,
        COALESCE(ol.external_shipped, 0) AS external_shipped
      FROM orders o
      LEFT JOIN ship ON ship.orderId = o.orderId
      LEFT JOIN order_local ol ON ol.orderId = o.orderId
      WHERE o.orderStatus = 'shipped'
        AND COALESCE(ol.external_shipped, 0) = 0
        AND COALESCE(ship.shipDate, o.orderDate) >= ?
        AND COALESCE(ship.shipDate, o.orderDate) <= ?
      ORDER BY COALESCE(ship.shipDate, o.orderDate)
    `).all(from, to) as BillingShipmentRecord[];
  }

  private listStorageSkus(clientId: number): BillingStorageSkuRecord[] {
    return this.db.prepare(`
      SELECT id, productLength, productWidth, productHeight, cuFtOverride
      FROM inventory_skus
      WHERE clientId = ? AND active = 1
    `).all(clientId) as BillingStorageSkuRecord[];
  }

  private getStockBefore(inventorySkuId: number, beforeMs: number): BillingLedgerStockTotalRecord {
    return this.db.prepare(`
      SELECT COALESCE(SUM(qty), 0) AS total
      FROM inventory_ledger
      WHERE invSkuId = ? AND createdAt < ?
    `).get(inventorySkuId, beforeMs) as BillingLedgerStockTotalRecord;
  }

  private listLedgerEvents(inventorySkuId: number, fromMs: number, toMs: number): BillingLedgerEventRecord[] {
    return this.db.prepare(`
      SELECT createdAt, qty
      FROM inventory_ledger
      WHERE invSkuId = ? AND createdAt >= ? AND createdAt <= ?
      ORDER BY createdAt ASC
    `).all(inventorySkuId, fromMs, toMs) as BillingLedgerEventRecord[];
  }

  private parseJson<T>(value: string | null, fallback: T): T {
    if (!value) return fallback;
    try {
      return JSON.parse(value) as T;
    } catch {
      return fallback;
    }
  }

  private asRecord(value: unknown): Record<string, unknown> {
    return value && typeof value === "object" ? value as Record<string, unknown> : {};
  }

  private makeDimsKey(length: number | null, width: number | null, height: number | null): string {
    return `${Math.round(Number(length ?? 0))}x${Math.round(Number(width ?? 0))}x${Math.round(Number(height ?? 0))}`;
  }
}
