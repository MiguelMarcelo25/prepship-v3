export type LabelOperationLogAction = 'label_create' | 'print_queue';
export type LabelOperationLogStatus = 'success' | 'error' | 'skipped';

export type LabelOperationLogEntry = {
  id: string;
  observedAt: string;
  action: LabelOperationLogAction;
  status: LabelOperationLogStatus;
  orderId: number | null;
  orderNumber: string | number | null;
  cause: string;
  timingMs: number | null;
  trackingNumber?: string | null;
  queueEntryId?: string | null;
  jobId?: string | null;
  source?: string | null;
};

export const MAX_LABEL_OPERATION_LOGS = 150;

const labelOperationLogs: LabelOperationLogEntry[] = [];
let sequence = 0;

function cleanText(value: unknown): string | null {
  if (typeof value !== 'string' && typeof value !== 'number') return null;
  const text = String(value).trim();
  return text || null;
}

function cleanNumber(value: unknown): number | null {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

export function recordLabelOperationLog(input: {
  action: LabelOperationLogAction;
  status: LabelOperationLogStatus;
  orderId?: unknown;
  orderNumber?: unknown;
  cause?: unknown;
  timingMs?: unknown;
  trackingNumber?: unknown;
  queueEntryId?: unknown;
  jobId?: unknown;
  source?: unknown;
}): LabelOperationLogEntry {
  const observedAt = new Date().toISOString();
  const entry: LabelOperationLogEntry = {
    id: `${Date.now().toString(36)}-${(sequence++).toString(36)}`,
    observedAt,
    action: input.action,
    status: input.status,
    orderId: cleanNumber(input.orderId),
    orderNumber: cleanText(input.orderNumber),
    cause: cleanText(input.cause) ?? (input.status === 'success' ? 'Completed' : 'No cause reported'),
    timingMs: cleanNumber(input.timingMs),
    trackingNumber: cleanText(input.trackingNumber),
    queueEntryId: cleanText(input.queueEntryId),
    jobId: cleanText(input.jobId),
    source: cleanText(input.source),
  };

  labelOperationLogs.unshift(entry);
  if (labelOperationLogs.length > MAX_LABEL_OPERATION_LOGS) {
    labelOperationLogs.splice(MAX_LABEL_OPERATION_LOGS);
  }
  return entry;
}

export function getLabelOperationLogSnapshot(): LabelOperationLogEntry[] {
  return labelOperationLogs.map((entry) => ({ ...entry }));
}

export function deleteLabelOperationLog(id: unknown): boolean {
  const entryId = cleanText(id);
  if (!entryId) return false;
  const index = labelOperationLogs.findIndex((entry) => entry.id === entryId);
  if (index < 0) return false;
  labelOperationLogs.splice(index, 1);
  return true;
}

export function clearLabelOperationLogs(): number {
  const removed = labelOperationLogs.length;
  labelOperationLogs.splice(0, labelOperationLogs.length);
  return removed;
}
