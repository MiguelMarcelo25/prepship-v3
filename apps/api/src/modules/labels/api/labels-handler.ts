import type {
  CreateBatchLabelRequestDto,
  CreateLabelRequestDto,
  ReturnLabelRequestDto,
} from "../../../../../../../packages/contracts/src/labels/contracts.js";
import { InputValidationError } from "../../../../../../packages/contracts/src/common/input-validation.js";
import type { LabelServices } from "../application/label-services.js";
import { generateMockLabelHtml } from "../application/mock-label-generator.js";

export class LabelsHttpHandler {
  private readonly services: LabelServices;

  constructor(services: LabelServices) {
    this.services = services;
  }

  async handleCreate(body: CreateLabelRequestDto) {
    return await this.services.create(body);
  }

  async handleCreateBatch(body: unknown) {
    const raw = body as Record<string, unknown>;
    if (!Array.isArray(raw.orderIds) || raw.orderIds.length === 0) {
      throw new InputValidationError("orderIds must be a non-empty array");
    }
    if (!raw.serviceCode || typeof raw.serviceCode !== "string") {
      throw new InputValidationError("serviceCode is required");
    }
    if (!raw.shippingProviderId || !Number.isFinite(Number(raw.shippingProviderId))) {
      throw new InputValidationError("shippingProviderId is required");
    }
    const dto: CreateBatchLabelRequestDto = {
      orderIds: raw.orderIds.map((id: unknown) => Number(id)),
      serviceCode: raw.serviceCode,
      carrierCode: typeof raw.carrierCode === "string" ? raw.carrierCode : undefined,
      packageCode: typeof raw.packageCode === "string" ? raw.packageCode : undefined,
      confirmation: typeof raw.confirmation === "string" ? raw.confirmation : undefined,
      testLabel: raw.testLabel === true || raw.testLabel === 1,
      shippingProviderId: Number(raw.shippingProviderId),
    };
    return await this.services.createBatch(dto);
  }

  async handleVoid(shipmentId: number) {
    return await this.services.void(shipmentId);
  }

  async handleReturn(shipmentId: number, body: ReturnLabelRequestDto) {
    return await this.services.createReturn(shipmentId, body);
  }

  async handleRetrieve(orderLookup: number | string, fresh: boolean) {
    return await this.services.retrieve(orderLookup, fresh);
  }

  async handleMockLabel(shipmentId: number): Promise<Response> {
    const data = await this.services.getMockLabelData(shipmentId);
    if (!data) {
      return new Response("Mock label not found (server may have restarted)", {
        status: 404,
        headers: { "content-type": "text/plain" },
      });
    }
    // Serve as PDF if available (generated at label creation time)
    if (data.pdfBase64) {
      const pdfBytes = Buffer.from(data.pdfBase64, "base64");
      return new Response(pdfBytes, {
        status: 200,
        headers: {
          "content-type": "application/pdf",
          "content-disposition": `inline; filename="mock-label-${shipmentId}.pdf"`,
          "content-length": String(pdfBytes.byteLength),
        },
      });
    }
    // Fallback to HTML if PDF not yet generated
    const html = generateMockLabelHtml(data);
    return new Response(html, {
      status: 200,
      headers: { "content-type": "text/html; charset=utf-8" },
    });
  }
}
