// @ts-nocheck
// PS-200 S4: v4 mirror of the legacy Vercel eBay OAuth callback — body kept
// verbatim (replacement-first); only the import path differs. eBay's token
// exchange uses the RuName (an eBay-side indirection), so this code is
// domain-agnostic: pointing the RuName record's "auth accepted URL" at the
// Render deployment is the ONLY cutover step (one field on the eBay dev
// portal); the legacy Vercel callback stays live until S8.
//
// This is what eBay redirects to after a seller signs in and clicks
// "Agree and Continue" on the consent screen. eBay appends the
// authorization code as a query parameter; we exchange it for an
// access_token + refresh_token via /identity/v1/oauth2/token, then
// auto-update the seller's most-recent eBay row in store_accounts so
// they don't have to manually copy the refresh token.
//
// The function self-completes the OAuth flow:
//   1. Read ?code from query string.
//   2. Look up the most-recent active eBay row in store_accounts to get
//      App ID + Cert ID.
//   3. POST to eBay's token endpoint with the auth code.
//   4. UPDATE the row's credentials JSONB to include the new refresh_token.
//   5. Render a result HTML page so the user knows it worked.
//
// No Supabase JWT required — this endpoint is reached via redirect from
// eBay's domain, so the seller doesn't have a session header. Anti-abuse
// protection is the eBay-issued auth code itself, which is single-use
// and tied to a specific App ID + Cert ID; without those matching values
// already in our store_accounts table the exchange will fail.

import postgres from 'postgres';
import { exchangeEbayAuthorizationCode } from '../../connectors/store/ebay';

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c] as string));
}

function htmlPage(title: string, body: string): string {
  return `<!DOCTYPE html><html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)} — PrepShip × eBay</title>
<style>
body { font-family: -apple-system, system-ui, sans-serif; max-width: 720px; margin: 60px auto; padding: 0 24px; color: #1a1a1a; line-height: 1.55; }
h1 { font-size: 22px; margin: 0 0 16px; }
p { margin: 0 0 14px; }
.success { color: #1a5c29; }
.error { color: #b00020; }
.box { background: #f5f5f7; border: 1px solid #e0e0e0; border-radius: 8px; padding: 16px 20px; margin: 16px 0; font-size: 13px; }
code { background: #eaeaea; padding: 1px 6px; border-radius: 3px; font-size: 12px; }
.cta { display: inline-block; margin-top: 16px; padding: 10px 20px; background: #0f766e; color: #fff; border-radius: 6px; text-decoration: none; font-weight: 600; }
.muted { color: #666; font-size: 12px; }
</style></head><body>${body}</body></html>`;
}

