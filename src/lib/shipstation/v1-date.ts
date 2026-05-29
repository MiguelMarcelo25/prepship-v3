export const SHIPSTATION_V1_ACCOUNT_TIME_ZONE = 'America/Los_Angeles';

const SHIPSTATION_DATE_PARTS = new Intl.DateTimeFormat('en-US', {
  timeZone: SHIPSTATION_V1_ACCOUNT_TIME_ZONE,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hour12: false,
});

function partMap(date: Date): Record<string, string> {
  return Object.fromEntries(
    SHIPSTATION_DATE_PARTS.formatToParts(date).map((part) => [part.type, part.value]),
  );
}

function partsWallClockMs(parts: Record<string, string>): number {
  return Date.UTC(
    Number(parts.year),
    Number(parts.month) - 1,
    Number(parts.day),
    Number(parts.hour),
    Number(parts.minute),
    Number(parts.second),
  );
}

function normalizeShipStationDateText(value: string): string {
  return value.trim().replace(' ', 'T');
}

export function parseShipStationV1Date(value?: string | null): Date | null {
  if (!value) return null;
  const trimmed = normalizeShipStationDateText(value);
  if (!trimmed) return null;

  const hasZone = /(?:z|[+-]\d{2}:?\d{2})$/i.test(trimmed);
  if (hasZone) {
    const parsed = new Date(trimmed);
    return Number.isNaN(parsed.getTime()) ? null : parsed;
  }

  const match = trimmed.match(
    /^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2}):(\d{2})(?:\.(\d+))?)?$/,
  );
  if (!match) {
    const parsed = new Date(trimmed);
    return Number.isNaN(parsed.getTime()) ? null : parsed;
  }

  const [, year, month, day, hour = '00', minute = '00', second = '00', fraction = ''] = match;
  const ms = Number((fraction + '000').slice(0, 3));
  const localWallMs = Date.UTC(
    Number(year),
    Number(month) - 1,
    Number(day),
    Number(hour),
    Number(minute),
    Number(second),
    ms,
  );

  let candidateMs = localWallMs;
  for (let i = 0; i < 2; i += 1) {
    const renderedWallMs = partsWallClockMs(partMap(new Date(candidateMs)));
    candidateMs += localWallMs - renderedWallMs;
  }

  // ShipStation v1 returns timezone-less order/shipment timestamps and
  // interprets query timestamps in the account timezone. Treat bare provider
  // timestamps the same way so stored order dates match the operator's source
  // dashboard instead of drifting by the UTC/PT offset.
  return new Date(candidateMs);
}

export function formatShipStationV1DateParam(ms: number): string {
  if (!Number.isFinite(ms)) {
    throw new Error('ShipStation v1 date param requires a finite epoch millisecond value');
  }
  const parts = partMap(new Date(ms));
  // ShipStation v1 accepts timezone-less date params and interprets them in
  // the account timezone. Sending stripped UTC text can push the query window
  // into the future during PT business hours and skip newly-created orders or
  // shipments. Per user override unlock shipped data on 2026-05-29: this shared
  // formatter covers order modifyDateStart and shipment createDateStart.
  return `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}:${parts.second}`;
}
