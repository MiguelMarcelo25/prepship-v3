import {
  getShipStationV2LabelTracking,
  listShipStationV2Labels,
} from '../../connectors/carrier/shipstation.js';

type LabelStatus = 'completed' | 'voided';

export type ShipStationAuditSourceInput = {
  apiKeyV2?: string;
  start: string;
  end: string;
  maxPages?: number;
};

type ShipStationLabelPage = {
  labels?: Array<Record<string, unknown>>;
  total?: number;
  page?: number;
  pages?: number;
};

export async function listShipStationAuditLabels(
  input: ShipStationAuditSourceInput,
): Promise<Array<Record<string, unknown>>> {
  const labels: Array<Record<string, unknown>> = [];
  const maxPages = Math.max(1, input.maxPages ?? 100);

  for (const status of ['completed', 'voided'] as const satisfies readonly LabelStatus[]) {
    for (let page = 1; page <= maxPages; page += 1) {
      const query = new URLSearchParams();
      query.set('label_status', status);
      query.set('created_at_start', input.start);
      query.set('created_at_end', input.end);
      query.set('page_size', '500');
      query.set('page', String(page));
      query.set('sort_dir', 'desc');
      query.set('sort_by', 'created_at');
      const response = await listShipStationV2Labels<ShipStationLabelPage>(query, {
        apiKeyV2: input.apiKeyV2,
        dedupeKey: `ps-406:labels:${status}:${input.start}:${input.end}:${page}`,
      });
      labels.push(...(response.labels ?? []));
      const totalPages = Math.max(1, Number(response.pages ?? 1));
      if (!(response.labels?.length) || page >= totalPages) break;
    }
  }

  return labels;
}

export async function getShipStationAuditTracking(
  labelId: string,
  apiKeyV2?: string,
): Promise<Record<string, unknown> | null> {
  return getShipStationV2LabelTracking<Record<string, unknown>>(labelId, {
    apiKeyV2,
    dedupeKey: `ps-406:track:${labelId}`,
  });
}
