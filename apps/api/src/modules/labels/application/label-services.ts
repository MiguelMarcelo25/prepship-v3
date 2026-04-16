import { resolveCarrierNickname } from "../../orders/application/carrier-resolver.js";
import type {
  BatchLabelResultItem,
  CreateBatchLabelRequestDto,
  CreateBatchLabelResponseDto,
  CreateLabelRequestDto,
  CreateLabelResponseDto,
  RetrieveLabelResponseDto,
  ReturnLabelRequestDto,
  ReturnLabelResponseDto,
  VoidLabelResponseDto,
} from "../../../../../../../packages/contracts/src/labels/contracts.js";
import type { OrderSelectedRateDto } from "../../../../../../../packages/contracts/src/orders/contracts.js";
import type { TransitionalSecrets } from "../../../../../../../packages/shared/src/config/secrets-adapter.js";
import type { LabelRepository } from "./label-repository.js";
import type {
  CreatedExternalLabel,
  ExternalOrderShipmentRecord,
  ShipstationV1Credentials,
  ShippingGateway,
} from "./shipping-gateway.js";
import { CARRIER_ACCOUNTS_V2 } from "../../../common/prepship-config.js";
import type { AddressRecord, LabelOrderRecord, LabelShipmentRecord } from "../domain/label.js";
import {
  generateFakeShipmentId,
  generateFakeTrackingNumber,
  generateMockLabelPdf,
  serviceCodeToLabel,
} from "./mock-label-generator.js";

// Rate limiting configuration
const LABEL_RATE_LIMIT = 10; // max 10 labels per minute per client
const LABEL_RATE_WINDOW_MS = 60_000; // 1 minute window

// Per-client rate limiter: Map<clientId, {count, windowStart}>
const labelRateLimitMap = new Map<number, { count: number; windowStart: number }>();

/**
 * Check and enforce per-client label rate limit.
 * Throws error with rateLimited flag if limit exceeded.
 */
function checkLabelRateLimit(clientId: number): void {
  const now = Date.now();
  const bucket = labelRateLimitMap.get(clientId);

  if (!bucket) {
    // First request in window
    labelRateLimitMap.set(clientId, { count: 1, windowStart: now });
    return;
  }

  const elapsed = now - bucket.windowStart;
  if (elapsed >= LABEL_RATE_WINDOW_MS) {
    // Window expired, reset
    labelRateLimitMap.set(clientId, { count: 1, windowStart: now });
    return;
  }

  // Still in window, check limit
  if (bucket.count >= LABEL_RATE_LIMIT) {
    const retryAfterMs = LABEL_RATE_WINDOW_MS - elapsed;
    const error = new Error(
      `Label rate limit exceeded (${LABEL_RATE_LIMIT} labels per minute per client). Retry after ${Math.ceil(retryAfterMs / 1000)}s`
    ) as Error & { rateLimited?: boolean; retryAfterMs?: number };
    error.rateLimited = true;
    error.retryAfterMs = retryAfterMs;
    throw error;
  }

  // Increment count within current window
  bucket.count += 1;
}

/**
 * Helper to run async tasks with concurrency limit.
 * Runs at most `maxConcurrent` tasks in parallel.
 */
async function withConcurrency<T>(
  items: T[],
  fn: (item: T) => Promise<void>,
  maxConcurrent: number = 5,
): Promise<void> {
  const queue = [...items];
  const running = new Set<Promise<void>>();

  while (queue.length > 0 || running.size > 0) {
    // Fill up to maxConcurrent
    while (running.size < maxConcurrent && queue.length > 0) {
      const item = queue.shift();
      if (item !== undefined) {
        const task = fn(item).finally(() => running.delete(task));
        running.add(task);
      }
    }

    // Wait for at least one to complete if we're at capacity or have pending items
    if (running.size > 0) {
      await Promise.race(running);
    }
  }
}

