// @ts-nocheck
// Vercel serverless function: verify carrier credentials.
// All provider implementations are inlined to avoid Vercel's bundler
// missing nested imports. When the same code lands on the Render backend
// it can re-import from src/lib/carriers/* (the canonical home).
//
// Two call shapes:
//   POST { carrierAccountId: number }   — load creds from carrier_accounts row
//   POST { provider, credentials }      — verify ad-hoc creds without saving
//
// Auth: Supabase JWT in Authorization: Bearer <token>.
//
// ─────────────────────────────────────────────────────────────────────────────
// HOW TO ADD A NEW CARRIER
// ─────────────────────────────────────────────────────────────────────────────
// Adding "FOO" carrier is four mechanical edits:
//
//   1. This file — extend the ProviderType union below with 'foo' and write a
//      verifyFoo function (model after verifyShipEngine for API-key auth or
//      verifyUps for OAuth client_credentials), then register it in the
//      VERIFIERS map. If FOO can't be implemented yet, put a note in
//      STUBBED_NOTES and skip the verifier — the dispatcher falls through to
//      a clean "not yet implemented" response.
//
//   2. web/src/components/Settings/CarrierIntegrationsCard.tsx — add 'foo' to
//      the ProviderKey union and append a ProviderDef entry to PROVIDER_DEFS
//      with badge, badgeColor, domain, simpleIconsSlug (if available), and the
//      credential fields the carrier requires.
//
//   3. (Optional) src/lib/carriers/foo.ts — the canonical Render-side impl.
//      Keep this in sync with the inlined verifyFoo in this file. The
//      inlining exists only because Vercel's bundler choked on cross-tree
//      imports; the src/lib version is what the eventual Render backend uses.
//
//   4. No DB migration needed — carrier_accounts is provider-agnostic JSONB.
//      The existing unique index (client_id, provider, account_identifier)
//      handles dedup automatically.
//
// After deploy, the new tile shows up in the Add Carrier modal, the verify
// button works, and there are no other call sites to update.

import postgres from 'postgres';
import {
  extractBearerToken,
  verifySupabaseJwt,
} from '../../lib/auth/verify-supabase-jwt.js';
import { corsHeaders } from '../../lib/http/cors.js';
import { sendInternalServerError } from '../../lib/safe-error.js';
// PS-251 (Card 6): block SSRF via caller-supplied carrier apiBase/swsimEndpoint URLs.
import { assertPublicHttpUrl } from '../../lib/ssrf-guard.js';

type ProviderType =
  | 'simulator'
  | 'shipstation'
  | 'shipengine'
  | 'ehub'
  | 'ups'
  | 'usps'
  | 'fedex'
  | 'dhl_express'
  | 'amazon_shipping'
  | 'walmart'
  | 'walmart_shipping'
  | 'ebay'
  | 'ebay_shipping'
  | 'seko'
  | 'epost_global'
  | 'intelliquick'
  | 'gls'
  | 'stamps_com'
  | 'endicia'
  | 'easypost'
  | 'shipp';

interface VerifyResult {
  ok: boolean;
  accountIdentifier?: string;
  accountLabel?: string;
  meta?: Record<string, unknown>;
  error?: string;
}

type Verifier = (creds: Record<string, unknown>) => Promise<VerifyResult>;

// ───────── Simulator (sandbox / no real auth) ─────────
// Always passes — exists so users can prove the add-carrier → save →
// verify → fetch-rates pipeline works end-to-end without needing real
// carrier API credentials. Paired with /api/carriers/simulator/rates,
// which returns synthetic rate quotes.
const verifySimulator: Verifier = async (creds) => {
  const label = String(creds?.label ?? 'Simulator').trim() || 'Simulator';
  return {
    ok: true,
    accountIdentifier: `sim-${Date.now().toString(36)}`,
    accountLabel: `Demo: ${label}`,
    meta: { mode: 'simulation', note: 'No real API call was made.' },
  };
};

// ───────── EasyPost (single API key, multi-carrier aggregator) ─────────
// Auth: HTTP Basic with the API key as username, empty password (the
// trailing colon matters — without it, EasyPost returns 401).
// Verify with a harmless shipments list ping. EasyPost's documented User
// endpoint is /users/:id, so /users/me returns "expected a user ID" even for a
// valid API key. Listing shipments validates auth for both test and production
// keys without creating postage or requiring a production-only Users API call.
const verifyEasyPost: Verifier = async (creds) => {
  const apiKey = String(creds?.apiKey ?? '').trim();
  if (!apiKey) return { ok: false, error: 'apiKey is required' };
  try {
    const basic = Buffer.from(`${apiKey}:`).toString('base64');
    const res = await fetch('https://api.easypost.com/v2/shipments?page_size=1', {
      headers: { Authorization: `Basic ${basic}`, Accept: 'application/json' },
    });
    if (!res.ok) {
      const t = await res.text().then((s) => s.slice(0, 200)).catch(() => '');
      return { ok: false, error: `EasyPost ${res.status}: ${t || res.statusText}` };
    }
    const data = (await res.json()) as { shipments?: unknown[]; has_more?: boolean };
    const mode = apiKey.startsWith('EZTK') ? 'test' : 'production';
    return {
      ok: true,
      accountIdentifier: `${mode}:${apiKey.slice(0, 8)}`,
      accountLabel: `EasyPost (${mode})`,
      meta: {
        mode,
        shipmentListReachable: true,
        sampleCount: Array.isArray(data.shipments) ? data.shipments.length : null,
        hasMore: data.has_more ?? null,
      },
    };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
};

// Shipp.to (private API docs at /api-docs.html). The API requires the
// saved x-api-key plus a Supabase email/password login; successful login
// sets the session cookie used by quote/label endpoints.
const verifyShipp: Verifier = async (creds) => {
  const apiKey = String(creds?.apiKey ?? '').trim();
  const email = String(creds?.email ?? '').trim();
  const password = String(creds?.password ?? '').trim();
  if (!apiKey || !email || !password) {
    return { ok: false, error: 'apiKey, email, and password are required' };
  }

  try {
    const res = await fetch('https://shipp.to/api/supabase/login', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        'x-api-key': apiKey,
      },
      body: JSON.stringify({ email, password }),
    });
    const text = await res.text().catch(() => '');
    let data: any = null;
    try { data = text ? JSON.parse(text) : null; } catch { /* keep text fallback */ }
    if (!res.ok) {
      return { ok: false, error: `Shipp login ${res.status}: ${text.slice(0, 300) || res.statusText}` };
    }

    const userId = data?.user?.id ? String(data.user.id) : null;
    const role = data?.profile?.role ? String(data.profile.role) : null;
    return {
      ok: true,
      accountIdentifier: userId ?? email,
      accountLabel: `Shipp ${email}`,
      meta: {
        userId,
        role,
        hasStripeCustomer: Boolean(data?.profile?.stripe_customer_id),
      },
    };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
};

