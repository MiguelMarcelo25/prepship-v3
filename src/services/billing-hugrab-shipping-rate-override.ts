export const HUGRAB_SHIPPING_RATE_OVERRIDE_CLIENT_NAME = 'HUGRAB';
export const DEFAULT_HUGRAB_SHIPPING_RATE_OVERRIDE_THRESHOLD = 6;
export const DEFAULT_HUGRAB_SHIPPING_RATE_OVERRIDE_AMOUNT = 7.73;

export type HugrabShippingRateOverrideConfig = {
  enabled?: boolean | null;
  threshold?: number | string | null;
  amount?: number | string | null;
};

export type HugrabShippingRateOverrideInput = {
  clientName: string | null | undefined;
  customerShippingRate: number;
  selectedRateCost: number | null | undefined;
  config?: HugrabShippingRateOverrideConfig | null;
};

export type HugrabShippingRateOverrideDecision = {
  customerShippingRate: number;
  selectedRateCost: number | null;
  overrideApplied: boolean;
  overrideThreshold: number;
  overrideAmount: number;
};

export type ClientHugrabShippingRateOverrideConfig = {
  enabled: boolean;
  threshold: number;
  amount: number;
};

async function getPg() {
  return (await import('../db/client.js')).sql;
}

function roundMoney(value: number): number {
  return Math.round((Number.isFinite(value) ? value : 0) * 100) / 100;
}

function positiveNumber(value: unknown, fallback: number): number {
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? roundMoney(parsed) : fallback;
}

function isHugrabClient(clientName: string | null | undefined): boolean {
  return String(clientName ?? '').trim().toUpperCase() === HUGRAB_SHIPPING_RATE_OVERRIDE_CLIENT_NAME;
}

export function resolveHugrabShippingRateOverride(
  input: HugrabShippingRateOverrideInput,
): HugrabShippingRateOverrideDecision {
  const currentShippingRate = roundMoney(input.customerShippingRate);
  const selectedRateCost = input.selectedRateCost == null ? null : roundMoney(Number(input.selectedRateCost));
  const threshold = positiveNumber(input.config?.threshold, DEFAULT_HUGRAB_SHIPPING_RATE_OVERRIDE_THRESHOLD);
  const amount = positiveNumber(input.config?.amount, DEFAULT_HUGRAB_SHIPPING_RATE_OVERRIDE_AMOUNT);
  const enabled = input.config?.enabled ?? true;

  if (!isHugrabClient(input.clientName) || !enabled || currentShippingRate <= 0) {
    return {
      customerShippingRate: currentShippingRate,
      selectedRateCost,
      overrideApplied: false,
      overrideThreshold: threshold,
      overrideAmount: amount,
    };
  }

  const triggerRate = selectedRateCost ?? currentShippingRate;
  const overrideApplied = triggerRate < threshold && amount > currentShippingRate;
  return {
    customerShippingRate: overrideApplied ? amount : currentShippingRate,
    selectedRateCost,
    overrideApplied,
    overrideThreshold: threshold,
    overrideAmount: amount,
  };
}

export async function ensureHugrabShippingRateOverrideColumns(): Promise<void> {
  const { assertRuntimeSchemaReady } = await import('./runtime-schema-readiness.js');
  await assertRuntimeSchemaReady();
}

export async function hugrabShippingRateOverrideConfigsByClientId(
  clientIds: number[],
): Promise<Map<number, ClientHugrabShippingRateOverrideConfig>> {
  const ids = [...new Set(clientIds.filter((id) => Number.isInteger(id) && id > 0))];
  const out = new Map<number, ClientHugrabShippingRateOverrideConfig>();
  if (!ids.length) return out;

  await ensureHugrabShippingRateOverrideColumns();
  const pg = await getPg();
  const rows = (await pg`
    select
      c.id as client_id,
      coalesce(
        b.hugrab_shipping_rate_override_enabled,
        upper(c.name) = ${HUGRAB_SHIPPING_RATE_OVERRIDE_CLIENT_NAME}
      ) as enabled,
      coalesce(
        b.hugrab_shipping_rate_override_threshold,
        ${DEFAULT_HUGRAB_SHIPPING_RATE_OVERRIDE_THRESHOLD}::numeric
      )::text as threshold,
      coalesce(
        b.hugrab_shipping_rate_override_amount,
        ${DEFAULT_HUGRAB_SHIPPING_RATE_OVERRIDE_AMOUNT}::numeric
      )::text as amount
    from clients c
    left join billing_config b on b.client_id = c.id
    where c.id = any(${ids})
  `) as Array<{ client_id: number; enabled: boolean; threshold: string; amount: string }>;

  for (const row of rows) {
    out.set(Number(row.client_id), {
      enabled: row.enabled === true,
      threshold: positiveNumber(row.threshold, DEFAULT_HUGRAB_SHIPPING_RATE_OVERRIDE_THRESHOLD),
      amount: positiveNumber(row.amount, DEFAULT_HUGRAB_SHIPPING_RATE_OVERRIDE_AMOUNT),
    });
  }
  return out;
}

export async function setClientHugrabShippingRateOverrideConfig(
  clientId: number,
  patch: Partial<ClientHugrabShippingRateOverrideConfig>,
): Promise<ClientHugrabShippingRateOverrideConfig> {
  await ensureHugrabShippingRateOverrideColumns();
  const pg = await getPg();
  const hasEnabled = patch.enabled !== undefined;
  const hasThreshold = patch.threshold !== undefined;
  const hasAmount = patch.amount !== undefined;
  const enabled = hasEnabled ? patch.enabled === true : null;
  const threshold = hasThreshold
    ? positiveNumber(patch.threshold, DEFAULT_HUGRAB_SHIPPING_RATE_OVERRIDE_THRESHOLD).toFixed(2)
    : null;
  const amount = hasAmount
    ? positiveNumber(patch.amount, DEFAULT_HUGRAB_SHIPPING_RATE_OVERRIDE_AMOUNT).toFixed(2)
    : null;

  await pg`
    insert into billing_config (
      client_id,
      hugrab_shipping_rate_override_enabled,
      hugrab_shipping_rate_override_threshold,
      hugrab_shipping_rate_override_amount
    )
    values (${clientId}, ${enabled}, ${threshold}, ${amount})
    on conflict (client_id) do update set
      hugrab_shipping_rate_override_enabled = case
        when ${hasEnabled} then excluded.hugrab_shipping_rate_override_enabled
        else billing_config.hugrab_shipping_rate_override_enabled
      end,
      hugrab_shipping_rate_override_threshold = case
        when ${hasThreshold} then excluded.hugrab_shipping_rate_override_threshold
        else billing_config.hugrab_shipping_rate_override_threshold
      end,
      hugrab_shipping_rate_override_amount = case
        when ${hasAmount} then excluded.hugrab_shipping_rate_override_amount
        else billing_config.hugrab_shipping_rate_override_amount
      end,
      updated_at = now()
  `;

  const next = await hugrabShippingRateOverrideConfigsByClientId([clientId]);
  return next.get(clientId) ?? {
    enabled: false,
    threshold: DEFAULT_HUGRAB_SHIPPING_RATE_OVERRIDE_THRESHOLD,
    amount: DEFAULT_HUGRAB_SHIPPING_RATE_OVERRIDE_AMOUNT,
  };
}
