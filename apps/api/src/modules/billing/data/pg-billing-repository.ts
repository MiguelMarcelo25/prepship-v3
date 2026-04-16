import type { PgClient } from "../../../../../../../packages/shared/src/postgres/database.js";
import type {
  BackfillBillingReferenceRatesInput,
  BillingDetailsQuery,
  GenerateBillingInput,
  GenerateBillingResult,
  SaveBillingPackagePriceInput,
  BillingSummaryQuery,
  SetDefaultBillingPackagePriceResult,
  UpdateBillingConfigInput,
} from "../../../../../../../packages/contracts/src/billing/contracts.js";
import { SS_BASELINE_CARRIER_CODES } from "../../../common/prepship-config.js";
import type { BillingRepository } from "../application/billing-repository.js";
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
} from "../domain/billing.js";
import type { RateDto } from "../../../../../../../packages/contracts/src/rates/contracts.js";

const HOUSE_ACCOUNT_IDS = new Set([3, 4]);

export class PgBillingRepository implements BillingRepository {
  constructor(private readonly sql: PgClient) {}

  async listBillableClients(): Promise<BillingClientRecord[]> {
    const rows = await this.sql`
      SELECT "clientId", name
      FROM clients
      WHERE active = 1
        AND name NOT IN ('Manual Orders', 'Rate Browser', 'Api Shipments')
      ORDER BY name
    `;
    return rows as BillingClientRecord[];
  }

  async listConfigRecords(): Promise<BillingConfigRecord[]> {
    const rows = await this.sql`
      SELECT
        "clientId",
        "pickPackFee",
        "additionalUnitFee",
        "packageCostMarkup",
        "shippingMarkupPct",
        "shippingMarkupFlat",
        billing_mode,
        "storageFeePerCuFt",
        "storageFeeMode",
        "palletPricingPerMonth",
        "palletCuFt"
      FROM billing_config
    `;
    return rows as BillingConfigRecord[];
  }

  async listReferenceRateStoreIds(): Promise<number[]> {
    const rows = await this.sql`
      SELECT c."storeIds"
      FROM billing_config bc
      JOIN clients c ON c."clientId" = bc."clientId"
      WHERE bc.billing_mode = 'reference_rate'
        AND c.active = 1
    ` as Array<{ storeIds: string | null }>;

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
    await this.sql`
      INSERT INTO billing_config (
        "clientId", "pickPackFee", "additionalUnitFee", "shippingMarkupPct", "shippingMarkupFlat",
        billing_mode, "storageFeePerCuFt", "storageFeeMode", "palletPricingPerMonth", "palletCuFt",
        active, "createdAt", "updatedAt"
      )
      VALUES (
        ${clientId},
        ${input.pickPackFee ?? 3},
        ${input.additionalUnitFee ?? 0.75},
        ${input.shippingMarkupPct ?? 0},
        ${input.shippingMarkupFlat ?? 0},
        ${input.billing_mode || "label_cost"},
        ${input.storageFeePerCuFt ?? 0},
        ${input.storageFeeMode || "cubicft"},
        ${input.palletPricingPerMonth ?? 0},
        ${input.palletCuFt ?? 80},
        1,
        ${now},
        ${now}
      )
      ON CONFLICT("clientId") DO UPDATE SET
        "pickPackFee" = EXCLUDED."pickPackFee",
        "additionalUnitFee" = EXCLUDED."additionalUnitFee",
        "shippingMarkupPct" = EXCLUDED."shippingMarkupPct",
        "shippingMarkupFlat" = EXCLUDED."shippingMarkupFlat",
        billing_mode = EXCLUDED.billing_mode,
        "storageFeePerCuFt" = EXCLUDED."storageFeePerCuFt",
        "storageFeeMode" = EXCLUDED."storageFeeMode",
        "palletPricingPerMonth" = EXCLUDED."palletPricingPerMonth",
        "palletCuFt" = EXCLUDED."palletCuFt",
        "updatedAt" = EXCLUDED."updatedAt"
    `;
  }

