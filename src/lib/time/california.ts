export const CALIFORNIA_TIME_ZONE = 'America/Los_Angeles';

const CA_PARTS = new Intl.DateTimeFormat('en-US', {
  timeZone: CALIFORNIA_TIME_ZONE,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  // h23 guarantees midnight is 00:00. Node 20's default h24 cycle emits
  // 24:00, which the wall-clock conversion would interpret as the next day.
  hourCycle: 'h23',
});

function partMap(date: Date): Record<string, string> {
  return Object.fromEntries(CA_PARTS.formatToParts(date).map((part) => [part.type, part.value]));
}

function wallClockMs(parts: Record<string, string>): number {
  return Date.UTC(
    Number(parts.year),
    Number(parts.month) - 1,
    Number(parts.day),
    Number(parts.hour),
    Number(parts.minute),
    Number(parts.second),
  );
}

export function californiaWallClockToUtc(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  second: number,
  ms = 0,
): Date {
  const targetWallMs = Date.UTC(year, month - 1, day, hour, minute, second, 0);
  let candidateMs = targetWallMs;
  for (let i = 0; i < 2; i += 1) {
    candidateMs += targetWallMs - wallClockMs(partMap(new Date(candidateMs)));
  }
  return new Date(candidateMs + ms);
}

function parseDay(day: string): [number, number, number] {
  return [Number(day.slice(0, 4)), Number(day.slice(5, 7)), Number(day.slice(8, 10))];
}

export function californiaDayStart(day: string): Date {
  const [year, month, date] = parseDay(day);
  return californiaWallClockToUtc(year, month, date, 0, 0, 0, 0);
}

export function californiaDayEnd(day: string): Date {
  const [year, month, date] = parseDay(day);
  return californiaWallClockToUtc(year, month, date, 23, 59, 59, 999);
}

export function coerceCaliforniaIsoDay(raw: string | undefined, endOfDay: boolean): string | undefined {
  if (!raw) return undefined;
  if (raw.includes('T')) return raw;
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) {
    return (endOfDay ? californiaDayEnd(raw) : californiaDayStart(raw)).toISOString();
  }
  return raw;
}
