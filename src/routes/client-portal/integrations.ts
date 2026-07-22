import { Hono } from 'hono';
import type { Context } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import {
  isPortalSession,
  requirePermission,
  type AuthVars,
} from '../../middleware/auth';
import {
  getInternalOpsClientStoreScope,
  isClientVisibleToScope,
} from '../../lib/client-store-scope';
import { validateShopifyCredentials } from '../../connectors/store/shopify';
import {
  PortalShopifyIntegrationError,
  submitPortalShopifyIntegration,
} from '../../services/portal-shopify-integrations';
import {
  freezeReturnCustomerShippingMoney,
  getShipmentCustomerShippingMoneyTarget,
  previewReturnCustomerShippingMoney,
  ReturnCustomerShippingPolicyUnavailableError,
} from '../../services/customer-shipping-money';

const app = new Hono<{ Variables: AuthVars }>();

const VALIDATION_WINDOW_MS = 60_000;
const VALIDATION_LIMIT = 5;
const validationBuckets = new Map<string, { count: number; resetAt: number }>();

function stringField(body: Record<string, unknown>, key: string): string {
  const value = body[key];
  return typeof value === 'string' ? value.trim() : '';
}

async function parseBody(c: Context): Promise<Record<string, unknown>> {
  const body = await c.req.json().catch(() => ({}));
  return body && typeof body === 'object' && !Array.isArray(body)
    ? body as Record<string, unknown>
    : {};
}

export function primaryPortalClientId(c: Context<{ Variables: AuthVars }>): number | null {
  const clientIds = c.get('clientIds');
  const clientId = Array.isArray(clientIds) ? clientIds[0] : null;
  return typeof clientId === 'number' && Number.isInteger(clientId) && clientId > 0
    ? clientId
    : null;
}

export function rateLimitShopifyValidation(userId: string): boolean {
  const now = Date.now();
  const bucket = validationBuckets.get(userId);
  if (!bucket || bucket.resetAt <= now) {
    validationBuckets.set(userId, { count: 1, resetAt: now + VALIDATION_WINDOW_MS });
    return true;
  }
  if (bucket.count >= VALIDATION_LIMIT) return false;
  bucket.count += 1;
  return true;
}

function requirePortalClient(c: Context<{ Variables: AuthVars }>): number | Response {
  if (!isPortalSession({ role: c.get('role') })) {
    return c.json({ error: 'Portal access required' }, 403);
  }
  const clientId = primaryPortalClientId(c);
  if (!clientId) {
    return c.json({ error: 'Client scope required' }, 403);
  }
  return clientId;
}

app.post('/integrations/validate', async (c) => {
  const clientId = requirePortalClient(c);
  if (clientId instanceof Response) return clientId;

  const userId = c.get('userId') ?? `client:${clientId}`;
  if (!rateLimitShopifyValidation(userId)) {
    return c.json({ error: 'Too many validation attempts' }, 429);
  }

  const body = await parseBody(c);
  // Keep adminAccessToken redacted from logs and responses; it is used only for
  // this server-side validation call.
  const validation = await validateShopifyCredentials({
    shopDomain: stringField(body, 'shopDomain'),
    adminAccessToken: stringField(body, 'adminAccessToken'),
  });

  if (!validation.ok) {
    return c.json({ ok: false, error: validation.error }, 400);
  }

  return c.json({
    ok: true,
    shopName: validation.shopName,
    myshopifyDomain: validation.myshopifyDomain,
  });
});

app.post('/integrations', async (c) => {
  const clientId = requirePortalClient(c);
  if (clientId instanceof Response) return clientId;

  const body = await parseBody(c);
  try {
    const integration = await submitPortalShopifyIntegration({
      clientId,
      shopDomain: stringField(body, 'shopDomain'),
      adminAccessToken: stringField(body, 'adminAccessToken'),
      label: stringField(body, 'label'),
    });

    return c.json({ ok: true, provider: 'shopify', data: integration }, 201);
  } catch (error) {
    const status = error instanceof PortalShopifyIntegrationError ? error.status : 500;
    const message =
      error instanceof PortalShopifyIntegrationError
        ? error.message
        : 'Unable to submit Shopify integration';
    return c.json({ ok: false, error: message }, status as 400);
  }
});

const freezeCustomerShippingMoneySchema = z.object({
  shipmentId: z.number().int().positive(),
});

const previewReturnCustomerShippingMoneySchema = z.object({
  sourceShipmentId: z.number().int().positive(),
  selectedRateCost: z.number().positive().max(100_000),
  carrierCode: z.string().trim().max(100).nullable().optional(),
  providerAccountId: z.number().int().positive().nullable().optional(),
});

// PS-435: fail closed before Client Portal calls a postage provider. The route
// validates scope and delegates every pricing decision to the canonical owner;
// its response deliberately omits selected cost and margin.
app.post(
  '/customer-shipping-money/return-preview',
  requirePermission('billing:generate'),
  zValidator('json', previewReturnCustomerShippingMoneySchema),
  async (c) => {
    const input = c.req.valid('json');
    const target = await getShipmentCustomerShippingMoneyTarget(input.sourceShipmentId);
    const scope = getInternalOpsClientStoreScope({
      email: c.get('email'),
      role: c.get('role'),
      permissions: c.get('permissions'),
      clientIds: c.get('clientIds'),
      storeIds: c.get('storeIds'),
    });
    if (
      !target ||
      target.isReturn ||
      !isClientVisibleToScope({ id: target.clientId, storeIds: target.storeIds }, scope)
    ) {
      return c.json({ error: 'Outbound shipment not found' }, 404);
    }
    try {
      const preview = await previewReturnCustomerShippingMoney(input);
      return c.json({
        data: {
          cShippingRateAmount: preview.cShippingRateAmount,
          customerRateSource: preview.customerRateSource,
          customerShippingMoneyPolicyVersion: preview.customerShippingMoneyPolicyVersion,
        },
      });
    } catch (error) {
      if (error instanceof ReturnCustomerShippingPolicyUnavailableError) {
        return c.json({ error: error.message }, 422);
      }
      throw error;
    }
  },
);

// PS-437: a portal user submits only a return shipment identity. PrepShip
// reloads exact selected cost + account policy and returns only customer-safe
// fields. The portal client id must own the shipment; internal money stays here.
app.post(
  '/customer-shipping-money/freeze',
  requirePermission('billing:generate'),
  zValidator('json', freezeCustomerShippingMoneySchema),
  async (c) => {
    const { shipmentId } = c.req.valid('json');
    const target = await getShipmentCustomerShippingMoneyTarget(shipmentId);
    const scope = getInternalOpsClientStoreScope({
      email: c.get('email'),
      role: c.get('role'),
      permissions: c.get('permissions'),
      clientIds: c.get('clientIds'),
      storeIds: c.get('storeIds'),
    });
    if (
      !target?.isReturn ||
      !isClientVisibleToScope({ id: target.clientId, storeIds: target.storeIds }, scope)
    ) {
      return c.json({ error: 'Return shipment not found' }, 404);
    }
    try {
      const snapshot = await freezeReturnCustomerShippingMoney(shipmentId);
      return c.json({
        data: {
          cShippingRateAmount: snapshot.cShippingRateAmount,
          customerRateSource: snapshot.customerRateSource,
          customerShippingMoneyPolicyVersion: snapshot.customerShippingMoneyPolicyVersion,
        },
      });
    } catch (error) {
      if (error instanceof ReturnCustomerShippingPolicyUnavailableError) {
        return c.json({ error: error.message }, 422);
      }
      throw error;
    }
  },
);

export default app;
