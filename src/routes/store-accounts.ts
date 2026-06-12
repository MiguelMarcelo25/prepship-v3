import { Hono } from 'hono';
import storeAccountsHandler from '../lib/imported-handlers/store-accounts';
import { runNodeHandler } from '../lib/node-handler';
import { requireCredentialAccountPermission } from '../middleware/auth';

const app = new Hono();

app.all('/', requireCredentialAccountPermission, runNodeHandler(storeAccountsHandler));

export default app;
