# Audit 3.7 — Money rounding placement

## Architecture placement / source-of-truth gate

- **Business rule/workflow:** Backend numeric dollar calculations cross into
  persisted or customer-visible cents through one deterministic rounding rule.
  Exact half-cent ties round away from zero, including negative credits.
- **Canonical backend owner:** `src/lib/money.ts#roundMoney` owns numeric
  dollar-to-cent rounding. Formula owners may calculate at higher precision but
  must delegate when producing a cent amount.
- **Current duplicated/unsafe owners:** Billing storage, shipping markup,
  selected-rate billing, box-cost actions, HUGRAB billing adjustments, and the
  order-row rate-money DTO each carried local `round2` / `roundMoney` variants.
  Billing generation also relied on implicit `Number#toFixed(2)` rounding.
- **Earliest imperfect-data entry:** Binary floating-point error first appears
  after multiplication or addition, such as `12.5 * 1.15` becoming
  `14.374999999999998`, before a billing line or rate DTO is serialized.
- **Callers that delegate:** Billing decisions and line generation, billing
  storage/override/box helpers, the canonical markup resolver, and backend rate
  money display delegate to `roundMoney` at their cent boundaries.
- **Logic deleted or forbidden:** Scoped local `round2`, `roundCents`, and
  `roundMoney` implementations are removed. New backend money boundaries must
  not use `Math.round(value * 100) / 100` or raw `toFixed(2)` as their rounding
  authority.
- **Frontend role:** Display backend money DTOs and submit operator intent only.
  No frontend money rule changes are part of this slice.
- **Backend boundary proof:** `test:audit-money-rounding` proves positive and
  negative half-cent behavior, float-dust recovery, non-finite fallback, markup
  and billing parity, source delegation, and absence of scoped local owners.
- **Workflow proof:** Existing billing, markup, PS-798, PS-313, and consolidated
  source-of-truth guards prove downstream quote/invoice parity.

## Deferred boundary

Audit B-8 explicitly defers integer-cent persistence. Existing numeric columns
and DTO shapes remain unchanged in this slice.
