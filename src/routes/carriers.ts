import { Hono } from 'hono';
import verifyCarrierHandler from '../lib/imported-handlers/carriers-verify';
import { runNodeHandler } from '../lib/node-handler';
import { requirePermission } from '../middleware/auth';

const app = new Hono();

app.all('/verify', requirePermission('credentials:write'), runNodeHandler(verifyCarrierHandler));

export default app;
