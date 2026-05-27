// @ts-nocheck
// Diagnostic: verifies UPS OAuth credentials through the UPS CarrierConnector.
// Returns UPS's raw response snippet and safe fingerprints of what was sent.
// No DB involved, no secrets logged. Remove this file once UPS is verified
// working.
//
// Usage:
//   /api/carriers/ups/probe?clientId=...&clientSecret=...
//   /api/carriers/ups/probe?clientId=&clientSecret=    (just shows it's alive)

import { probeUpsCredentials } from '../../../src/connectors/carrier/ups.js';
import { sendInternalServerError } from '../../_lib/safe-error.js';

export default async function handler(req: any, res: any): Promise<void> {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'application/json');
  const url = new URL(req.url ?? '/', `https://${req.headers?.host ?? 'localhost'}`);
  const clientId = (url.searchParams.get('clientId') ?? '').trim();
  const clientSecret = (url.searchParams.get('clientSecret') ?? '').trim();
  if (!clientId || !clientSecret) {
    res.status(200).json({
      ok: false,
      message: 'Provide ?clientId=<id>&clientSecret=<secret> in URL to probe UPS OAuth through the carrier connector.',
    });
    return;
  }
  try {
    const result = await probeUpsCredentials({ clientId, clientSecret });
    res.status(200).json(result);
  } catch (err) {
    sendInternalServerError(res, 'carriers/ups/probe', err);
  }
}
