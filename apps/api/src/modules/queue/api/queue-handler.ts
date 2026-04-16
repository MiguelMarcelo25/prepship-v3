import type { QueueServices } from "../application/queue-services.js";
import { InputValidationError } from "../../../../../../packages/contracts/src/common/input-validation.js";

export class QueueHttpHandler {
  private readonly services: QueueServices;

  constructor(services: QueueServices) {
    this.services = services;
  }

  async handleGet(url: URL) {
    const clientIdRaw = url.searchParams.get('client_id');
    if (!clientIdRaw) throw new InputValidationError("client_id is required");
    const includePrinted = url.searchParams.get('include_printed') === '1' || url.searchParams.get('include_printed') === 'true';
    return await this.services.getQueueForClient(Number(clientIdRaw), includePrinted);
  }

  async handleAdd(body: unknown) {
    return await this.services.addToQueue(body);
  }

  async handleRemove(entryId: string, body: unknown) {
    const raw = body as Record<string, unknown>;
    if (!raw.client_id) throw new InputValidationError("client_id is required");
    return await this.services.removeFromQueue(entryId, Number(raw.client_id));
  }

  async handleClear(body: unknown) {
    const raw = body as Record<string, unknown>;
    if (!raw.client_id) throw new InputValidationError("client_id is required");
    return await this.services.clearQueue(Number(raw.client_id));
  }

  async handleStartPrint(body: unknown) {
    return await this.services.startPrintJob(body);
  }

  handleJobStatus(jobId: string) {
    const job = this.services.getMergeJobStatus(jobId);
    if (!job) return null;

    // Return job status without the full PDF bytes (those go in /download)
    return {
      ok: true,
      job_id: job.jobId,
      status: job.status,
      progress: job.progress,
      total: job.total,
      current: job.current,
      message: job.message,
      file_name: job.fileName ?? null,
      error: job.errorMessage ?? null,
    };
  }

  handleJobDownload(jobId: string): { base64: string; fileName: string } | null {
    const job = this.services.getMergeJobStatus(jobId);
    if (!job || job.status !== 'done' || !job.mergedPdfBase64 || !job.fileName) return null;
    return { base64: job.mergedPdfBase64, fileName: job.fileName };
  }
}
