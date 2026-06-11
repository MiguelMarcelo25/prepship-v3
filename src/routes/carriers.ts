import { Hono } from 'hono';
import verifyCarrierHandler from '../lib/imported-handlers/carriers-verify';
import { runNodeHandler } from '../lib/node-handler';
import { requirePermission } from '../middleware/auth';
import { fullServiceCatalog } from '../lib/carrier-service-catalog';

const app = new Hono();

app.all('/verify', requirePermission('credentials:write'), runNodeHandler(verifyCarrierHandler));

// PS-189: account→service availability is backend-owned. The FE service picker
// reads this catalog instead of keeping its own CARRIER_SERVICES copy (which
// also auto-defaulted usps_media_mail — a restricted service — on account
// switch). Static, read-only.
app.get('/service-catalog', (c) => c.json({ catalog: fullServiceCatalog() }));

export default app;
