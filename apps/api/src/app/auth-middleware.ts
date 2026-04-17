import { jsonResponse } from "../common/http/json.js";

export type AppHandler = (request: Request) => Promise<Response>;

/** Safely read a header whether headers is a Headers instance or a plain object. */
function getHeader(headers: unknown, name: string): string | null {
  if (headers && typeof (headers as Headers).get === "function") {
    return (headers as Headers).get(name);
  }
  // Vercel serverless may pass headers as a plain object
  const obj = headers as Record<string, string | string[] | undefined>;
  const val = obj[name] ?? obj[name.toLowerCase()];
  if (Array.isArray(val)) return val[0] ?? null;
  return val ?? null;
}

/**
 * Wraps an app handler with auth middleware.
 * - All /api/* routes require X-App-Token header (except /api/auth/token)
 * - NO IP-based bypass: auth is enforced regardless of source IP or proxy headers
 * - /api/portal/* routes have their own auth (skipped by this middleware)
 *
 * SECURITY FIX (2026-03-17): Removed IP-based auth bypass.
 * Previously, requests appearing to come from private/LAN IPs were allowed
 * through without a token. Cloudflare proxy headers caused remote requests to
 * appear as private-IP traffic, bypassing auth entirely. All /api/* routes now
 * require a valid X-App-Token — no exceptions based on source IP.
 */
export function createAuthMiddleware(handler: AppHandler, sessionToken: string): AppHandler {
  return async (request: Request): Promise<Response> => {
    // CORS preflight — browsers send OPTIONS without auth headers
    if (request.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, PATCH, OPTIONS",
          "Access-Control-Allow-Headers": "Content-Type, X-App-Token, Authorization",
          "Access-Control-Max-Age": "86400",
        },
      });
    }

    const url = new URL(request.url, "http://localhost");

    // Allow /api/auth/token to be accessed without auth (it serves the token)
    if (url.pathname === "/api/auth/token") {
      return handler(request);
    }

    // Check if this is an /api route that needs auth
    if (url.pathname.startsWith("/api/")) {
      // Bypass for /api/portal/* (has its own JWT auth)
      if (url.pathname.startsWith("/api/portal/")) {
        return handler(request);
      }

      // Require X-App-Token for ALL /api/* routes — no IP-based exceptions
      const token = getHeader(request.headers, "x-app-token");
      if (!token || token !== sessionToken) {
        return jsonResponse(401, { error: "Unauthorized" });
      }
    }

    // All other routes (including /health) pass through
    return handler(request);
  };
}

export { getHeader };