  async generate(input: Required<Pick<GenerateBillingInput, "from" | "to">> & Pick<GenerateBillingInput, "clientId">): Promise<GenerateBillingResult> {
    const storeToClient = await this.getStoreToClientMap();
    const allConfigs = new Map((await this.listConfigRecords()).map((record) => [record.clientId, record]));
    const refRatesMap = new Map((await this.listReferenceRates(input.from, input.to)).map((record) => [record.orderId, record]));
    const dimsToPackageId = await this.getDimsToPackageIdMap();
    const skuPackageMap = await this.getSkuPackageMap();
    const clientPackagePrices = await this.getClientPackagePriceMap();
    const packagesById = await this.getPackageNameMap();
    const shipments = await this.listBillingShipments(input.from, input.to);

    let generated = 0;
    let total = 0;

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

      // Pick & Pack line
      {
        const result = await this.sql`
          INSERT INTO billing_line_items
            ("clientId", "orderId", "orderNumber", "shipDate", "lineType", description, qty, "unitCost", "totalCost", invoiced, "createdAt")
          VALUES (${clientId}, ${shipment.orderId}, ${shipment.orderNumber}, ${billDate}, 'pickpack', 'Pick & Pack', 1, ${config.pickPackFee ?? 3}, ${config.pickPackFee ?? 3}, 0, ${now})
          ON CONFLICT("orderId", "lineType", description) DO UPDATE SET
            "unitCost" = EXCLUDED."unitCost",
            "totalCost" = EXCLUDED."totalCost",
            "clientId" = EXCLUDED."clientId"
        `;
        // Neon HTTP driver doesn't return changes count the same way, count as generated
        generated += 1;
        total += config.pickPackFee ?? 3;
      }

      // Additional units line
      if (totalUnits > 1) {
        const extraUnits = totalUnits - 1;
        const extraUnitFee = config.additionalUnitFee ?? 0.75;
        const extraCost = extraUnits * extraUnitFee;
        await this.sql`
          INSERT INTO billing_line_items
            ("clientId", "orderId", "orderNumber", "shipDate", "lineType", description, qty, "unitCost", "totalCost", invoiced, "createdAt")
          VALUES (${clientId}, ${shipment.orderId}, ${shipment.orderNumber}, ${billDate}, 'additional', ${`Additional units (×${extraUnits})`}, ${extraUnits}, ${extraUnitFee}, ${extraCost}, 0, ${now})
          ON CONFLICT("orderId", "lineType", description) DO UPDATE SET
            "unitCost" = EXCLUDED."unitCost",
            "totalCost" = EXCLUDED."totalCost",
            "clientId" = EXCLUDED."clientId"
        `;
        generated += 1;
        total += extraCost;
      }

      // Shipping line
      if (isExternal) {
        await this.sql`
          INSERT INTO billing_line_items
            ("clientId", "orderId", "orderNumber", "shipDate", "lineType", description, qty, "unitCost", "totalCost", invoiced, "createdAt")
          VALUES (${clientId}, ${shipment.orderId}, ${shipment.orderNumber}, ${billDate}, 'shipping', 'Externally Shipped', 1, 0, 0, 0, ${now})
          ON CONFLICT("orderId", "lineType", description) DO UPDATE SET
            "unitCost" = EXCLUDED."unitCost",
            "totalCost" = EXCLUDED."totalCost",
            "clientId" = EXCLUDED."clientId"
        `;
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
        await this.sql`
          INSERT INTO billing_line_items
            ("clientId", "orderId", "orderNumber", "shipDate", "lineType", description, qty, "unitCost", "totalCost", invoiced, "createdAt")
          VALUES (${clientId}, ${shipment.orderId}, ${shipment.orderNumber}, ${billDate}, 'shipping', 'Shipping label', 1, ${shippingTotal}, ${shippingTotal}, 0, ${now})
          ON CONFLICT("orderId", "lineType", description) DO UPDATE SET
            "unitCost" = EXCLUDED."unitCost",
            "totalCost" = EXCLUDED."totalCost",
            "clientId" = EXCLUDED."clientId"
        `;
        generated += 1;
        total += shippingTotal;
      }

      // Package line
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
          await this.sql`
            INSERT INTO billing_line_items
              ("clientId", "orderId", "orderNumber", "shipDate", "lineType", description, qty, "unitCost", "totalCost", invoiced, "createdAt")
            VALUES (${clientId}, ${shipment.orderId}, ${shipment.orderNumber}, ${billDate}, 'package', ${`Box (${packageName})`}, 1, ${packagePrice}, ${packagePrice}, 0, ${now})
            ON CONFLICT("orderId", "lineType", description) DO UPDATE SET
              "unitCost" = EXCLUDED."unitCost",
              "totalCost" = EXCLUDED."totalCost",
              "clientId" = EXCLUDED."clientId"
          `;
          generated += 1;
          if (packagePrice > 0) total += packagePrice;
        }
      }
    }

    // Storage billing
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
      const skus = await this.listStorageSkus(config.clientId);
      for (const sku of skus) {
        const cuFt = Number(sku.cuFtOverride ?? 0) > 0
          ? Number(sku.cuFtOverride)
          : (Number(sku.productLength ?? 0) * Number(sku.productWidth ?? 0) * Number(sku.productHeight ?? 0)) / 1728;
        if (cuFt <= 0) continue;

        let currentStock = (await this.getStockBefore(sku.id, fromMs)).total;
        let prevTime = fromMs;
        for (const event of await this.listLedgerEvents(sku.id, fromMs, toMs)) {
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

      await this.sql`
        INSERT INTO billing_line_items
          ("clientId", "orderId", "orderNumber", "shipDate", "lineType", description, qty, "unitCost", "totalCost", invoiced, "createdAt")
        VALUES (${config.clientId}, 0, ${`STORAGE-${input.from}-${input.to}`}, ${input.to}, 'storage', ${`Storage ${input.from} to ${input.to}`}, 1, ${storageCharge}, ${storageCharge}, 0, ${Date.now()})
        ON CONFLICT("orderId", "lineType", description) DO UPDATE SET
          "unitCost" = EXCLUDED."unitCost",
          "totalCost" = EXCLUDED."totalCost",
          "clientId" = EXCLUDED."clientId"
      `;
      generated += 1;
      total += storageCharge;
    }

    return { ok: true, generated, total: Number(total.toFixed(2)) };
  }

  async listSummary(query: BillingSummaryQuery): Promise<BillingSummaryRecord[]> {
    const rows = await this.sql`
      SELECT c."clientId",
             c.name AS "clientName",
             COALESCE(SUM(CASE WHEN b."lineType" = 'pickpack'   THEN b."totalCost" ELSE 0 END), 0) AS "pickPackTotal",
             COALESCE(SUM(CASE WHEN b."lineType" = 'additional' THEN b."totalCost" ELSE 0 END), 0) AS "additionalTotal",
             COALESCE(SUM(CASE WHEN b."lineType" = 'package'    THEN b."totalCost" ELSE 0 END), 0) AS "packageTotal",
             COALESCE(SUM(CASE WHEN b."lineType" = 'shipping'   THEN b."totalCost" ELSE 0 END), 0) AS "shippingTotal",
             COALESCE(SUM(CASE WHEN b."lineType" = 'storage'    THEN b."totalCost" ELSE 0 END), 0) AS "storageTotal",
             COUNT(DISTINCT CASE WHEN b."lineType" = 'pickpack' THEN b."orderId" END)              AS "orderCount",
             COALESCE(SUM(b."totalCost"), 0)                                                       AS "grandTotal"
      FROM clients c
      LEFT JOIN billing_line_items b
        ON b."clientId" = c."clientId"
        AND b."shipDate" >= ${query.from ?? ""} AND b."shipDate" <= ${query.to ?? ""}
      WHERE c.active = 1
        AND c.name NOT IN ('Manual Orders', 'Rate Browser', 'Api Shipments')
        AND (${query.clientId ?? null}::int IS NULL OR c."clientId" = ${query.clientId ?? null})
      GROUP BY c."clientId"
      ORDER BY c.name
    `;
    return rows as BillingSummaryRecord[];
  }

  async listDetails(query: Required<BillingDetailsQuery>): Promise<BillingDetailRecord[]> {
    const rows = await this.sql`
      SELECT
        b."orderId",
        b."orderNumber",
        b."shipDate",
        SUM(CASE WHEN b."lineType" = 'pickpack'   THEN b.qty       ELSE 0 END) +
        SUM(CASE WHEN b."lineType" = 'additional' THEN b.qty       ELSE 0 END) AS "totalQty",
        SUM(CASE WHEN b."lineType" = 'pickpack'   THEN b."totalCost" ELSE 0 END) AS "pickpackTotal",
        SUM(CASE WHEN b."lineType" = 'additional' THEN b."totalCost" ELSE 0 END) AS "additionalTotal",
        SUM(CASE WHEN b."lineType" = 'package'    THEN b."totalCost" ELSE 0 END) AS "packageTotal",
        SUM(CASE WHEN b."lineType" = 'shipping'   THEN b."totalCost" ELSE 0 END) AS "shippingTotal",
        (SELECT ROUND(s2."shipmentCost" + COALESCE(s2."otherCost", 0), 2)
         FROM shipments s2 WHERE s2."orderId" = b."orderId" AND s2.voided = 0 LIMIT 1) AS "actualLabelCost",
        (SELECT s2.weight_oz FROM shipments s2 WHERE s2."orderId" = b."orderId" AND s2.voided = 0 LIMIT 1) AS label_weight_oz,
        (SELECT s2.dims_l    FROM shipments s2 WHERE s2."orderId" = b."orderId" AND s2.voided = 0 LIMIT 1) AS label_dims_l,
        (SELECT s2.dims_w    FROM shipments s2 WHERE s2."orderId" = b."orderId" AND s2.voided = 0 LIMIT 1) AS label_dims_w,
        (SELECT s2.dims_h    FROM shipments s2 WHERE s2."orderId" = b."orderId" AND s2.voided = 0 LIMIT 1) AS label_dims_h,
        ol.ref_usps_rate,
        ol.ref_ups_rate,
        COALESCE(
          (SELECT p.name FROM orders o2
           , jsonb_array_elements(o2.items::jsonb) AS je(value)
           JOIN inventory_skus isk ON isk.sku = je.value->>'sku'
           JOIN packages p ON p."packageId" = isk."packageId"
           WHERE o2."orderId" = b."orderId" AND isk."packageId" IS NOT NULL LIMIT 1),
          (SELECT p.name FROM packages p
           WHERE (SELECT s2.dims_l FROM shipments s2 WHERE s2."orderId" = b."orderId" AND s2.voided = 0 LIMIT 1) IS NOT NULL
             AND p.source = 'custom'
             AND ROUND(p.length) = ROUND((SELECT s2.dims_l FROM shipments s2 WHERE s2."orderId" = b."orderId" AND s2.voided = 0 LIMIT 1))
             AND ROUND(p.width)  = ROUND((SELECT s2.dims_w FROM shipments s2 WHERE s2."orderId" = b."orderId" AND s2.voided = 0 LIMIT 1))
             AND ROUND(p.height) = ROUND((SELECT s2.dims_h FROM shipments s2 WHERE s2."orderId" = b."orderId" AND s2.voided = 0 LIMIT 1))
           LIMIT 1),
          (SELECT p.name FROM packages p
           WHERE ol.rate_dims_l IS NOT NULL AND p.source = 'custom'
             AND ROUND(p.length) = ROUND(ol.rate_dims_l)
             AND ROUND(p.width)  = ROUND(ol.rate_dims_w)
             AND ROUND(p.height) = ROUND(ol.rate_dims_h)
           LIMIT 1)
        ) AS "packageName",
        (SELECT STRING_AGG(je.value->>'name', ' | ')
         FROM orders o2, jsonb_array_elements(o2.items::jsonb) AS je(value)
         WHERE o2."orderId" = b."orderId"
           AND COALESCE((je.value->>'adjustment')::text, '0') = '0') AS "itemNames",
        (SELECT STRING_AGG(COALESCE(je.value->>'sku', ''), ' | ')
         FROM orders o2, jsonb_array_elements(o2.items::jsonb) AS je(value)
         WHERE o2."orderId" = b."orderId"
           AND COALESCE((je.value->>'adjustment')::text, '0') = '0') AS "itemSkus"
      FROM billing_line_items b
      LEFT JOIN order_local ol ON ol."orderId" = b."orderId"
      WHERE b."clientId" = ${query.clientId} AND b."shipDate" >= ${query.from} AND b."shipDate" <= ${query.to}
      GROUP BY b."orderId", b."orderNumber", b."shipDate", ol.ref_usps_rate, ol.ref_ups_rate, ol.rate_dims_l, ol.rate_dims_w, ol.rate_dims_h
      ORDER BY b."shipDate", b."orderId"
    `;
    return rows as BillingDetailRecord[];
  }

  async getInvoice(clientId: number, from: string, to: string): Promise<BillingInvoiceRecord | null> {
    const clientRows = await this.sql`
      SELECT "clientId", name
      FROM clients
      WHERE "clientId" = ${clientId}
      LIMIT 1
    `;
    const client = clientRows[0] as BillingClientRecord | undefined;
    if (!client) return null;

    const summaryRows = await this.sql`
      SELECT
        COALESCE(SUM(CASE WHEN "lineType" = 'pickpack' THEN "totalCost" ELSE 0 END), 0) AS "pickPackTotal",
        COALESCE(SUM(CASE WHEN "lineType" = 'additional' THEN "totalCost" ELSE 0 END), 0) AS "additionalTotal",
        COALESCE(SUM(CASE WHEN "lineType" = 'package' THEN "totalCost" ELSE 0 END), 0) AS "packageTotal",
        COALESCE(SUM(CASE WHEN "lineType" = 'shipping' THEN "totalCost" ELSE 0 END), 0) AS "shippingTotal",
        COALESCE(SUM(CASE WHEN "lineType" = 'storage' THEN "totalCost" ELSE 0 END), 0) AS "storageTotal",
        COUNT(DISTINCT CASE WHEN "lineType" = 'pickpack' THEN "orderId" END) AS "orderCount",
        COALESCE(SUM("totalCost"), 0) AS "grandTotal"
      FROM billing_line_items
      WHERE "clientId" = ${clientId} AND "shipDate" >= ${from} AND "shipDate" <= ${to}
    `;
    const summary = summaryRows[0] as BillingInvoiceRecord["summary"] | undefined;

    const details = await this.sql`
      SELECT
        b."orderId",
        b."orderNumber",
        b."shipDate",
        SUM(CASE WHEN b."lineType" = 'pickpack' THEN b.qty ELSE 0 END) AS "baseQty",
        SUM(CASE WHEN b."lineType" = 'additional' THEN b.qty ELSE 0 END) AS "addlQty",
        SUM(CASE WHEN b."lineType" = 'pickpack' THEN b."totalCost" ELSE 0 END) AS "pickpackAmt",
        SUM(CASE WHEN b."lineType" = 'additional' THEN b."totalCost" ELSE 0 END) AS "additionalAmt",
        SUM(CASE WHEN b."lineType" = 'shipping' THEN b."totalCost" ELSE 0 END) AS "shippingAmt",
        SUM(CASE WHEN b."lineType" = 'storage' THEN b."totalCost" ELSE 0 END) AS "storageAmt",
        SUM(b."totalCost") AS "rowTotal",
        (
          SELECT STRING_AGG(je.value->>'sku', ', ')
          FROM orders o2, jsonb_array_elements(o2.items::jsonb) AS je(value)
          WHERE o2."orderId" = b."orderId"
            AND COALESCE((je.value->>'adjustment')::text, '0') = '0'
        ) AS skus
      FROM billing_line_items b
      WHERE b."clientId" = ${clientId} AND b."shipDate" >= ${from} AND b."shipDate" <= ${to}
      GROUP BY b."orderId", b."orderNumber", b."shipDate"
      ORDER BY b."shipDate", b."orderId"
    ` as BillingInvoiceDetailRecord[];

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
    const rows = await this.sql`
      SELECT cpp."packageId", cpp.price, cpp.is_custom, p.name, p.length, p.width, p.height
      FROM client_package_prices cpp
      JOIN packages p ON p."packageId" = cpp."packageId"
      WHERE cpp."clientId" = ${clientId}
      ORDER BY p.name
    `;
    return rows as BillingPackagePriceRecord[];
  }

  async savePackagePrices(input: { clientId: number; prices: SaveBillingPackagePriceInput[] | undefined }): Promise<void> {
    const now = Date.now();
    for (const price of input.prices ?? []) {
      await this.sql`
        INSERT INTO client_package_prices ("clientId", "packageId", price, is_custom, "updatedAt")
        VALUES (${input.clientId}, ${price.packageId}, ${Number(price.price) || 0}, 1, ${now})
        ON CONFLICT("clientId", "packageId") DO UPDATE SET
          price = EXCLUDED.price,
          is_custom = 1,
          "updatedAt" = EXCLUDED."updatedAt"
      `;
    }
  }

  async setDefaultPackagePrice(packageId: number, price: number): Promise<SetDefaultBillingPackagePriceResult> {
    const clientRows = await this.sql`SELECT "clientId" FROM clients` as Array<{ clientId: number }>;
    const clientIds = clientRows
      .map((record) => record.clientId)
      .filter((cid) => !HOUSE_ACCOUNT_IDS.has(cid));

    if (clientIds.length === 0) {
      return { ok: true, updated: 0, skipped: 0 };
    }

    const now = Date.now();
    let updated = 0;
    for (const cid of clientIds) {
      // Insert or update only if is_custom = 0
      const result = await this.sql`
        INSERT INTO client_package_prices ("clientId", "packageId", price, is_custom, "updatedAt")
        VALUES (${cid}, ${packageId}, ${Number(price) || 0}, 0, ${now})
        ON CONFLICT("clientId", "packageId") DO UPDATE
          SET price = EXCLUDED.price, "updatedAt" = EXCLUDED."updatedAt"
          WHERE client_package_prices.is_custom = 0
      `;
      // Count every attempt; in practice the ON CONFLICT WHERE clause handles skipping
      updated += 1;
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

    const storeIdsJson = JSON.stringify(storeIds);
    const rows = await this.sql`
      SELECT
        s."orderId",
        s.weight_oz AS "weightOz",
        s.dims_l,
        s.dims_w,
        s.dims_h,
        SUBSTR(COALESCE((o.raw::jsonb)->'shipTo'->>'postalCode', o."shipToPostalCode"), 1, 5) AS zip5
      FROM shipments s
      JOIN orders o ON o."orderId" = s."orderId"
      LEFT JOIN order_local ol ON ol."orderId" = s."orderId"
      WHERE COALESCE(
              ((o.raw::jsonb)->'advancedOptions'->>'storeId')::int,
              ((o.raw::jsonb)->>'storeId')::int,
              o."storeId"
            )::text IN (SELECT jsonb_array_elements_text(${storeIdsJson}::jsonb))
        AND s.voided = 0
        AND s.weight_oz IS NOT NULL
        AND s.dims_l IS NOT NULL
        AND s.dims_w IS NOT NULL
        AND s.dims_h IS NOT NULL
        AND (ol.ref_usps_rate IS NULL OR ol.ref_ups_rate IS NULL)
    `;
    return rows as BillingFetchReferenceRateOrderRecord[];
  }

  async listOrdersMissingReferenceRatesForBackfill(input: BackfillBillingReferenceRatesInput): Promise<BillingBackfillReferenceRateOrderRecord[]> {
    const rows = await this.sql`
      SELECT
        o."orderId",
        o."orderNumber",
        CAST(COALESCE(o."weightValue", s.weight_oz, 1) AS INTEGER) AS "weightOz",
        SUBSTR(COALESCE(o."shipToPostalCode", (o.raw::jsonb)->'shipTo'->>'postalCode'), 1, 5) AS zip5
      FROM orders o
      JOIN shipments s ON s."orderId" = o."orderId"
      JOIN clients c ON EXISTS (
        SELECT 1 FROM jsonb_array_elements(c."storeIds"::jsonb) si
        WHERE si::text::integer = COALESCE(
          o."storeId",
          ((o.raw::jsonb)->'advancedOptions'->>'storeId')::int,
          ((o.raw::jsonb)->>'storeId')::int
        )
      )
      JOIN billing_config bc ON bc."clientId" = c."clientId"
      LEFT JOIN order_local ol ON ol."orderId" = o."orderId"
      WHERE s.voided = 0
        AND bc.billing_mode = 'reference_rate'
        AND (ol.ref_usps_rate IS NULL AND ol.ref_ups_rate IS NULL)
        AND (${input.from ?? null}::text IS NULL OR s."shipDate" >= ${input.from ?? null})
        AND (${input.to ?? null}::text IS NULL OR s."shipDate" <= ${input.to ?? null})
    `;
    return rows as BillingBackfillReferenceRateOrderRecord[];
  }

  async findCachedReferenceRateCandidates(weightOz: number, zip5: string): Promise<RateDto[] | null> {
    const pattern = `%|${weightOz}|${zip5}|%`;
    const rows = await this.sql`
      SELECT rates
      FROM rate_cache
      WHERE cache_key LIKE ${pattern}
      LIMIT 1
    `;
    const row = rows[0] as { rates: string } | undefined;
    if (!row?.rates) return null;

    try {
      return JSON.parse(row.rates) as RateDto[];
    } catch {
      return null;
    }
  }

  async saveBackfilledReferenceRates(orderId: number, refUspsRate: number | null, refUpsRate: number | null): Promise<void> {
    await this.sql`
      INSERT INTO order_local ("orderId", ref_usps_rate, ref_ups_rate, "updatedAt")
      VALUES (${orderId}, ${refUspsRate}, ${refUpsRate}, ${Date.now()})
      ON CONFLICT("orderId") DO UPDATE SET
        ref_usps_rate = CASE WHEN EXCLUDED.ref_usps_rate IS NOT NULL THEN EXCLUDED.ref_usps_rate ELSE order_local.ref_usps_rate END,
        ref_ups_rate = CASE WHEN EXCLUDED.ref_ups_rate IS NOT NULL THEN EXCLUDED.ref_ups_rate ELSE order_local.ref_ups_rate END,
        "updatedAt" = EXCLUDED."updatedAt"
    `;
  }

  // --- Private helpers ---

  private async getStoreToClientMap(): Promise<Map<number, number>> {
    const map = new Map<number, number>();
    const rows = await this.sql`
      SELECT "clientId", "storeIds"
      FROM clients
      WHERE active = 1
    ` as BillingStoreClientRecord[];
    for (const row of rows) {
      for (const storeId of this.parseJson<number[]>(row.storeIds, [])) {
        map.set(Number(storeId), row.clientId);
      }
    }
    return map;
  }

  private async listReferenceRates(from: string, to: string): Promise<BillingReferenceRateRecord[]> {
    const rows = await this.sql`
      SELECT ol."orderId", ol.ref_usps_rate, ol.ref_ups_rate, ol.rate_dims_l, ol.rate_dims_w, ol.rate_dims_h
      FROM order_local ol
      JOIN shipments s ON s."orderId" = ol."orderId"
      WHERE s.voided = 0 AND s."shipDate" >= ${from} AND s."shipDate" <= ${to}
    `;
    return rows as BillingReferenceRateRecord[];
  }

  private async getDimsToPackageIdMap(): Promise<Map<string, number>> {
    const rows = await this.sql`
      SELECT "packageId", length, width, height
      FROM packages
      WHERE source = 'custom'
    ` as BillingPackageDimensionRecord[];
    return new Map(rows.map((row) => [this.makeDimsKey(row.length, row.width, row.height), row.packageId]));
  }

  private async getSkuPackageMap(): Promise<Map<string, number>> {
    const rows = await this.sql`
      SELECT sku, "packageId"
      FROM inventory_skus
      WHERE "packageId" IS NOT NULL AND sku IS NOT NULL
    ` as BillingSkuPackageRecord[];
    return new Map(rows.filter((row) => row.sku && row.packageId != null).map((row) => [row.sku as string, row.packageId as number]));
  }

  private async getClientPackagePriceMap(): Promise<Map<number, Map<number, number>>> {
    const result = new Map<number, Map<number, number>>();
    const rows = await this.sql`
      SELECT "clientId", "packageId", price
      FROM client_package_prices
    ` as BillingClientPackagePriceRecord[];
    for (const row of rows) {
      if (!result.has(row.clientId)) result.set(row.clientId, new Map());
      result.get(row.clientId)?.set(row.packageId, row.price);
    }
    return result;
  }

  private async getPackageNameMap(): Promise<Map<number, string>> {
    const rows = await this.sql`
      SELECT "packageId", name
      FROM packages
    ` as BillingPackageNameRecord[];
    return new Map(rows.map((row) => [row.packageId, row.name]));
  }

  private async listBillingShipments(from: string, to: string): Promise<BillingShipmentRecord[]> {
    const rows = await this.sql`
      WITH ship AS (
        SELECT "orderId", "shipDate", "shipmentCost", "otherCost", "carrierCode", dims_l, dims_w, dims_h
        FROM shipments
        WHERE voided = 0
      )
      SELECT
        o."orderId", o."orderNumber", o.items, o.raw,
        ship."shipDate",
        COALESCE(ship."shipDate", o."orderDate") AS "billingDate",
        COALESCE(ship."shipmentCost", 0) AS "shipmentCost",
        COALESCE(ship."otherCost", 0) AS "otherCost",
        ship."carrierCode",
        ship.dims_l, ship.dims_w, ship.dims_h,
        COALESCE(ol.external_shipped, 0) AS external_shipped
      FROM orders o
      LEFT JOIN ship ON ship."orderId" = o."orderId"
      LEFT JOIN order_local ol ON ol."orderId" = o."orderId"
      WHERE o."orderStatus" = 'shipped'
        AND COALESCE(ol.external_shipped, 0) = 0
        AND COALESCE(ship."shipDate", o."orderDate") >= ${from}
        AND COALESCE(ship."shipDate", o."orderDate") <= ${to}
      ORDER BY COALESCE(ship."shipDate", o."orderDate")
    `;
    return rows as BillingShipmentRecord[];
  }

  private async listStorageSkus(clientId: number): Promise<BillingStorageSkuRecord[]> {
    const rows = await this.sql`
      SELECT id, "productLength", "productWidth", "productHeight", "cuFtOverride"
      FROM inventory_skus
      WHERE "clientId" = ${clientId} AND active = 1
    `;
    return rows as BillingStorageSkuRecord[];
  }

  private async getStockBefore(inventorySkuId: number, beforeMs: number): Promise<BillingLedgerStockTotalRecord> {
    const rows = await this.sql`
      SELECT COALESCE(SUM(qty), 0) AS total
      FROM inventory_ledger
      WHERE "invSkuId" = ${inventorySkuId} AND "createdAt" < ${beforeMs}
    `;
    return (rows[0] as BillingLedgerStockTotalRecord) ?? { total: 0 };
  }

  private async listLedgerEvents(inventorySkuId: number, fromMs: number, toMs: number): Promise<BillingLedgerEventRecord[]> {
    const rows = await this.sql`
      SELECT "createdAt", qty
      FROM inventory_ledger
      WHERE "invSkuId" = ${inventorySkuId} AND "createdAt" >= ${fromMs} AND "createdAt" <= ${toMs}
      ORDER BY "createdAt" ASC
    `;
    return rows as BillingLedgerEventRecord[];
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
