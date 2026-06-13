import { Hono } from 'hono';
import carrierAccountsHandler from '../lib/imported-handlers/carrier-accounts';
import { runNodeHandler } from '../lib/node-handler';
import { requireCredentialAccountPermission } from '../middleware/auth';
// PS-234: audit credential mutations. The handler is an imported Node-style
// handler (PS-200 decommission territory), so we audit POST-HOC at the route
// level on a successful mutating request — never the raw secret, only the action.
import { recordAuditEvent, auditActorFromContext } from '../services/audit-log';

const app = new Hono();

const runCarrierAccounts = runNodeHandler(carrierAccountsHandler);
const MUTATING_METHODS = new Set(['POST', 'PATCH', 'PUT', 'DELETE']);

app.all('/', requireCredentialAccountPermission, async (c) => {
  const method = c.req.method.toUpperCase();
  const res = await runCarrierAccounts(c);
  if (MUTATING_METHODS.has(method) && res.status < 400) {
    await recordAuditEvent({
      ...auditActorFromContext(c),
      eventType: 'credential',
      resourceType: 'carrier_account',
      action: method,
      details: { method, status: res.status },
    });
  }
  return res;
});

export default app;