export default async function handler(req: any, res: any): Promise<void> {
  const url = new URL(req.url ?? '/', `https://${req.headers?.host ?? 'localhost'}`);
  const code = url.searchParams.get('code');
  const errorParam = url.searchParams.get('error');
  const errorDescription = url.searchParams.get('error_description');

  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');

  if (errorParam) {
    res.status(200).end(htmlPage(
      'Sign-in declined',
      `<h1 class="error">Sign-in was not completed</h1>
       <p>eBay returned: <code>${escapeHtml(errorParam)}</code> — ${escapeHtml(errorDescription ?? '')}</p>
       <p>Close this tab and try again from PrepShip Settings.</p>`,
    ));
    return;
  }

  if (!code) {
    res.status(400).end(htmlPage(
      'Missing code',
      `<h1 class="error">No authorization code in the URL</h1>
       <p>This page is only meaningful when reached via redirect from eBay's
          consent flow. If you reached it manually, click Test Sign-In on the
          eBay developer portal again.</p>`,
    ));
    return;
  }

  const dbUrl = process.env.DATABASE_URL;
  if (!dbUrl) {
    res.status(500).end(htmlPage(
      'Server misconfigured',
      `<h1 class="error">DATABASE_URL is not set</h1>
       <p>The PrepShip backend can't look up the eBay credentials needed to
          complete the OAuth exchange.</p>`,
    ));
    return;
  }

  const sql = postgres(dbUrl, { max: 1, prepare: false, idle_timeout: 5, connect_timeout: 5 });
  try {
    // The most-recent eBay row supplies App ID + Cert ID. We trust this
    // because there's no other way for an attacker to pre-populate
    // valid eBay credentials in the seller's PrepShip database.
    const rows = await sql<Array<{ id: number; credentials: any }>>`
      SELECT id, credentials FROM store_accounts
      WHERE provider = 'ebay' AND active = true
      ORDER BY id DESC
      LIMIT 1
    `;
    if (rows.length === 0) {
      res.status(404).end(htmlPage(
        'No eBay store yet',
        `<h1 class="error">No eBay credentials found in PrepShip</h1>
         <p>You need to add the App ID, Cert ID, and Dev ID to PrepShip first
            so the callback knows which seller is signing in.</p>
         <p><a class="cta" href="/">Open PrepShip Settings</a></p>`,
      ));
      return;
    }
    const row = rows[0];
    const creds = (row.credentials && typeof row.credentials === 'object'
      ? row.credentials
      : {}) as Record<string, unknown>;
    const appId = String(creds?.appId ?? '').trim();
    const certId = String(creds?.certId ?? '').trim();
    if (!appId || !certId) {
      res.status(400).end(htmlPage(
        'Missing App ID / Cert ID',
        `<h1 class="error">Saved eBay row is missing App ID or Cert ID</h1>
         <p>Open PrepShip Settings → Your Stores → eBay → Delete and re-add,
            making sure all four fields are filled in.</p>`,
      ));
      return;
    }
    // eBay's OAuth exchange wants redirect_uri to be the RuName, not the
    // callback URL. The RuName itself points eBay to our accept/decline URLs.
    const redirectUri = String(
      creds?.ruName ??
      creds?.runame ??
      process.env.EBAY_PRODUCTION_RUNAME ??
      process.env.EBAY_RUNAME ??
      'DrprepperUSA-Drpreppe-Prepsh-qoumohks'
    ).trim();
    if (!redirectUri) {
      res.status(400).end(htmlPage(
        'Missing eBay RuName',
        `<h1 class="error">Saved eBay row is missing the RuName</h1>
         <p>Open eBay Developer Portal -> User Tokens and copy the value under
            <strong>RuName (eBay Redirect URL name)</strong>, then save it in
            PrepShip Settings on the eBay store row.</p>`,
      ));
      return;
    }

    let tokenData: { accessToken?: string; refreshToken?: string; expiresIn?: number; tokenUrl: string };
    try {
      tokenData = await exchangeEbayAuthorizationCode({
        credentials: creds,
        code,
        redirectUri,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      res.status(200).end(htmlPage(
        'Token exchange failed',
        `<h1 class="error">eBay rejected the authorization code</h1>
         <p><code>${escapeHtml(message)}</code></p>
         <p>Common causes: the App ID / Cert ID saved in PrepShip don't match the
            keyset used to start the sign-in, or this RuName doesn't match
            the keyset used by the consent page.</p>
         <div class="box">
           <strong>What I tried:</strong><br>
           <code>POST eBay OAuth token endpoint</code><br>
           <code>App ID: ${escapeHtml(appId.slice(0, 24))}…</code><br>
           <code>redirect_uri/RuName: ${escapeHtml(redirectUri)}</code>
         </div>`,
      ));
      return;
    }
    const refreshToken = tokenData?.refreshToken;
    if (!refreshToken) {
      res.status(200).end(htmlPage(
        'No refresh token returned',
        `<h1 class="error">eBay returned an access token but no refresh token</h1>
         <p>This usually means the keyset is configured for short-lived auth
            ("Auth'n'Auth" instead of OAuth). On the eBay developer portal →
            User Tokens, click the <strong>OAuth</strong> radio button, save,
            then click Test Sign-In again.</p>`,
      ));
      return;
    }

    // Update the saved row with the new refresh token. JSONB merge so
    // we don't overwrite App ID / Cert ID / Dev ID / partner ID etc.
    const newCreds = { ...creds, refreshToken };
    await sql`
      UPDATE store_accounts
      SET credentials = ${newCreds},
          updated_at = NOW()
      WHERE id = ${row.id}
    `;

    const expiresIn = Number(tokenData?.expiresIn ?? 0);
    res.status(200).end(htmlPage(
      'eBay connected',
      `<h1 class="success">✅ eBay connected to PrepShip</h1>
       <p>Authorization code exchanged. The User Refresh Token has been saved
          to your eBay store row in PrepShip — you don't need to copy it manually.</p>
       <div class="box">
         <strong>Saved automatically:</strong><br>
         <code>refresh_token (${refreshToken.length} chars, valid ~18 months)</code><br>
         <span class="muted">access token expires in ${expiresIn} seconds (~${Math.round(expiresIn/3600)} hr) — but refresh token regenerates one when needed.</span>
       </div>
       <p>Close this tab and go back to PrepShip Settings. <strong>Test Connection</strong>
          on the eBay row should now return ✅.</p>
       <p><a class="cta" href="https://prepshipv4.vercel.app/">Open PrepShip</a></p>`,
    ));
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error('[oauth/ebay/callback]', msg);
    res.status(500).end(htmlPage(
      'Unexpected error',
      `<h1 class="error">Something went wrong</h1>
       <p>${escapeHtml(msg)}</p>`,
    ));
  } finally {
    try { await sql.end({ timeout: 1 }); } catch { /* ignore */ }
  }
}
