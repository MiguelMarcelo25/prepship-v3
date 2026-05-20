// @ts-nocheck
// Diagnostic: hits UPS OAuth directly with values from query params so the
// user can verify their Client ID / Secret without going through PrepShip's
// save path. Returns UPS's raw response (or fingerprints of what was sent
// if no values supplied). No DB involved, no secrets logged. Remove this
// file once UPS is verified working.
//
// Usage:
//   /api/carriers/ups/probe?clientId=...&clientSecret=...
//   /api/carriers/ups/probe?clientId=&clientSecret=    (just shows it's alive)

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
      message: 'Provide ?clientId=<id>&clientSecret=<secret> in URL to probe UPS OAuth directly.',
    });
    return;
  }
  try {
    const basic = Buffer.from(`${clientId}:${clientSecret}`).toString('base64');
    const upsRes = await fetch('https://onlinetools.ups.com/security/v1/oauth/token', {
      method: 'POST',
      headers: {
        Authorization: `Basic ${basic}`,
        'Content-Type': 'application/x-www-form-urlencoded',
        Accept: 'application/json',
      },
      body: 'grant_type=client_credentials',
    });
    const upsBody = await upsRes.text();
    res.status(200).json({
      ok: upsRes.ok,
      ups_status: upsRes.status,
      ups_body: upsBody.slice(0, 800),
      sent: {
        clientId_length: clientId.length,
        clientId_first6: clientId.slice(0, 6),
        clientId_last4: clientId.slice(-4),
        clientSecret_length: clientSecret.length,
        // Detect whitespace anywhere in the values — dead-give-away of
        // bad copy-paste.
        clientId_has_whitespace: /\s/.test(clientId),
        clientSecret_has_whitespace: /\s/.test(clientSecret),
      },
    });
  } catch (err) {
    sendInternalServerError(res, 'carriers/ups/probe', err);
  }
}