// ───────── ShipEngine (single API key) ─────────
const verifyShipEngine: Verifier = async (creds) => {
  const apiKey = String(creds?.apiKey ?? '').trim();
  if (!apiKey) return { ok: false, error: 'apiKey is required' };
  try {
    const res = await fetch('https://api.shipengine.com/v1/carriers', {
      headers: { 'API-Key': apiKey, Accept: 'application/json' },
    });
    if (!res.ok) {
      const t = await res.text().then((s) => s.slice(0, 200)).catch(() => '');
      return { ok: false, error: `ShipEngine ${res.status}: ${t || res.statusText}` };
    }
    const data = (await res.json()) as { carriers?: unknown[] };
    const count = Array.isArray(data?.carriers) ? data.carriers.length : 0;
    return {
      ok: true,
      accountIdentifier: apiKey.slice(0, 12),
      accountLabel: `ShipEngine (${count} carrier${count === 1 ? '' : 's'})`,
      meta: { carriersCount: count },
    };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
};

// ───────── UPS (OAuth 2.0 client_credentials) ─────────
// eHub: credential capture is ready, but we need the account's private API
// docs/API Explorer details before making a live verification call.
const verifyEhub: Verifier = async (creds) => {
  const apiKey = String(creds?.apiKey ?? '').trim();
  const baseUrl = String(creds?.baseUrl ?? '').trim();
  if (!apiKey) return { ok: false, error: 'apiKey is required' };
  return {
    ok: false,
    accountIdentifier: baseUrl ? baseUrl.replace(/^https?:\/\//, '').replace(/\/+$/, '') : 'ehub',
    accountLabel: 'eHub',
    error: 'eHub credentials are saved, but live verification needs the exact API base URL plus the verification/rates endpoint contract from eHub docs/API Explorer.',
    meta: {
      hasApiKey: true,
      hasBaseUrl: Boolean(baseUrl),
      nextStep: 'Open eHub docs/API Explorer with the account token and confirm the base URL, auth header format, and rate endpoint path.',
    },
  };
};

const verifyUps: Verifier = async (creds) => {
  const accountNumber = String(creds?.accountNumber ?? '').trim();
  const clientId = String(creds?.clientId ?? '').trim();
  const clientSecret = String(creds?.clientSecret ?? '').trim();
  if (!accountNumber || !clientId || !clientSecret) {
    return { ok: false, error: 'accountNumber, clientId, clientSecret are required' };
  }
  try {
    const basic = Buffer.from(`${clientId}:${clientSecret}`).toString('base64');
    const res = await fetch('https://onlinetools.ups.com/security/v1/oauth/token', {
      method: 'POST',
      headers: {
        Authorization: `Basic ${basic}`,
        'Content-Type': 'application/x-www-form-urlencoded',
        Accept: 'application/json',
      },
      body: 'grant_type=client_credentials',
    });
    if (!res.ok) {
      const t = await res.text().then((s) => s.slice(0, 200)).catch(() => '');
      return { ok: false, error: `UPS OAuth ${res.status}: ${t || res.statusText}` };
    }
    const data = (await res.json()) as { access_token?: string; expires_in?: string };
    if (!data?.access_token) return { ok: false, error: 'UPS OAuth response missing access_token' };
    return {
      ok: true,
      accountIdentifier: accountNumber,
      accountLabel: `UPS ${accountNumber}`,
      meta: { tokenExpiresIn: data.expires_in ?? null },
    };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
};

// ───────── FedEx (OAuth 2.0 client_credentials) ─────────
const verifyFedEx: Verifier = async (creds) => {
  const accountNumber = String(creds?.accountNumber ?? '').trim();
  const apiKey = String(creds?.apiKey ?? '').trim();
  const apiSecret = String(creds?.apiSecret ?? '').trim();
  if (!accountNumber || !apiKey || !apiSecret) {
    return { ok: false, error: 'accountNumber, apiKey, apiSecret are required' };
  }
  const useSandbox = String(creds?.sandbox ?? '').toLowerCase() === 'true';
  const url = useSandbox ? 'https://apis-sandbox.fedex.com/oauth/token' : 'https://apis.fedex.com/oauth/token';
  const body = new URLSearchParams({
    grant_type: 'client_credentials',
    client_id: apiKey,
    client_secret: apiSecret,
  });
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Accept: 'application/json',
      },
      body: body.toString(),
    });
    if (!res.ok) {
      const t = await res.text().then((s) => s.slice(0, 200)).catch(() => '');
      return { ok: false, error: `FedEx OAuth ${res.status}: ${t || res.statusText}` };
    }
    const data = (await res.json()) as { access_token?: string; expires_in?: number; scope?: string };
    if (!data?.access_token) return { ok: false, error: 'FedEx OAuth response missing access_token' };
    return {
      ok: true,
      accountIdentifier: accountNumber,
      accountLabel: `FedEx ${accountNumber}${useSandbox ? ' (sandbox)' : ''}`,
      meta: { scope: data.scope ?? null, tokenExpiresIn: data.expires_in ?? null, sandbox: useSandbox },
    };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
};

