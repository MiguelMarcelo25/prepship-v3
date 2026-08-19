/**
 * PS-502 request-boundary proof for replacement side effects.
 *
 * This suite executes real Hono middleware, Zod validators, and handlers while replacing
 * every database, command, billing, inventory, and provider dependency with a local spy.
 * Both replacement flags stay OFF in the process environment. The exported side-effect
 * factory is exercised with a no-op label gate only after the real default-off gates have
 * been proved independently.
 */
import { Hono } from 'hono';
import type { ReplacementSideEffectRouteDependencies } from '../src/routes/replacements';

// Assign unconditionally before the route tree is imported. A developer shell must not be
// able to leak real credentials or an enabled replacement flag into this offline suite.
process.env.VERCEL = '1';
process.env.NODE_ENV = 'test';
process.env.DATABASE_URL = 'postgres://ps502:ps502@127.0.0.1:1/ps502_route_boundary';
process.env.SUPABASE_URL = 'https://ps502-route-boundary.supabase.invalid';
process.env.SUPABASE_ANON_KEY = 'ps502-route-boundary-anon-not-real';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'ps502-route-boundary-service-not-real';
process.env.SUPABASE_JWT_SECRET = 'ps502-route-boundary-jwt-not-real';
process.env.REPLACEMENTS_ENABLED = 'false';
process.env.REPLACEMENTS_LABEL_ENABLED = 'false';

const [{ default: replacementRouter, createReplacementSideEffectRouter }, { env }, labelModule] =
  await Promise.all([
    import('../src/routes/replacements'),
    import('../src/lib/env'),
    import('../src/services/replacement-label-purchase-command'),
  ]);

if (new URL(process.env.DATABASE_URL).hostname !== '127.0.0.1') {
  throw new Error('Refusing to run: the route-boundary database URL is not loopback');
}
if (env.REPLACEMENTS_ENABLED || env.REPLACEMENTS_LABEL_ENABLED) {
  throw new Error('Refusing to run: both replacement flags must remain off');
}

type AuthContext = {
  userId: string;
  email: string;
  role: string;
  permissions: string[];
};

type Counters = {
  labelGate: number;
  loadScopedReplacement: number;
  insertShipment: number;
  purchaseLabel: number;
  reconcileLabelPricing: number;
  voidLabel: number;
  ship: number;
  providerFor: number;
  consumePackage: number;
  writeBilling: number;
  requestFinancialReversal: number;
  processFinancialAction: number;
  readFinancialAction: number;
};

type HarnessOptions = {
  labelGate?: 'fake-on' | 'real-off';
  scoped?: boolean;
  purchaseReplay?: boolean;
  financialError?: Error;
  enforceFinancialWrite?: boolean;
};

const INTERNAL_EMAIL = 'ps502.operator@test.invalid';
const INTERNAL_BASE: AuthContext = {
  userId: 'ps502-operator',
  email: INTERNAL_EMAIL,
  role: 'custom_internal',
  permissions: [],
};

const validPurchaseBody = {
  overrideReason: 'Operator verified the replacement purchase inputs',
  address: {
    name: 'PS-502 Test Recipient',
    line1: '1 Test Way',
    city: 'Testville',
    state: 'CA',
    postalCode: '90210',
    country: 'US',
    residential: true,
  },
  carrier: {
    carrierCode: 'ups',
    serviceCode: 'ups_ground',
    providerAccountId: 7,
  },
  package: {
    packageId: 'pkg-test-1',
    weightOz: 16,
    dimsL: 8,
    dimsW: 6,
    dimsH: 4,
  },
};

const validVoidBody = {
  reason: 'Operator requested a safe replacement-label void',
  expectedStatus: 'label_created',
  expectedStateVersion: 3,
};

const validShipBody = {
  inventoryLines: [{ replacementItemId: 51, inventoryId: 71 }],
};

const validFinancialBody = {
  reason: 'Reverse this replacement only after a reviewed customer adjustment',
  idempotencyKey: 'ps502-financial-reversal-42-v1',
};

let failures = 0;

function check(name: string, condition: boolean, detail?: string): void {
  if (condition) {
    console.log(`ok   ${name}`);
    return;
  }
  failures += 1;
  console.error(`FAIL ${name}${detail ? `\n     ${detail}` : ''}`);
}

