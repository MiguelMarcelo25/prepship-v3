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