function parseOrderShipTo(raw: string, fallbackName: string | null): AddressRecord {
  try {
    const parsed = JSON.parse(raw) as { shipTo?: Record<string, unknown> };
    const shipTo = parsed.shipTo ?? {};
    return {
      name: String(shipTo.name ?? fallbackName ?? "Customer"),
      company: shipTo.company ? String(shipTo.company) : undefined,
      street1: String(shipTo.street1 ?? ""),
      street2: shipTo.street2 ? String(shipTo.street2) : undefined,
      city: String(shipTo.city ?? ""),
      state: String(shipTo.state ?? ""),
      postalCode: String(shipTo.postalCode ?? ""),
      country: String(shipTo.country ?? "US"),
      phone: shipTo.phone ? String(shipTo.phone) : undefined,
    };
  } catch {
    return {
      name: fallbackName ?? "Customer",
      street1: "",
      city: "",
      state: "",
      postalCode: "",
      country: "US",
    };
  }
}

function normalizeAddress(input: CreateLabelRequestDto["shipTo"] | CreateLabelRequestDto["shipFrom"] | undefined, fallback: AddressRecord): AddressRecord {
  if (!input?.street1) return fallback;
  return {
    name: input.name || fallback.name,
    company: input.company || undefined,
    street1: input.street1 || "",
    street2: input.street2 || undefined,
    city: input.city || "",
    state: input.state || "",
    postalCode: input.postalCode || "",
    country: input.country || "US",
    phone: input.phone || undefined,
  };
}

function defaultShipFrom(): AddressRecord {
  return {
    name: "DR Prepper Fulfillment",
    street1: "14924 S Figueroa St",
    city: "Gardena",
    state: "CA",
    postalCode: "90248",
    country: "US",
    phone: "3103295555",
  };
}

function toV1Credentials(contextApiKey: string | null, contextApiSecret: string | null, secrets: TransitionalSecrets): ShipstationV1Credentials {
  const apiKey = contextApiKey ?? secrets.shipstation?.api_key;
  const apiSecret = contextApiSecret ?? secrets.shipstation?.api_secret;
  if (!apiKey || !apiSecret) {
    throw new Error("No v1 ShipStation credentials configured for this account");
  }
  return { apiKey, apiSecret };
}

function getRefundEstimate(carrierCode: string | null): string {
  if (carrierCode === "stamps_com" || carrierCode === "usps") return "2-5 days (USPS)";
  if (carrierCode === "fedex") return "3-7 days (FedEx)";
  if (carrierCode === "ups") return "3-7 days (UPS)";
  return "2-7 days";
}

function normalizeSyncedShipment(shipment: ExternalOrderShipmentRecord, clientId: number): {
  shipmentId: number;
  orderId: number;
  orderNumber: string | null;
  carrierCode: string | null;
  serviceCode: string | null;
  trackingNumber: string | null;
  shipDate: string | null;
  labelUrl: string | null;
  shipmentCost: number;
  otherCost: number;
  voided: boolean;
  updatedAt: number;
  weightOz: number | null;
  dimsLength: number | null;
  dimsWidth: number | null;
  dimsHeight: number | null;
  createDate: string | null;
  clientId: number;
  providerAccountId: number | null;
  source: string;
  labelCreatedAt: number | null;
  labelFormat: string | null;
  selectedRateJson: string | null;
} {
  return {
    shipmentId: shipment.shipmentId,
    orderId: shipment.orderId,
    orderNumber: shipment.orderNumber,
    carrierCode: shipment.carrierCode,
    serviceCode: shipment.serviceCode,
    trackingNumber: shipment.trackingNumber,
    shipDate: shipment.shipDate,
    labelUrl: null,
    shipmentCost: shipment.shipmentCost,
    otherCost: shipment.otherCost,
    voided: shipment.voided,
    updatedAt: Date.now(),
    weightOz: shipment.weightOz,
    dimsLength: shipment.dimsLength,
    dimsWidth: shipment.dimsWidth,
    dimsHeight: shipment.dimsHeight,
    createDate: shipment.createDate,
    clientId,
    providerAccountId: null,
    providerAccountNickname: resolveCarrierNickname(null, shipment.carrierCode, shipment.trackingNumber, clientId),
    source: "shipstation",
    labelCreatedAt: shipment.createDate ? Date.parse(shipment.createDate) : null,
    labelFormat: null,
    selectedRateJson: null,
  };
}

export class LabelServices {
  private readonly repository: LabelRepository;
  private readonly gateway: ShippingGateway;
  private readonly secrets: TransitionalSecrets;

  constructor(repository: LabelRepository, gateway: ShippingGateway, secrets: TransitionalSecrets) {
    this.repository = repository;
    this.gateway = gateway;
    this.secrets = secrets;
  }

