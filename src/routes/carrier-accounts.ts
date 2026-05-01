import { Hono } from 'hono';
import carrierAccountsHandler from '../lib/imported-handlers/carrier-accounts';
import { runNodeHandler } from '../lib/node-handler';

const app = new Hono();

app.all('/', runNodeHandler(carrierAccountsHandler));

export default app;
