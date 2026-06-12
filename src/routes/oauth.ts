import { Hono } from 'hono';
import ebayOauthCallbackHandler from '../lib/imported-handlers/ebay-oauth-callback';
import { runNodeHandler } from '../lib/node-handler';

// PS-200 S4 — eBay OAuth user-consent callback on the v4 stack.
//
// UNAUTHENTICATED BY DESIGN (mounted before the JWT block, like /webhooks):
// the seller's browser arrives here via redirect from eBay's domain and
// carries no Supabase session. Anti-abuse is the eBay-issued authorization
// code itself — single-use and bound to the App ID + Cert ID already stored
// in store_accounts; without a matching keyset the exchange fails.
//
// Cutover: eBay's token exchange uses the RuName (an eBay-side indirection),
// so flipping the RuName record's "auth accepted URL" to this deployment on
// the eBay developer portal is the ONLY remaining step; the legacy Vercel
// callback stays live until PS-200 S8.
const app = new Hono();

app.all('/ebay/callback', runNodeHandler(ebayOauthCallbackHandler));

export default app;
