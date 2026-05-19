import { Hono } from 'hono';
import carrierAccountsHandler from '../lib/imported-handlers/carrier-accounts';
import { runNodeHandler } from '../lib/node-handler';
import { requireCredentialAccountPermission } from '../middleware/auth';

const app = new Hono();

app.all('/', requireCredentialAccountPermission, runNodeHandler(carrierAccountsHandler));

export default app;
