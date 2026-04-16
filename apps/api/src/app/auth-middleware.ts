import { jsonResponse } from "../common/http/json.js";

export type AppHandler = (request: Request) => Promise<Response>;

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
      const token = request.headers.get("x-app-token");
      if (!token || token !== sessionToken) {
        return jsonResponse(401, { error: "Unauthorized" });
      }
    }

    // All other routes (including /health) pass through
    return handler(request);
  };
}