  async create(body: CreateLabelRequestDto): Promise<CreateLabelResponseDto> {
    if (!body.orderId || !body.serviceCode) throw new Error("orderId and serviceCode required");
    if (!body.shippingProviderId) throw new Error("shippingProviderId required for v2 label creation");

    const order = await this.repository.getOrder(body.orderId);
    if (!order) throw new Error("Order not found");
    if (order.orderStatus === "shipped" || order.orderStatus === "cancelled") {
      throw new Error(`Cannot create label for ${order.orderStatus} order`);
    }

    // Resolve shipping account context for this order's store
    const context = await this.repository.getShippingAccountContext(order.storeId);

    // Resolve client and check rate limit before continuing
    const clientId = context.clientId ?? order.clientId;
    if (!clientId) throw new Error(`Cannot resolve clientId for storeId ${order.storeId}`);
    checkLabelRateLimit(clientId);

    const existing = await this.repository.findActiveLabelForOrder(order.orderId);
    if (existing) {
      const error = new Error("Label already exists for this order") as Error & { details?: Record<string, unknown> };
      error.details = {
        shipmentId: existing.shipmentId,
        trackingNumber: existing.trackingNumber,
        labelUrl: existing.labelUrl,
      };
      throw error;
    }

    const effectiveWeightOz = Number(body.weightOz ?? order.weightValue ?? 0);
    if (!effectiveWeightOz) throw new Error("Order weight required to create label");

    const dims = await this.repository.resolvePackageDimensions(order.orderId);
    const length = Number(body.length ?? dims?.length ?? 0) || null;
    const width = Number(body.width ?? dims?.width ?? 0) || null;
    const height = Number(body.height ?? dims?.height ?? 0) || null;

    const fallbackShipTo = parseOrderShipTo(order.raw, order.shipToName);
    const shipTo = normalizeAddress(body.shipTo, fallbackShipTo);
    const shipFrom = normalizeAddress(body.shipFrom, defaultShipFrom());

    // ── OFFLINE TEST MODE ────────────────────────────────────────────────────
    // When testLabel=true, skip ShipStation entirely. Generate a fake shipment
    // with a local mock label URL. Zero postage cost, zero SS interaction.
    if (body.testLabel === true) {
      const fakeShipmentId = generateFakeShipmentId();
      const fakeTracking = generateFakeTrackingNumber();
      const shipDate = new Date().toISOString().slice(0, 10);
      const mockLabelUrl = `/api/labels/mock/${fakeShipmentId}`;

      await this.repository.saveShipment({
        shipmentId: fakeShipmentId,
        orderId: order.orderId,
        orderNumber: order.orderNumber,
        carrierCode: body.carrierCode ?? "stamps_com",
        serviceCode: body.serviceCode,
        trackingNumber: fakeTracking,
        shipDate,
        labelUrl: mockLabelUrl,
        shipmentCost: 0,
        otherCost: 0,
        voided: false,
        updatedAt: Date.now(),
        weightOz: effectiveWeightOz,
        dimsLength: length,
        dimsWidth: width,
        dimsHeight: height,
        createDate: new Date().toISOString(),
        clientId,
        providerAccountId: null,
        providerAccountNickname: resolveCarrierNickname(null, body.carrierCode ?? "stamps_com", null, clientId),
        source: "test_offline",
        labelCreatedAt: Date.now(),
        labelFormat: "html",
        selectedRateJson: null,
      });

      await this.repository.backfillOrderLocalTracking(order.orderId, fakeTracking, null, Math.floor(Date.now() / 1000));
      await this.repository.markOrderShipped(order.orderId, Date.now());

      // Generate mock label as real PDF (await so it's ready before response)
      const mockData = {
        shipmentId: fakeShipmentId,
        orderNumber: order.orderNumber,
        trackingNumber: fakeTracking,
        serviceLabel: serviceCodeToLabel(body.serviceCode),
        weightOz: effectiveWeightOz,
        shipFrom,
        shipTo,
        shipDate,
      };
      let pdfBase64: string | undefined;
      try {
        pdfBase64 = await generateMockLabelPdf(mockData);
      } catch (pdfErr) {
        console.error("[mock-label] PDF generation failed:", pdfErr instanceof Error ? pdfErr.message : pdfErr);
      }
      await this.repository.saveMockLabelData(fakeShipmentId, { ...mockData, pdfBase64 });

      return {
        shipmentId: fakeShipmentId,
        trackingNumber: fakeTracking,
        labelUrl: mockLabelUrl,
        cost: 0,
        voided: false,
        orderStatus: "shipped",
        apiVersion: "v2",
      };
    }
    // ── END OFFLINE TEST MODE ────────────────────────────────────────────────

    const apiKeyV2 = context.v2ApiKey ?? this.secrets.shipstation?.api_key_v2;
    if (!apiKeyV2) throw new Error("No v2 API key configured for this account");
    const credentials = toV1Credentials(context.v1ApiKey, context.v1ApiSecret, this.secrets);

    const created = await this.gateway.createLabel({
      apiKeyV2,
      carrierId: `se-${body.shippingProviderId}`,
      serviceCode: body.serviceCode,
      packageCode: body.packageCode || "package",
      weightOz: effectiveWeightOz,
      length,
      width,
      height,
      shipTo,
      shipFrom,
      confirmation: body.confirmation ?? null,
      ssOrderId: order.orderId,
      orderNumber: order.orderNumber ?? null,
      testLabel: body.testLabel === true,
    });

    // V2 provides tracking, labelUrl, cost, shipDate immediately — no V1 wait needed.
    const finalTracking = created.trackingNumber;
    const finalLabelUrl = created.labelUrl ?? null;
    const finalShipDate = created.shipDate ?? new Date().toISOString().slice(0, 10);
    const providerNickname = CARRIER_ACCOUNTS_V2.find((carrier) => carrier.shippingProviderId === created.providerAccountId)?.nickname ?? null;
    const selectedRate: OrderSelectedRateDto = created.selectedRate ?? {
      providerAccountId: created.providerAccountId,
      providerAccountNickname: providerNickname,
      shippingProviderId: created.providerAccountId,
      carrierCode: created.carrierCode,
      serviceName: created.serviceCode,
      serviceCode: created.serviceCode,
      cost: created.cost,
      shipmentCost: created.cost,
      otherCost: 0,
    };

    if (!body.testLabel) {
      // Persist V2 data immediately — otherCost/createDate will be enriched in the background.
      await this.repository.saveShipment({
        shipmentId: created.shipmentId,
        orderId: order.orderId,
        orderNumber: order.orderNumber,
        carrierCode: created.carrierCode,
        serviceCode: created.serviceCode,
        trackingNumber: finalTracking,
        shipDate: finalShipDate,
        labelUrl: finalLabelUrl,
        shipmentCost: created.cost,
        otherCost: 0,
        voided: created.voided,
        updatedAt: Date.now(),
        weightOz: effectiveWeightOz,
        dimsLength: length,
        dimsWidth: width,
        dimsHeight: height,
        createDate: new Date().toISOString(),
        clientId,
        providerAccountId: created.providerAccountId,
        providerAccountNickname: resolveCarrierNickname(created.providerAccountId, created.carrierCode, finalTracking, clientId),
        source: "prepship_v2",
        labelCreatedAt: Date.now(),
        labelFormat: "pdf",
        selectedRateJson: JSON.stringify(selectedRate),
      });

      if (finalTracking) {
        await this.repository.backfillOrderLocalTracking(order.orderId, finalTracking, created.providerAccountId, Math.floor(Date.now() / 1000));
      }
      await this.repository.markOrderShipped(order.orderId, Date.now());

      // Kick off V1 enrichment in the background — user is NOT blocked by this.
      void this.runV1EnrichmentBackground(credentials, created, order, effectiveWeightOz, clientId);
    }

    return {
      shipmentId: created.shipmentId,
      trackingNumber: finalTracking,
      labelUrl: finalLabelUrl,   // always return URL — test labels are watermarked "VOID - DO NOT SHIP"
      cost: created.cost,
      voided: created.voided,
      orderStatus: body.testLabel ? order.orderStatus : "shipped",
      apiVersion: "v2",
    };
  }

