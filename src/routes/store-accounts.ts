import { Hono } from 'hono';
import storeAccountsHandler from '../lib/imported-handlers/store-accounts';
import { runNodeHandler } from '../lib/node-handler';
import { requireCredentialAccountPermission } from '../middleware/auth';
// PS-234: audit credential mutations (post-hoc at the route level — the handler is
// an imported Node-style handler; we never log the raw secret, only the action).
import { recordAuditEvent, auditActorFromContext } from '../services/audit-log';

const app = new Hono();

const runStoreAccounts = runNodeHandler(storeAccountsHandler);
const MUTATING_METHODS = new Set(['POST', 'PATCH', 'PUT', 'DELETE']);

app.all('/', requireCredentialAccountPermission, async (c) => {
  const method = c.req.method.toUpperCase();
  const res = await runStoreAccounts(c);
  if (MUTATING_METHODS.has(method) && res.status < 400) {
    await recordAuditEvent({
      ...auditActorFromContext(c),
      eventType: 'credential',
      resourceType: 'store_account',
      action: method,
      details: { method, status: res.status },
    });
  }
  return res;
});

export default app;