// ───────── DHL Express (HTTP Basic) ─────────
const verifyDhlExpress: Verifier = async (creds) => {
  const accountNumber = String(creds?.accountNumber ?? '').trim();
  const apiKey = String(creds?.apiKey ?? '').trim();
  const apiSecret = String(creds?.apiSecret ?? '').trim();
  if (!accountNumber || !apiKey || !apiSecret) {
    return { ok: false, error: 'accountNumber, apiKey, apiSecret are required' };
  }
  const useSandbox = String(creds?.sandbox ?? '').toLowerCase() === 'true';
  const host = useSandbox
    ? 'https://express.api.dhl.com/mydhlapi/test'
    : 'https://express.api.dhl.com/mydhlapi';
  const basic = Buffer.from(`${apiKey}:${apiSecret}`).toString('base64');
  try {
    const res = await fetch(`${host}/address-validate?type=delivery&countryCode=US&postalCode=10001`, {
      headers: { Authorization: `Basic ${basic}`, Accept: 'application/json' },
    });
    if (res.status === 401 || res.status === 403) {
      const t = await res.text().then((s) => s.slice(0, 200)).catch(() => '');
      return { ok: false, error: `DHL ${res.status}: ${t || 'invalid credentials'}` };
    }
    if (res.status >= 500) return { ok: false, error: `DHL ${res.status}: upstream error, retry later` };
    return {
      ok: true,
      accountIdentifier: accountNumber,
      accountLabel: `DHL ${accountNumber}${useSandbox ? ' (sandbox)' : ''}`,
      meta: { sandbox: useSandbox, probeStatus: res.status },
    };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
};

// ───────── USPS APIs v3 (OAuth 2.0 client_credentials) ─────────
const verifyUsps: Verifier = async (creds) => {
  const crid = String(creds?.crid ?? '').trim();
  const mid = String(creds?.mid ?? '').trim();
  const consumerKey = String(creds?.consumerKey ?? '').trim();
  const consumerSecret = String(creds?.consumerSecret ?? '').trim();
  if (!crid || !consumerKey || !consumerSecret) {
    return { ok: false, error: 'crid, consumerKey, consumerSecret are required' };
  }
  const body = new URLSearchParams({
    grant_type: 'client_credentials',
    client_id: consumerKey,
    client_secret: consumerSecret,
    scope: 'prices labels addresses tracking',
  });
  try {
    const res = await fetch('https://apis.usps.com/oauth2/v3/token', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Accept: 'application/json',
      },
      body: body.toString(),
    });
    if (!res.ok) {
      const t = await res.text().then((s) => s.slice(0, 200)).catch(() => '');
      return { ok: false, error: `USPS OAuth ${res.status}: ${t || res.statusText}` };
    }
    const data = (await res.json()) as { access_token?: string; expires_in?: number };
    if (!data?.access_token) return { ok: false, error: 'USPS OAuth response missing access_token' };
    return {
      ok: true,
      accountIdentifier: crid,
      accountLabel: `USPS CRID ${crid}${mid ? ` / MID ${mid}` : ''}`,
      meta: { tokenExpiresIn: data.expires_in ?? null, mid: mid || null },
    };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
};

// ───────── Amazon Shipping (SP-API Buy Shipping via LWA OAuth) ─────────
//   LWA token endpoint: POST https://api.amazon.com/auth/o2/token
//   Body: grant_type=refresh_token, refresh_token, client_id, client_secret
//   Successful refresh proves the LWA app + refresh token are valid; the
//   seller/marketplace ids are echoed back as identification.
const verifyAmazonShipping: Verifier = async (creds) => {
  const sellerId = String(creds?.sellerId ?? '').trim();
  const marketplaceId = String(creds?.marketplaceId ?? '').trim();
  const lwaClientId = String(creds?.lwaClientId ?? '').trim();
  const lwaClientSecret = String(creds?.lwaClientSecret ?? '').trim();
  const refreshToken = String(creds?.refreshToken ?? '').trim();
  if (!sellerId || !marketplaceId || !lwaClientId || !lwaClientSecret || !refreshToken) {
    return { ok: false, error: 'sellerId, marketplaceId, lwaClientId, lwaClientSecret, refreshToken are required' };
  }
  try {
    const body = new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
      client_id: lwaClientId,
      client_secret: lwaClientSecret,
    });
    const res = await fetch('https://api.amazon.com/auth/o2/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
      body: body.toString(),
    });
    if (!res.ok) {
      const t = await res.text().then((s) => s.slice(0, 200)).catch(() => '');
      return { ok: false, error: `Amazon LWA ${res.status}: ${t || res.statusText}` };
    }
    const data = (await res.json()) as { access_token?: string; expires_in?: number; token_type?: string };
    if (!data?.access_token) return { ok: false, error: 'Amazon LWA response missing access_token' };
    return {
      ok: true,
      accountIdentifier: sellerId,
      accountLabel: `Amazon Seller ${sellerId}`,
      meta: { marketplaceId, tokenExpiresIn: data.expires_in ?? null, tokenType: data.token_type ?? null },
    };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
};