  /**
   * Background task: notify V1 that the order shipped, then fetch V1 enrichment data
   * (otherCost, createDate, weightOz, dimensions) and sync all shipments for the order.
   * Failures here are logged but never surface to the user.
   */
  private async runV1EnrichmentBackground(
    credentials: ShipstationV1Credentials,
    created: CreatedExternalLabel,
    order: LabelOrderRecord,
    effectiveWeightOz: number,
    clientId: number,
  ): Promise<void> {
    const tag = `[V1 enrichment] shipmentId=${created.shipmentId} orderId=${order.orderId}`;
    try {
      const finalShipDate = created.shipDate ?? new Date().toISOString().slice(0, 10);

      // 1. Mark order shipped in ShipStation V1 (best-effort — keeps SS in sync).
      if (created.trackingNumber) {
        try {
          await this.gateway.markOrderShipped(credentials, {
            orderId: order.orderId,
            carrierCode: created.carrierCode,
            shipDate: finalShipDate,
            trackingNumber: created.trackingNumber,
          });
        } catch (err) {
          console.error(`${tag} markOrderShipped failed (non-fatal):`, err);
        }
      }

      // 2. Fetch V1 shipment details for enrichment fields.
      const enriched = await this.gateway.getShipment(credentials, created.shipmentId);
      if (enriched) {
        await this.repository.enrichShipment({
          shipmentId: created.shipmentId,
          otherCost: enriched.otherCost ?? 0,
          createDate: enriched.createDate ?? null,
          weightOz: enriched.weightOz ?? effectiveWeightOz,
          dimsLength: enriched.dimsLength ?? null,
          dimsWidth: enriched.dimsWidth ?? null,
          dimsHeight: enriched.dimsHeight ?? null,
          updatedAt: Date.now(),
        });
        console.log(`${tag} enriched: otherCost=${enriched.otherCost} createDate=${enriched.createDate}`);
      } else {
        console.warn(`${tag} getShipment returned null — enrichment skipped`);
      }

      // 3. Sync all V1 shipments for this order.
      const syncedShipments = await this.gateway.listOrderShipments(credentials, order.orderId);
      for (const shipment of syncedShipments) {
        await this.repository.saveShipment(normalizeSyncedShipment(shipment, clientId));
      }
      console.log(`${tag} synced ${syncedShipments.length} V1 shipment(s)`);
    } catch (err) {
      console.error(`${tag} background enrichment error (non-fatal):`, err);
    }
  }

