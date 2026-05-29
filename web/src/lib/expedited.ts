// PS-038 — Frontend MIRROR of the centralized expedited-shipping detector.
//
// This is a byte-for-byte copy of the normalization + matcher logic in the
// backend source of truth at src/lib/shipping/expedited.ts. The backend and
// frontend project trees are ISOLATED (web/tsconfig only includes web/src/**),
// so web/src cannot import from the backend src/ tree — the algorithm must be
// duplicated here. scripts/expedited-shipping-guard.ts pins the two copies in
// lockstep by comparing the normalization+matcher region byte-for-byte; if you
// change one, change the other identically or the guard fails.
//
// Used by web/src/components/Views/OrdersView.tsx to render the expedited badge
// + red row highlight on the BUYER'S REQUESTED service (orders.raw
// .requestedShippingService → orders.raw.serviceCode → orders.serviceCode),
// never the purchased label, for both Awaiting Shipment and Shipped rows.

export type ExpeditedTier = 'overnight' | 'one_day' | 'two_day' | 'expedited';

export interface ExpeditedDetection {
  /** True when any candidate string indicates an expedited service. */
  isExpedited: boolean;
  /** Coarse tier, most-urgent-wins. Null when not expedited. */
  tier: ExpeditedTier | null;
  /** Human-readable badge text: '1-Day' | '2-Day' | 'Overnight' | 'Expedited'. Null when not expedited. */
  label: string | null;
  /** The normalized candidate substring that triggered the match (for debugging/audit). Null when not expedited. */
  matchedText: string | null;
}

const NOT_EXPEDITED: ExpeditedDetection = {
  isExpedited: false,
  tier: null,
  label: null,
  matchedText: null,
};

// Normalize a candidate: lowercase, strip ®/™, collapse separators (_ - .) and
// runs of whitespace into single spaces. "UPS® Next-Day Air®" → "ups next day air",
// "ups_next_day_air" → "ups next day air", "FedEx 2Day®" → "fedex 2day".
export function normalizeServiceText(value: string | null | undefined): string {
  if (typeof value !== 'string') return '';
  return value
    .toLowerCase()
    .replace(/[®™]/g, '')
    .replace(/[_.\-/]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// Known-slow services that must NEVER be flagged expedited even though they may
// share a token with a positive pattern (e.g. "Express Saver" is FedEx's 3-day
// service; "3 Day Select" / "Priority Mail" are not overnight). Checked to veto
// only the ambiguous bare-"express"/"priority" positives below.
const EXPRESS_SAVER = /\bexpress\s*saver\b/;

// Ordered, most-urgent-first. Each entry's regex is matched against the
// normalized text; the first hit wins. Patterns are deliberately specific so
// ground/economy/standard/first class/media mail/parcel select/ground
// advantage/ground saver/surepost/smartpost never match.
interface Matcher {
  tier: ExpeditedTier;
  label: string;
  test: (normalized: string) => string | null;
}

function firstMatch(normalized: string, re: RegExp): string | null {
  const m = normalized.match(re);
  return m ? m[0] : null;
}

const MATCHERS: Matcher[] = [
  // Overnight — "priority overnight", "standard overnight", "fedex overnight".
  {
    tier: 'overnight',
    label: 'Overnight',
    test: (n) => firstMatch(n, /\bovernight\b/),
  },
  // One-day / next-day — "next day", "nextday", "next day air", "1 day",
  // "1day", "one day". (1-day/next-day are treated as the same 1-Day tier.)
  {
    tier: 'one_day',
    label: '1-Day',
    test: (n) => firstMatch(n, /\bnext ?day\b/) ?? firstMatch(n, /\b1 ?day\b/) ?? firstMatch(n, /\bone ?day\b/),
  },
  // Two-day — "2 day", "2day", "two day", "second day", "2nd day",
  // "express 2 day". Excludes "3 day select" etc. (only 2/two/second/2nd).
  {
    tier: 'two_day',
    label: '2-Day',
    test: (n) =>
      firstMatch(n, /\b2 ?day\b/) ??
      firstMatch(n, /\btwo ?day\b/) ??
      firstMatch(n, /\bsecond ?day\b/) ??
      firstMatch(n, /\b2nd ?day\b/),
  },
  // Generic expedited / express — "expedited", "priority mail express",
  // "priority express", and bare "express" EXCEPT FedEx "Express Saver"
  // (3-day). Bare "priority" / "standard" are intentionally NOT expedited.
  {
    tier: 'expedited',
    label: 'Expedited',
    test: (n) => {
      const expedited = firstMatch(n, /\bexpedited\b/);
      if (expedited) return expedited;
      const priorityExpress = firstMatch(n, /\bpriority (?:mail )?express\b/);
      if (priorityExpress) return priorityExpress;
      if (EXPRESS_SAVER.test(n)) return null;
      return firstMatch(n, /\bexpress\b/);
    },
  },
];

// Detect expedited shipping from one or more candidate strings (requested
// service name, requested service code, carrier code, …). Most-urgent tier
// across all candidates wins. Order of args is the search order only for ties
// within the same tier; tier priority always dominates.
export function detectExpeditedShipping(
  ...candidates: Array<string | null | undefined>
): ExpeditedDetection {
  let best: ExpeditedDetection = NOT_EXPEDITED;
  let bestRank = MATCHERS.length; // lower index = more urgent

  for (const candidate of candidates) {
    const normalized = normalizeServiceText(candidate);
    if (!normalized) continue;
    for (let rank = 0; rank < MATCHERS.length; rank += 1) {
      if (rank >= bestRank) break; // can't beat current best for this candidate
      const matcher = MATCHERS[rank];
      if (!matcher) continue;
      const matchedText = matcher.test(normalized);
      if (matchedText) {
        best = { isExpedited: true, tier: matcher.tier, label: matcher.label, matchedText };
        bestRank = rank;
        break;
      }
    }
    if (bestRank === 0) break; // overnight is the top tier — nothing beats it
  }

  return best;
}