// ───────── Walmart Marketplace (OAuth 2.0 client_credentials) ─────────
//   Token endpoint: POST https://marketplace.walmartapis.com/v3/token
//   Auth header:    Authorization: Basic base64(clientId:clientSecret)
//   Required:       WM_QOS.CORRELATION_ID, WM_SVC.NAME, Accept
//   Body:           grant_type=client_credentials
// Successful token issuance proves the Marketplace API client + secret are
// valid; partnerId (Seller ID) is echoed back as the natural account key.
const verifyWalmart: Verifier = async (creds) => {
  const clientId = String(creds?.clientId ?? '').trim();
  const clientSecret = String(creds?.clientSecret ?? '').trim();
  if (!clientId || !clientSecret) {
    return { ok: false, error: 'clientId and clientSecret are required' };
  }
  // Optional fields — Walmart's token endpoint accepts a client_credentials
  // grant on the basis of the Client ID + Secret alone. Partner ID and
  // Channel Type are headers used on subsequent API calls (rates, orders).
  const partnerId = String(creds?.partnerId ?? creds?.sellerId ?? '').trim();
  const channelType = String(creds?.channelType ?? '').trim();
  try {
    const basic = Buffer.from(`${clientId}:${clientSecret}`).toString('base64');
    const correlationId = `prepship-${Date.now().toString(36)}`;
    const headers: Record<string, string> = {
      Authorization: `Basic ${basic}`,
      'Content-Type': 'application/x-www-form-urlencoded',
      Accept: 'application/json',
      'WM_QOS.CORRELATION_ID': correlationId,
      'WM_SVC.NAME': 'Walmart Marketplace',
    };
    if (channelType) headers['WM_CONSUMER.CHANNEL.TYPE'] = channelType;
    const res = await fetch('https://marketplace.walmartapis.com/v3/token', {
      method: 'POST',
      headers,
      body: 'grant_type=client_credentials',
    });
    if (!res.ok) {
      const t = await res.text().then((s) => s.slice(0, 200)).catch(() => '');
      return { ok: false, error: `Walmart OAuth ${res.status}: ${t || res.statusText}` };
    }
    const data = (await res.json()) as { access_token?: string; expires_in?: number; token_type?: string };
    if (!data?.access_token) return { ok: false, error: 'Walmart OAuth response missing access_token' };
    // Use partnerId when supplied; otherwise fall back to a stable surrogate
    // derived from the Client ID so the row still gets a unique natural key.
    const identifier = partnerId || `cid:${clientId.slice(0, 12)}`;
    const label = partnerId ? `Walmart Seller ${partnerId}` : `Walmart (${clientId.slice(0, 12)}…)`;
    return {
      ok: true,
      accountIdentifier: identifier,
      accountLabel: label,
      meta: {
        tokenExpiresIn: data.expires_in ?? null,
        tokenType: data.token_type ?? null,
        channelType: channelType || null,
        partnerId: partnerId || null,
      },
    };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
};

// ───────── SEKO Ecommerce (Bearer token) ─────────
// SEKO OmniShip / Hybrid API uses Bearer token in the Authorization header.
// Verification endpoint URL varies by tenant; the configured base host comes
// from creds.apiBase if supplied, otherwise the published default.
const verifySeko: Verifier = async (creds) => {
  const accountId = String(creds?.accountId ?? '').trim();
  const apiKey = String(creds?.apiKey ?? '').trim();
  const apiBase = String(creds?.apiBase ?? 'https://api.omniship.io').trim().replace(/\/+$/, '');
  if (!accountId || !apiKey) {
    return { ok: false, error: 'accountId and apiKey are required' };
  }
  try {
    // Light authenticated probe — SEKO returns 200 for the carriage-types
    // resource on a valid token, 401 otherwise.
    assertPublicHttpUrl(apiBase, 'SEKO apiBase');
    const res = await fetch(`${apiBase}/api/v1/CarriageTypes`, {
      headers: { Authorization: `Bearer ${apiKey}`, Accept: 'application/json' },
    });
    if (res.status === 401 || res.status === 403) {
      return { ok: false, error: `SEKO ${res.status}: invalid credentials` };
    }
    if (res.status === 404) {
      return { ok: false, error: 'SEKO: probe endpoint not found — set creds.apiBase to your tenant host' };
    }
    if (res.status >= 500) {
      return { ok: false, error: `SEKO ${res.status}: upstream error, retry later` };
    }
    return {
      ok: true,
      accountIdentifier: accountId,
      accountLabel: `SEKO ${accountId}`,
      meta: { apiBase, probeStatus: res.status },
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (/fetch failed|ENOTFOUND|getaddrinfo/i.test(msg)) {
      return { ok: false, error: 'SEKO: default hostname unreachable. Add credentials.apiBase with your tenant URL (provided by SEKO when your account is provisioned).' };
    }
    return { ok: false, error: msg };
  }
};

// ───────── ePost Global (API key) ─────────
// ePost Global exposes an API-key auth via x-api-key header. Probe is a
// catalogue endpoint that returns 200 with a valid key and 401 otherwise.
const verifyEpostGlobal: Verifier = async (creds) => {
  const accountId = String(creds?.accountId ?? '').trim();
  const apiKey = String(creds?.apiKey ?? '').trim();
  const apiBase = String(creds?.apiBase ?? 'https://api.epostglobalmail.com').trim().replace(/\/+$/, '');
  if (!accountId || !apiKey) {
    return { ok: false, error: 'accountId and apiKey are required' };
  }
  try {
    assertPublicHttpUrl(apiBase, 'ePost Global apiBase');
    const res = await fetch(`${apiBase}/v1/services?accountId=${encodeURIComponent(accountId)}`, {
      headers: { 'x-api-key': apiKey, Accept: 'application/json' },
    });
    if (res.status === 401 || res.status === 403) {
      return { ok: false, error: `ePost Global ${res.status}: invalid credentials` };
    }
    if (res.status === 404) {
      return { ok: false, error: 'ePost Global: probe endpoint not found — set creds.apiBase to your tenant host' };
    }
    if (res.status >= 500) {
      return { ok: false, error: `ePost Global ${res.status}: upstream error, retry later` };
    }
    return {
      ok: true,
      accountIdentifier: accountId,
      accountLabel: `ePost ${accountId}`,
      meta: { apiBase, probeStatus: res.status },
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (/fetch failed|ENOTFOUND|getaddrinfo/i.test(msg)) {
      return { ok: false, error: 'ePost Global: default hostname unreachable. Add credentials.apiBase with the API host from your ePost account.' };
    }
    return { ok: false, error: msg };
  }
};

// ───────── IntelliQuick (Basic auth) ─────────
// IntelliQuick exposes a REST endpoint with HTTP Basic auth (account #
// as username, API key as password). The exact base host varies by partner
// install — set creds.apiBase to override.
const verifyIntelliquick: Verifier = async (creds) => {
  const accountNumber = String(creds?.accountNumber ?? '').trim();
  const apiKey = String(creds?.apiKey ?? '').trim();
  const apiBase = String(creds?.apiBase ?? 'https://api.intelliquickdelivery.com').trim().replace(/\/+$/, '');
  if (!accountNumber || !apiKey) {
    return { ok: false, error: 'accountNumber and apiKey are required' };
  }
  try {
    const basic = Buffer.from(`${accountNumber}:${apiKey}`).toString('base64');
    assertPublicHttpUrl(apiBase, 'IntelliQuick apiBase');
    const res = await fetch(`${apiBase}/v1/account`, {
      headers: { Authorization: `Basic ${basic}`, Accept: 'application/json' },
    });
    if (res.status === 401 || res.status === 403) {
      return { ok: false, error: `IntelliQuick ${res.status}: invalid credentials` };
    }
    if (res.status === 404) {
      return { ok: false, error: 'IntelliQuick: probe endpoint not found — set creds.apiBase to your install host' };
    }
    if (res.status >= 500) {
      return { ok: false, error: `IntelliQuick ${res.status}: upstream error, retry later` };
    }
    return {
      ok: true,
      accountIdentifier: accountNumber,
      accountLabel: `IntelliQuick ${accountNumber}`,
      meta: { apiBase, probeStatus: res.status },
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (/fetch failed|ENOTFOUND|getaddrinfo/i.test(msg)) {
      return { ok: false, error: 'IntelliQuick: default hostname unreachable. Add credentials.apiBase with the API host from your IntelliQuick install.' };
    }
    return { ok: false, error: msg };
  }
};

// ───────── GLS US (REST login, formerly Golden State Overnight) ─────────
// GLS US uses a token-issuing login endpoint: POST creds → bearer token.
// Successful token issuance proves the username/password are valid.
const verifyGls: Verifier = async (creds) => {
  const customerId = String(creds?.customerId ?? '').trim();
  const username = String(creds?.username ?? '').trim();
  const password = String(creds?.password ?? '').trim();
  const apiBase = String(creds?.apiBase ?? 'https://api.gls-us.com').trim().replace(/\/+$/, '');
  if (!customerId || !username || !password) {
    return { ok: false, error: 'customerId, username, password are required' };
  }
  try {
    assertPublicHttpUrl(apiBase, 'GLS US apiBase');
    const res = await fetch(`${apiBase}/v1/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ customerId, username, password }),
    });
    if (res.status === 401 || res.status === 403) {
      return { ok: false, error: `GLS ${res.status}: invalid credentials` };
    }
    if (res.status === 404) {
      return { ok: false, error: 'GLS: login endpoint not found — set creds.apiBase to your regional host' };
    }
    if (!res.ok) {
      const t = await res.text().then((s) => s.slice(0, 200)).catch(() => '');
      return { ok: false, error: `GLS ${res.status}: ${t || res.statusText}` };
    }
    return {
      ok: true,
      accountIdentifier: customerId,
      accountLabel: `GLS ${customerId}`,
      meta: { apiBase, probeStatus: res.status },
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (/fetch failed|ENOTFOUND|getaddrinfo/i.test(msg)) {
      return { ok: false, error: 'GLS: default hostname unreachable. Add credentials.apiBase with the API host from your GLS portal.' };
    }
    return { ok: false, error: msg };
  }
};

// ───────── Stamps.com (SwsimV1 SOAP AuthenticateUser) ─────────
// Stamps.com SwsimV1 SOAP API. Calling AuthenticateUser with the
// IntegrationID + Username + Password returns an authenticator token on
// success or a SOAP fault on bad creds. The endpoint and namespace are the
// official ones from stamps.com's published WSDL.
const verifyStampsCom: Verifier = async (creds) => {
  const integrationId = String(creds?.integrationId ?? '').trim();
  const username = String(creds?.username ?? '').trim();
  const password = String(creds?.password ?? '').trim();
  if (!integrationId || !username || !password) {
    return { ok: false, error: 'integrationId, username, password are required' };
  }
  // Build a minimal AuthenticateUser SOAP envelope. We escape the credential
  // fields so a literal "<" in a password doesn't break the XML. Stamps.com
  // exposes multiple SwsimV* endpoints; the version override lets the user
  // pin to whichever their account is on. Default below uses v11 — broadly
  // compatible across older stamps.com integration partners.
  const xmlEscape = (s: string) => s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
  const swsimVersion = String(creds?.swsimVersion ?? 'V49').trim();
  const ns = String(
    creds?.swsimNamespace ?? `http://stamps.com/xml/namespace/2017/05/swsim/swsim_v8`,
  );
  const endpoint = String(
    creds?.swsimEndpoint ?? `https://swsim.stamps.com/swsim/swsim${swsimVersion.toLowerCase()}.asmx`,
  );
  const envelope = `<?xml version="1.0" encoding="utf-8"?>
<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/">
  <soap:Body>
    <AuthenticateUser xmlns="${ns}">
      <Credentials>
        <IntegrationID>${xmlEscape(integrationId)}</IntegrationID>
        <Username>${xmlEscape(username)}</Username>
        <Password>${xmlEscape(password)}</Password>
      </Credentials>
    </AuthenticateUser>
  </soap:Body>
</soap:Envelope>`;
  try {
    assertPublicHttpUrl(endpoint, 'Stamps.com swsimEndpoint');
    const res = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'text/xml; charset=utf-8',
        SOAPAction: `"${ns}/AuthenticateUser"`,
      },
      body: envelope,
    });
    const text = await res.text().catch(() => '');
    if (!res.ok || /<faultcode>|<soap:Fault>/i.test(text)) {
      const reason = (/<faultstring>([\s\S]*?)<\/faultstring>/i.exec(text)?.[1] ?? `${res.status} ${res.statusText}`).trim().slice(0, 200);
      return {
        ok: false,
        error: `Stamps.com: ${reason || 'authentication failed'} (override credentials.swsimNamespace / swsimEndpoint if your account uses a different SwsimV version).`,
      };
    }
    return {
      ok: true,
      accountIdentifier: integrationId,
      accountLabel: `Stamps.com ${username}`,
      meta: { integrationId, endpoint, namespace: ns },
    };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
};

// ───────── Endicia (Label Server XML — GetAccountStatus) ─────────
// Endicia Label Server uses an XML POST. GetAccountStatusXML is the
// lightest call that exercises auth — invalid AccountID/PassPhrase returns
// a Status > 0 with an explanatory ErrorMessage.
const verifyEndicia: Verifier = async (creds) => {
  const accountId = String(creds?.accountId ?? '').trim();
  const passPhrase = String(creds?.passPhrase ?? '').trim();
  if (!accountId || !passPhrase) {
    return { ok: false, error: 'accountId and passPhrase are required' };
  }
  const xmlEscape = (s: string) => s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
  const xml = `<AccountStatusRequest>
    <RequesterID>prepship</RequesterID>
    <RequestID>${Date.now()}</RequestID>
    <CertifiedIntermediary>
      <AccountID>${xmlEscape(accountId)}</AccountID>
      <PassPhrase>${xmlEscape(passPhrase)}</PassPhrase>
    </CertifiedIntermediary>
  </AccountStatusRequest>`;
  try {
    const res = await fetch('https://www.envmgr.com/LabelService/EwsLabelService.asmx/GetAccountStatusXML', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: `accountStatusRequestXML=${encodeURIComponent(xml)}`,
    });
    const text = await res.text().catch(() => '');
    if (!res.ok) {
      return { ok: false, error: `Endicia ${res.status}: ${(text || res.statusText).slice(0, 200)}` };
    }
    // The response wraps a Status integer; non-zero indicates failure.
    const statusMatch = /<Status>(\d+)<\/Status>/i.exec(text);
    const errorMatch = /<ErrorMessage>([\s\S]*?)<\/ErrorMessage>/i.exec(text);
    if (statusMatch && Number(statusMatch[1]) !== 0) {
      const reason = (errorMatch?.[1] ?? `Status ${statusMatch[1]}`).trim().slice(0, 200);
      return { ok: false, error: `Endicia: ${reason}` };
    }
    return {
      ok: true,
      accountIdentifier: accountId,
      accountLabel: `Endicia ${accountId}`,
      meta: {},
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (/fetch failed|ENOTFOUND|getaddrinfo/i.test(msg)) {
      return { ok: false, error: 'Endicia: default hostname unreachable. The Label Server endpoint may have moved — provide the current host via your Endicia account docs.' };
    }
    return { ok: false, error: msg };
  }
};

// ───────── eBay (OAuth 2.0 user-token refresh) ─────────
// Verifies by exchanging the saved refresh_token for a fresh access_token
// at api.ebay.com/identity/v1/oauth2/token. App-level credentials (App ID
// + Cert ID) form the Basic auth pair. devId isn't part of the modern
// REST OAuth flow but is preserved on the row for legacy Trading API
// calls. Scope is set to sell.fulfillment which is what we'll need for
// orders pull / tracking push.
async function verifyEbayScope(
  creds: Record<string, unknown>,
  scope: string,
  label: string,
): Promise<VerifyResult> {
  const appId = String(creds?.appId ?? '').trim();
  const certId = String(creds?.certId ?? '').trim();
  const refreshToken = String(creds?.refreshToken ?? '').trim();
  if (!appId || !certId || !refreshToken) {
    return { ok: false, error: 'appId, certId, and refreshToken are required' };
  }
  const useSandbox = String(creds?.environment ?? '').toLowerCase() === 'sandbox';
  const tokenUrl = useSandbox
    ? 'https://api.sandbox.ebay.com/identity/v1/oauth2/token'
    : 'https://api.ebay.com/identity/v1/oauth2/token';
  const basic = Buffer.from(`${appId}:${certId}`).toString('base64');
  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
    scope,
  });
  try {
    const res = await fetch(tokenUrl, {
      method: 'POST',
      headers: {
        Authorization: `Basic ${basic}`,
        'Content-Type': 'application/x-www-form-urlencoded',
        Accept: 'application/json',
      },
      body: body.toString(),
    });
    if (!res.ok) {
      const t = await res.text().then((s) => s.slice(0, 300)).catch(() => '');
      return { ok: false, error: `eBay OAuth ${res.status}: ${t || res.statusText}` };
    }
    const data = (await res.json()) as { access_token?: string; expires_in?: number; token_type?: string };
    if (!data?.access_token) return { ok: false, error: 'eBay OAuth response missing access_token' };
    return {
      ok: true,
      accountIdentifier: appId.split('-').slice(0, 2).join('-'), // app-prefix surrogate
      accountLabel: useSandbox ? `${label} (Sandbox)` : `${label} (Production)`,
      meta: {
        tokenExpiresIn: data.expires_in ?? null,
        tokenType: data.token_type ?? null,
        scope,
        environment: useSandbox ? 'sandbox' : 'production',
      },
    };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

const verifyEbay: Verifier = (creds) =>
  verifyEbayScope(
    creds,
    'https://api.ebay.com/oauth/api_scope/sell.fulfillment',
    'eBay',
  );

const verifyEbayShipping: Verifier = (creds) =>
  verifyEbayScope(
    creds,
    'https://api.ebay.com/oauth/api_scope/sell.logistics',
    'eBay Shipping',
  );

const STUBBED_NOTES: Record<string, string> = {
  shipstation: 'Already integrated via /api/rates/multi.ts.',
  ehub: 'eHub credential capture is available in Settings, but live verification needs the eHub API base URL and verification endpoint from the private eHub docs/API Explorer.',
};

const VERIFIERS: Partial<Record<ProviderType, Verifier>> = {
  simulator: verifySimulator,
  // Walmart Shipping uses identical OAuth client_credentials as the
  // Walmart Marketplace store integration — same /v3/token endpoint,
  // same headers, same response. Just routed to a separate verifier
  // entry so it appears under the carrier umbrella.
  walmart_shipping: verifyWalmart,
  ebay: verifyEbay,
  // eBay Shipping uses the same OAuth user-token refresh flow as the
  // eBay store integration. Separate key only so it appears under the
  // Carriers section in Settings (paired with the future tracking-push
  // endpoint at /api/carriers/ebay/ship).
  ebay_shipping: verifyEbayShipping,
  shipengine: verifyShipEngine,
  ehub: verifyEhub,
  easypost: verifyEasyPost,
  shipp: verifyShipp,
  ups: verifyUps,
  fedex: verifyFedEx,
  dhl_express: verifyDhlExpress,
  usps: verifyUsps,
  amazon_shipping: verifyAmazonShipping,
  walmart: verifyWalmart,
  seko: verifySeko,
  epost_global: verifyEpostGlobal,
  intelliquick: verifyIntelliquick,
  gls: verifyGls,
  stamps_com: verifyStampsCom,
  endicia: verifyEndicia,
};

// Reusable credential-verify dispatcher (same verifiers the HTTP handler uses).
// Used by tooling (e.g. the connector health report) to confirm a saved
// credential still AUTHENTICATES. These are READ-ONLY auth checks — the
// verifiers above never create labels, buy postage, send notifications, or touch
// orders. Returns { ok, error?, accountIdentifier?, accountLabel?, meta? }.
export async function verifyProviderCredentials(
  provider: string,
  credentials: Record<string, unknown>,
): Promise<VerifyResult> {
  const key = String(provider ?? '').trim().toLowerCase().replace(/[\s-]+/g, '_') as ProviderType;
  const verifier = VERIFIERS[key];
  if (!verifier) {
    const note = STUBBED_NOTES[key] ?? 'Provider not implemented yet.';
    return { ok: false, error: `${provider} verification not implemented`, meta: { note } };
  }
  return verifier(credentials);
}

function readBody(req: any): Promise<unknown> {
  // Mirror the body-parsing approach in api/carrier-accounts.ts so behaviour
  // is consistent across endpoints.
  if (req.body) {
    if (typeof req.body === 'object') return Promise.resolve(req.body);
    if (typeof req.body === 'string') {
      try {
        return Promise.resolve(JSON.parse(req.body));
      } catch {
        return Promise.resolve({});
      }
    }
  }
  return new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', (chunk: Buffer) => {
      raw += chunk.toString();
    });
    req.on('end', () => {
      if (!raw) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch (err) {
        reject(err);
      }
    });
    req.on('error', reject);
  });
}