function codedError(status: number, code: string, message: string, details?: unknown): Error {
  return Object.assign(new Error(message), { httpStatus: status, code, details });
}

function emptyCounters(): Counters {
  return {
    labelGate: 0,
    loadScopedReplacement: 0,
    insertShipment: 0,
    purchaseLabel: 0,
    reconcileLabelPricing: 0,
    voidLabel: 0,
    ship: 0,
    providerFor: 0,
    consumePackage: 0,
    writeBilling: 0,
    requestFinancialReversal: 0,
    processFinancialAction: 0,
    readFinancialAction: 0,
  };
}

function callsPastFeatureGate(counters: Counters): number {
  return Object.entries(counters)
    .filter(([name]) => name !== 'labelGate')
    .reduce((total, [, count]) => total + count, 0);
}

function commandAndProviderCalls(counters: Counters): number {
  return Object.entries(counters)
    .filter(([name]) => name !== 'labelGate' && name !== 'loadScopedReplacement')
    .reduce((total, [, count]) => total + count, 0);
}

async function responseBody(response: Response): Promise<Record<string, any>> {
  return JSON.parse(await response.text()) as Record<string, any>;
}

async function post(
  app: { request: (...args: any[]) => Response | Promise<Response> },
  path: string,
  body: unknown,
): Promise<Response> {
  return await app.request(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

function makeHarness(auth: AuthContext, options: HarnessOptions = {}) {
  const counters = emptyCounters();
  const providerSentinel = { kind: 'ps502-fake-provider-no-network' };
  let purchaseInput: any = null;
  let purchaseProvider: unknown = null;
  let pricingInput: any = null;
  let voidInput: any = null;
  let voidProvider: unknown = null;
  let shipInput: any = null;
  let financialInput: any = null;

  const consumePackage = async () => {
    counters.consumePackage += 1;
    return { movementId: 1 };
  };
  const writeBilling = async () => {
    counters.writeBilling += 1;
    return { lineIds: [] };
  };

  const dependencies = {
    loadScopedReplacement: async () => {
      counters.loadScopedReplacement += 1;
      return options.scoped === false ? null : { id: 42, status: 'approved' };
    },
    assertLabelEnabled: () => {
      counters.labelGate += 1;
      if (options.labelGate === 'real-off') {
        labelModule.assertReplacementLabelEnabled();
      }
    },
    insertShipment: async () => {
      counters.insertShipment += 1;
      return { shipment: { id: 420 }, created: false };
    },
    purchaseLabel: async (input: unknown, provider: unknown) => {
      counters.purchaseLabel += 1;
      purchaseInput = input;
      purchaseProvider = provider;
      if (options.purchaseReplay) {
        return {
          purchased: false,
          replayed: true,
          replacement: { id: 42, status: 'label_created' },
        };
      }
      return {
        purchased: true,
        replayed: false,
        replacement: { id: 42, status: 'label_created' },
      };
    },
    reconcileLabelPricing: async (input: unknown) => {
      counters.reconcileLabelPricing += 1;
      pricingInput = input;
      return {
        replacementId: 42,
        intentId: 77,
        shipmentId: 420,
        frozenCustomerShippingMoney: { cShippingRateAmount: 9.75 },
        reconciled: true,
      };
    },
    voidLabel: async (input: unknown, provider: unknown) => {
      counters.voidLabel += 1;
      voidInput = input;
      voidProvider = provider;
      return { replacement: { id: 42, status: 'approved' }, alreadyVoided: false };
    },
    ship: async (input: unknown) => {
      counters.ship += 1;
      shipInput = input;
      return { replacement: { id: 42, status: 'shipped' } };
    },
    providerFor: () => {
      counters.providerFor += 1;
      return providerSentinel;
    },
    consumePackage,
    writeBilling,
    requestFinancialReversal: async (input: any) => {
      counters.requestFinancialReversal += 1;
      financialInput = input;
      if (options.enforceFinancialWrite && !input.actor.permissions.includes('financials:write')) {
        throw codedError(
          403,
          'REPLACEMENT_FINANCIAL_PERMISSION_REQUIRED',
          'financials:write is required',
        );
      }
      if (options.financialError) throw options.financialError;
      return {
        action: { id: 901, replacementId: 42, status: 'completed' },
        alreadyRequested: false,
      };
    },
    processFinancialAction: async () => {
      counters.processFinancialAction += 1;
      return { id: 901, replacementId: 42, status: 'completed' };
    },
    readFinancialAction: async () => {
      counters.readFinancialAction += 1;
      return { id: 901, replacementId: 42, status: 'pending' };
    },
  } as unknown as ReplacementSideEffectRouteDependencies;

  const app = new Hono();
  app.use('*', async (c, next) => {
    c.set('userId' as never, auth.userId as never);
    c.set('email' as never, auth.email as never);
    c.set('role' as never, auth.role as never);
    c.set('permissions' as never, auth.permissions as never);
    c.set('clientIds' as never, [10] as never);
    c.set('storeIds' as never, [100] as never);
    await next();
  });
  app.route('/', createReplacementSideEffectRouter(dependencies));

  return {
    app,
    counters,
    providerSentinel,
    consumePackage,
    writeBilling,
    captured: {
      get purchaseInput() { return purchaseInput; },
      get purchaseProvider() { return purchaseProvider; },
      get pricingInput() { return pricingInput; },
      get voidInput() { return voidInput; },
      get voidProvider() { return voidProvider; },
      get shipInput() { return shipInput; },
      get financialInput() { return financialInput; },
    },
  };
}

console.log('\nouter feature gate');
{
  const response = await post(replacementRouter, '/42/label/purchase', validPurchaseBody);
  const body = await responseBody(response);
  check(
    'the real full router refuses every side effect while REPLACEMENTS_ENABLED is off',
    response.status === 403 && body.code === 'REPLACEMENTS_DISABLED',
    `${response.status} ${JSON.stringify(body)}`,
  );
}

console.log('\nauth and label feature gates');
{
  const harness = makeHarness({
    ...INTERNAL_BASE,
    role: 'client_user',
    permissions: ['replacements:label'],
  });
  const response = await post(harness.app, '/42/label/purchase', validPurchaseBody);
  check('a portal role is denied even when it claims replacements:label', response.status === 403);
  check('portal denial precedes feature, scope, command, and provider work',
    harness.counters.labelGate === 0 && callsPastFeatureGate(harness.counters) === 0);
}

{
  const harness = makeHarness(INTERNAL_BASE);
  const response = await post(harness.app, '/42/label/purchase', validPurchaseBody);
  check('an internal caller missing replacements:label is denied', response.status === 403);
  check('permission denial precedes feature, scope, command, and provider work',
    harness.counters.labelGate === 0 && callsPastFeatureGate(harness.counters) === 0);
}

for (const [name, path, body, permissions] of [
  ['purchase', '/42/label/purchase', validPurchaseBody, ['replacements:label']],
  ['pricing reconcile', '/42/label/purchase-intents/77/pricing-reconcile',
    { reason: 'Re-evaluate customer money from the active policy' }, ['replacements:label']],
  ['void', '/42/label/void', validVoidBody, ['replacements:label']],
  ['ship', '/42/ship', validShipBody, ['replacements:write', 'inventory:write']],
] as const) {
  const harness = makeHarness({ ...INTERNAL_BASE, permissions: [...permissions] }, { labelGate: 'real-off' });
  const response = await post(harness.app, path, body);
  const responseJson = await responseBody(response);
  check(`${name} is refused by the real REPLACEMENTS_LABEL_ENABLED-off gate`,
    response.status === 403 && responseJson.code === 'REPLACEMENT_LABEL_FEATURE_DISABLED');
  check(`${name} label-feature refusal reaches no scope loader, command, or provider`,
    harness.counters.labelGate === 1 && callsPastFeatureGate(harness.counters) === 0);
}

console.log('\nstrict input and scope');
{
  const harness = makeHarness({ ...INTERNAL_BASE, permissions: ['replacements:label'] });
  const response = await post(harness.app, '/42/label/purchase', {
    ...validPurchaseBody,
    carrier: { ...validPurchaseBody.carrier, chosenBy: 'spoofed@test.invalid' },
  });
  check('purchase rejects a nested provenance-spoofing field with a strict 400', response.status === 400);
  check('malformed purchase input reaches no scope loader, command, or provider',
    harness.counters.labelGate === 1 && callsPastFeatureGate(harness.counters) === 0);
}

{
  const harness = makeHarness({ ...INTERNAL_BASE, permissions: ['replacements:billing'] });
  const response = await post(harness.app, '/42/financial-reversal', {
    ...validFinancialBody,
    replacementId: 999,
  });
  check('financial reversal rejects unknown fields with a strict 400', response.status === 400);
  check('malformed financial input reaches no scope loader, command, or provider',
    callsPastFeatureGate(harness.counters) === 0);
}

{
  const harness = makeHarness(
    { ...INTERNAL_BASE, permissions: ['replacements:label'] },
    { scoped: false },
  );
  const response = await post(harness.app, '/42/label/purchase', validPurchaseBody);
  const body = await responseBody(response);
  check('an out-of-scope replacement is indistinguishable from an absent id',
    response.status === 404 && body.error === 'Not found' && body.code === undefined);
  check('scope 404 stops before shipment, command, and provider boundaries',
    harness.counters.loadScopedReplacement === 1 && commandAndProviderCalls(harness.counters) === 0);
}

{
  const harness = makeHarness({ ...INTERNAL_BASE, permissions: ['replacements:label'] });
  const response = await post(
    harness.app,
    '/42/label/purchase-intents/77/pricing-reconcile',
    { reason: 'Re-evaluate customer money from the active policy', providerAccountId: 7 },
  );
  check('pricing reconciliation accepts reason only and rejects provider-shaped fields',
    response.status === 400);
  check('malformed pricing reconciliation reaches no scope, command, or provider',
    harness.counters.loadScopedReplacement === 0
      && harness.counters.reconcileLabelPricing === 0
      && harness.counters.providerFor === 0);
}

console.log('\ncommand-owned errors and financial permissions');
{
  const harness = makeHarness(
    { ...INTERNAL_BASE, permissions: ['replacements:billing'] },
    { enforceFinancialWrite: true },
  );
  const response = await post(harness.app, '/42/financial-reversal', validFinancialBody);
  const body = await responseBody(response);
  check('replacements:billing without financials:write is a command-coded 403',
    response.status === 403 && body.code === 'REPLACEMENT_FINANCIAL_PERMISSION_REQUIRED');
  check('the financial permission refusal calls only scope + the command and no provider/drain',
    harness.counters.loadScopedReplacement === 1
      && harness.counters.requestFinancialReversal === 1
      && harness.counters.providerFor === 0
      && harness.counters.processFinancialAction === 0
      && harness.counters.readFinancialAction === 0);
}

for (const [status, code] of [
  [404, 'REPLACEMENT_NOT_FOUND'],
  [409, 'REPLACEMENT_FINANCIAL_STATE_CONFLICT'],
] as const) {
  const harness = makeHarness(
    { ...INTERNAL_BASE, permissions: ['replacements:billing', 'financials:write'] },
    {
      financialError: codedError(
        status,
        code,
        `coded ${status} from the canonical financial command`,
        status === 409 ? { currentStatus: 'review_required' } : undefined,
      ),
    },
  );
  const response = await post(harness.app, '/42/financial-reversal', validFinancialBody);
  const body = await responseBody(response);
  check(`the route preserves a command-coded ${status}`, response.status === status && body.code === code);
  check(`command-coded ${status} triggers no provider or financial drain`,
    harness.counters.providerFor === 0
      && harness.counters.processFinancialAction === 0
      && harness.counters.readFinancialAction === 0);
  if (status === 409) {
    check('the route preserves command error details', body.details?.currentStatus === 'review_required');
  }
}

{
  const harness = makeHarness({
    ...INTERNAL_BASE,
    permissions: ['replacements:billing', 'financials:write'],
  });
  const response = await post(harness.app, '/42/financial-reversal', validFinancialBody);
  const body = await responseBody(response);
  check('an internal caller with both financial permissions reaches the command',
    response.status === 200 && body.action?.status === 'completed');
  check('the command receives both effective permissions and no provider is resolved',
    harness.captured.financialInput?.actor?.permissions.includes('replacements:billing')
      && harness.captured.financialInput?.actor?.permissions.includes('financials:write')
      && harness.counters.providerFor === 0);
}

console.log('\npurchase, void, and ship success boundaries');
{
  const harness = makeHarness({ ...INTERNAL_BASE, permissions: ['replacements:label'] });
  const response = await post(
    harness.app,
    '/42/label/purchase-intents/77/pricing-reconcile',
    { reason: 'Re-evaluate customer money from the active policy' },
  );
  check('pricing reconciliation is scoped and calls the provider-free recovery command',
    response.status === 200
      && harness.counters.loadScopedReplacement === 1
      && harness.counters.reconcileLabelPricing === 1
      && harness.counters.providerFor === 0);
  check('pricing reconciliation binds replacement, intent, named actor, and reason',
    harness.captured.pricingInput?.replacementId === 42
      && harness.captured.pricingInput?.intentId === 77
      && harness.captured.pricingInput?.actor?.email === INTERNAL_EMAIL
      && harness.captured.pricingInput?.reason === 'Re-evaluate customer money from the active policy');
}

{
  const harness = makeHarness(
    { ...INTERNAL_BASE, permissions: ['replacements:label'] },
    { purchaseReplay: true },
  );
  const response = await post(harness.app, '/42/label/purchase', validPurchaseBody);
  const body = await responseBody(response);
  const purchaseInputs = harness.captured.purchaseInput?.purchaseInputs;
  check('a purchase replay returns 200 and the replay payload, not a second-created 201',
    response.status === 200 && body.purchased === false && body.replayed === true);
  check('the replay traverses one shipment handoff, one command, and one fake provider resolver',
    harness.counters.insertShipment === 1
      && harness.counters.purchaseLabel === 1
      && harness.counters.providerFor === 1
      && harness.captured.purchaseProvider === harness.providerSentinel);
  check('operator provenance is server-authored from the verified actor',
    ['address', 'carrier', 'package'].every((key) => (
      purchaseInputs?.[key]?.source === 'operator_override'
        && purchaseInputs?.[key]?.chosenBy === INTERNAL_EMAIL
        && purchaseInputs?.[key]?.reason === validPurchaseBody.overrideReason
    )));
}

{
  const harness = makeHarness({ ...INTERNAL_BASE, permissions: ['replacements:label'] });
  const response = await post(harness.app, '/42/label/void', validVoidBody);
  check('an internal replacements:label caller reaches the void command',
    response.status === 200
      && harness.counters.voidLabel === 1
      && harness.counters.providerFor === 1
      && harness.captured.voidProvider === harness.providerSentinel);
  check('void receives the authenticated actor and written reason',
    harness.captured.voidInput?.actor?.email === INTERNAL_EMAIL
      && harness.captured.voidInput?.reason === validVoidBody.reason);
}

for (const [name, permissions] of [
  ['missing replacements:write', ['inventory:write']],
  ['missing inventory:write', ['replacements:write']],
] as const) {
  const harness = makeHarness({ ...INTERNAL_BASE, permissions: [...permissions] });
  const response = await post(harness.app, '/42/ship', validShipBody);
  check(`ship denies an internal caller ${name}`, response.status === 403);
  check(`ship ${name} is refused before feature, scope, command, inventory, or billing`,
    harness.counters.labelGate === 0 && callsPastFeatureGate(harness.counters) === 0);
}

{
  const harness = makeHarness({
    ...INTERNAL_BASE,
    permissions: ['replacements:write', 'inventory:write'],
  });
  const response = await post(harness.app, '/42/ship', validShipBody);
  check('ship reaches its command only when both write permissions are present',
    response.status === 200
      && harness.counters.loadScopedReplacement === 1
      && harness.counters.ship === 1);
  check('ship passes only the injected offline inventory and billing owners',
    harness.captured.shipInput?.consumePackage === harness.consumePackage
      && harness.captured.shipInput?.writeBilling === harness.writeBilling
      && harness.counters.consumePackage === 0
      && harness.counters.writeBilling === 0
      && harness.counters.providerFor === 0);
}

console.log(
  `\n${failures === 0
    ? 'PS-502 replacement route boundary passed.'
    : `PS-502 replacement route boundary FAILED with ${failures} failure(s).`}`,
);
if (failures > 0) process.exit(1);
