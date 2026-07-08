import { Hono } from 'hono';
import type { Context } from 'hono';
import {
  isPortalSession,
  type AuthVars,
} from '../../middleware/auth';
import { validateShopifyCredentials } from '../../connectors/store/shopify';
import {
  PortalShopifyIntegrationError,
  submitPortalShopifyIntegration,
} from '../../services/portal-shopify-integrations';

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

export default app;