  async createBatch(body: CreateBatchLabelRequestDto): Promise<CreateBatchLabelResponseDto> {
    const created: BatchLabelResultItem[] = [];
    const failed: BatchLabelResultItem[] = [];
    const lock = { created, failed }; // Shared reference for thread-safe mutations

    // Use concurrency control (max 5 parallel) instead of sequential for...of loop
    await withConcurrency(
      body.orderIds,
      async (orderId) => {
        try {
          const result = await this.create({
            orderId,
            serviceCode: body.serviceCode,
            carrierCode: body.carrierCode,
            packageCode: body.packageCode,
            confirmation: body.confirmation,
            testLabel: body.testLabel,
            shippingProviderId: body.shippingProviderId,
          });
          lock.created.push({
            orderId,
            success: true,
            shipmentId: result.shipmentId,
            trackingNumber: result.trackingNumber,
            cost: result.cost,
          });
        } catch (error) {
          const message = error instanceof Error ? error.message : "Unknown error";
          lock.failed.push({ orderId, success: false, error: message });
        }
      },
      5, // max 5 parallel
    );

    return {
      created: lock.created,
      failed: lock.failed,
      summary: {
        total: body.orderIds.length,
        created: lock.created.length,
        failed: lock.failed.length,
      },
    };
  }

  async void(shipmentId: number): Promise<VoidLabelResponseDto> {
    const shipment = await this.repository.getShipmentForVoidOrReturn(shipmentId);
    if (!shipment) throw new Error("Shipment not found");
    if (shipment.voided) throw new Error("Label already voided");

    const context = await this.repository.getShippingAccountContext(shipment.storeId);
    const apiKeyV2 = context.v2ApiKey ?? this.secrets.shipstation?.api_key_v2;
    if (!apiKeyV2) throw new Error("No v2 API key configured for this account");

    await this.gateway.voidShipment(apiKeyV2, shipmentId);
    const now = Date.now();
    await this.repository.markShipmentVoided(shipmentId, shipment.orderId, now);

    return {
      success: true,
      shipmentId,
      orderNumber: shipment.orderNumber,
      voided: true,
      voidedAt: new Date(now).toISOString(),
      trackingNumber: shipment.trackingNumber,
      refundAmount: shipment.shipmentCost ?? null,
      refundInitiated: true,
      refundEstimate: getRefundEstimate(shipment.carrierCode),
      note: 'Order status reset to "Awaiting Shipment"; you can create a new label.',
    };
  }

