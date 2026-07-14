/**
 * Canonical numeric dollar-to-cent boundary.
 *
 * JavaScript binary floats can land just below an exact half-cent after money
 * math (for example, 12.5 * 1.15). Scale-aware tolerance restores that lost
 * representation dust, then ties round away from zero for symmetric credits.
 * Non-finite inputs retain the billing code's historical zero fallback.
 */
export function roundMoney(value: number): number {
  if (!Number.isFinite(value)) return 0;

  const scaled = Math.abs(value) * 100;
  const tolerance = Number.EPSILON * Math.max(1, scaled);
  const rounded = Math.floor(scaled + 0.5 + tolerance) / 100;

  if (rounded === 0) return 0;
  return value < 0 ? -rounded : rounded;
}