export default async function handler(req: any, res: any): Promise<void> {
  const origin = (req.headers?.origin as string | undefined) ?? null;
  const ch = corsHeaders(origin, { methods: 'POST, OPTIONS' });
  for (const [k, v] of Object.entries(ch)) res.setHeader(k, v);

  if (req.method === 'OPTIONS') {
    res.status(204).end();
    return;
  }
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }

  const token = extractBearerToken(
    req.headers?.authorization || req.headers?.Authorization
  );
  if (!token) {
    res.status(401).json({ error: 'Missing Authorization' });
    return;
  }
  const verified = await verifySupabaseJwt(token);
  if (!verified.ok) {
    console.warn('[direct-carrier-verify] Invalid token:', verified.reason);
    res.status(401).json({ error: 'Invalid token' });
    return;
  }

  const body = (await readBody(req)) as Record<string, unknown>;
  // FE may pass either carrierAccountId (carrier_accounts row) or
  // storeAccountId (store_accounts row). They're separate tables now —
  // see api/store-accounts.ts. We accept both and load from whichever
  // table the caller pointed us at.
  const carrierAccountId = body?.carrierAccountId != null ? Number(body.carrierAccountId) : null;
  const storeAccountId = body?.storeAccountId != null ? Number(body.storeAccountId) : null;
  let provider = String(body?.provider ?? '').toLowerCase() as ProviderType;
  let credentials = (body?.credentials && typeof body.credentials === 'object'
    ? (body.credentials as Record<string, unknown>)
    : null);

  if (carrierAccountId !== null || storeAccountId !== null) {
    const dbUrl = process.env.DATABASE_URL;
    if (!dbUrl) {
      res.status(500).json({ error: 'DATABASE_URL not configured' });
      return;
    }
    const sql = postgres(dbUrl, { max: 1, prepare: false, idle_timeout: 5, connect_timeout: 5 });
    try {
      const useStoreTable = storeAccountId !== null;
      const lookupId = useStoreTable ? storeAccountId : carrierAccountId;
      const tableName = useStoreTable ? 'store_accounts' : 'carrier_accounts';
      const rows = useStoreTable
        ? await sql<Array<{ provider: string; credentials: unknown }>>`
            SELECT provider, credentials FROM store_accounts WHERE id = ${lookupId as number} LIMIT 1
          `
        : await sql<Array<{ provider: string; credentials: unknown }>>`
            SELECT provider, credentials FROM carrier_accounts WHERE id = ${lookupId as number} LIMIT 1
          `;
      const row = rows[0];
      if (!row) {
        res.status(404).json({ error: `${tableName} row #${lookupId} not found` });
        return;
      }
      provider = row.provider as ProviderType;
      credentials = (row.credentials && typeof row.credentials === 'object'
        ? (row.credentials as Record<string, unknown>)
        : {});
    } catch (err) {
      sendInternalServerError(res, 'carriers/verify:account-lookup', err);
      return;
    } finally {
      try { await sql.end({ timeout: 1 }); } catch { /* ignore */ }
    }
  }

  if (!provider || !credentials) {
    res.status(400).json({ error: 'provider and credentials are required (or carrierAccountId)' });
    return;
  }

  const verifier = VERIFIERS[provider];
  if (!verifier) {
    const note = STUBBED_NOTES[provider] ?? 'Provider not implemented yet.';
    res.status(200).json({ ok: false, error: `${provider} integration not yet implemented`, meta: { note } });
    return;
  }

  try {
    let result = await verifier(credentials);

    // Carrier-side auto-recovery for "<store>_shipping" providers: if a
    // user added the carrier entry but the credentials they pasted got
    // truncated/mangled, fall back to the matching store_accounts row's
    // saved credentials (same OAuth, same API). On success, UPSERT the
    // working creds into the carrier row so future calls skip this
    // fallback path. Currently covers walmart_shipping ↔ walmart store
    // and ebay_shipping ↔ ebay store.
    const shippingMatch = typeof provider === 'string' && provider.endsWith('_shipping')
      ? provider.replace(/_shipping$/, '')
      : null;
    if (!result.ok && shippingMatch && carrierAccountId !== null) {
      const dbUrl = process.env.DATABASE_URL;
      if (dbUrl) {
        const sql = postgres(dbUrl, {
          max: 1, prepare: false, idle_timeout: 5, connect_timeout: 5,
        });
        try {
          const storeRows = await sql<Array<{ credentials: unknown }>>`
            SELECT credentials FROM store_accounts
            WHERE provider = ${shippingMatch} AND active = true
            ORDER BY id DESC
            LIMIT 1
          `;
          const storeCreds = storeRows[0]?.credentials;
          if (storeCreds && typeof storeCreds === 'object' && !Array.isArray(storeCreds)) {
            const fallback = storeCreds as Record<string, unknown>;
            // walmart uses {clientId, clientSecret}; ebay uses
            // {appId, certId, refreshToken}. Both have at least two
            // non-empty string fields — that's sufficient signal that
            // there's something worth retrying with.
            const credKeys = Object.keys(fallback).filter(
              (k) => typeof (fallback as any)[k] === 'string' && ((fallback as any)[k] as string).length > 0,
            );
            if (credKeys.length >= 2) {
              const fallbackResult = await verifier(fallback);
              if (fallbackResult.ok) {
                await sql`
                  UPDATE carrier_accounts
                  SET credentials = ${fallback}, updated_at = NOW()
                  WHERE id = ${carrierAccountId}
                `;
                result = {
                  ...fallbackResult,
                  meta: {
                    ...(fallbackResult.meta ?? {}),
                    _autoSyncedFrom: `store_accounts.${shippingMatch}`,
                    _note: `Carrier-side credentials were stale; auto-synced from the saved ${shippingMatch} store entry.`,
                  },
                };
              }
            }
          }
        } catch (fallbackErr) {
          console.warn(
            `[carriers/verify] ${provider} auto-sync from ${shippingMatch} store failed:`,
            fallbackErr instanceof Error ? fallbackErr.message : fallbackErr,
          );
        } finally {
          try { await sql.end({ timeout: 1 }); } catch { /* ignore */ }
        }
      }
    }

    if (!result.ok) {
      // Surface which credential keys the verifier saw so it's obvious when
      // a save → load round-trip dropped fields (versus the carrier API
      // legitimately rejecting valid creds). Keys only — never values.
      result.meta = {
        ...(result.meta ?? {}),
        _credentialKeysReceived: Object.keys(credentials).sort(),
        _credentialsType: typeof credentials,
      };
    }
    res.status(200).json(result);
  } catch (err) {
    sendInternalServerError(res, 'carriers/verify', err);
  }
}