  async createReturn(shipmentId: number, body: ReturnLabelRequestDto): Promise<ReturnLabelResponseDto> {
    const shipment = await this.repository.getShipmentForVoidOrReturn(shipmentId);
    if (!shipment) throw new Error("Shipment not found");

    const context = await this.repository.getShippingAccountContext(shipment.storeId);
    const apiKeyV2 = context.v2ApiKey ?? this.secrets.shipstation?.api_key_v2;
    if (!apiKeyV2) throw new Error("No v2 API key configured for this account");

    const reason = body.reason || "Customer Return";
    const result = await this.gateway.createReturnLabel(apiKeyV2, shipmentId, reason);
    const createdAt = Date.now();
    await this.repository.saveReturnLabel({
      shipmentId,
      returnShipmentId: result.returnShipmentId,
      returnTrackingNumber: result.returnTrackingNumber,
      reason,
      createdAt,
    });

    return {
      success: true,
      shipmentId,
      orderNumber: shipment.orderNumber,
      returnTrackingNumber: result.returnTrackingNumber,
      returnShipmentId: result.returnShipmentId,
      cost: result.cost,
      reason,
      createdAt: new Date(createdAt).toISOString(),
    };
  }

  async getMockLabelData(shipmentId: number) {
    return await this.repository.getMockLabelData(shipmentId);
  }

  async retrieve(orderLookup: number | string, fresh: boolean): Promise<RetrieveLabelResponseDto> {
    const shipment = await this.repository.getLatestShipmentForOrderLookup(orderLookup);
    if (!shipment) throw new Error("No active label found for this order");

    let labelUrl = shipment.labelUrl;
    if (fresh || !labelUrl) {
      labelUrl = await this.findFreshLabelUrl(shipment);
      if (labelUrl && labelUrl !== shipment.labelUrl) {
        await this.repository.updateShipmentLabelUrl(shipment.shipmentId, labelUrl);
      }
    }

    if (!labelUrl) {
      if (shipment.source === "shipstation") {
        throw new Error(`Label was created in ShipStation before label tracking was enabled. Access it directly in ShipStation or use tracking number ${shipment.trackingNumber || "N/A"}`);
      }
      throw new Error("Label URL not available. The label may have been voided or deleted.");
    }

    return {
      orderId: shipment.orderId,
      orderNumber: shipment.orderNumber,
      shipmentId: shipment.shipmentId,
      trackingNumber: shipment.trackingNumber,
      labelUrl,
      createdAt: shipment.labelCreatedAt ? new Date(shipment.labelCreatedAt).toISOString() : null,
      carrier: shipment.carrierCode || "unknown",
      service: shipment.serviceCode || "unknown",
      cost: shipment.shipmentCost ?? 0,
    };
  }

  private async findFreshLabelUrl(shipment: LabelShipmentRecord): Promise<string | null> {
    const context = await this.repository.getShippingAccountContext(shipment.storeId);
    const apiKeyV2 = context.v2ApiKey ?? this.secrets.shipstation?.api_key_v2;
    if (apiKeyV2) {
      const labels = await this.gateway.listRecentLabels(apiKeyV2);
      if (shipment.source === "prepship_v2") {
        const labelId = `se-${shipment.shipmentId}`;
        const match = labels.find((entry) => entry.labelId === labelId);
        if (match?.labelUrl) return match.labelUrl;
      }
      if (shipment.trackingNumber) {
        const match = labels.find((entry) => entry.trackingNumber === shipment.trackingNumber);
        if (match?.labelUrl) return match.labelUrl;
      }
    }

    const credentials = toV1Credentials(context.v1ApiKey, context.v1ApiSecret, this.secrets);
    const details = await this.gateway.getShipment(credentials, shipment.shipmentId);
    return details?.labelUrl ?? null;
  }
}
