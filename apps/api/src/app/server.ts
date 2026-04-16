import { createServer, type Server } from "node:http";
import { rateLimiter } from "./rate-limit.js";

export function startHttpServer(handler: (request: Request) => Promise<Response>, port: number): Promise<Server> {
  const server = createServer(async (req, res) => {
    const origin = `http://${req.headers.host ?? `127.0.0.1:${port}`}`;
    const method = req.method ?? 'GET';
    const hasBody = method !== 'GET' && method !== 'HEAD';
    
    const requestInit: RequestInit & { duplex?: string } = {
      method,
      headers: req.headers as HeadersInit,
    };
    
    if (hasBody) {
      requestInit.body = req;
      requestInit.duplex = 'half';
    }
    
    const request = new Request(new URL(req.url ?? "/", origin), requestInit);

    // ── Rate limiting (100 req/min per IP, /api/* only) ──────────────────────
    // Prefer CF-Connecting-IP (set by Cloudflare) → x-forwarded-for → socket IP
    const clientIp =
      (req.headers["cf-connecting-ip"] as string | undefined) ??
      (req.headers["x-forwarded-for"] as string | undefined)?.split(",")[0]?.trim() ??
      req.socket.remoteAddress ??
      "unknown";

    const limitResponse = rateLimiter.check(clientIp, new URL(req.url ?? "/", origin).pathname);
    if (limitResponse) {
      res.statusCode = 429;
      for (const [key, value] of limitResponse.headers.entries()) {
        res.setHeader(key, value);
      }
      res.end(await limitResponse.text());
      return;
    }
    // ─────────────────────────────────────────────────────────────────────────

    let response = await handler(request);

    // Annotate successful /api/* responses with rate-limit headers.
    response = rateLimiter.annotate(response, clientIp);

    res.statusCode = response.status;

    for (const [key, value] of response.headers.entries()) {
      res.setHeader(key, value);
    }

    // Use arrayBuffer (binary-safe) instead of text() which corrupts binary responses (PDFs, images)
    // by replacing invalid UTF-8 bytes with the replacement character U+FFFD.
    const bodyBuffer = Buffer.from(await response.arrayBuffer());
    res.end(bodyBuffer);
  });

  return new Promise((resolve) => {
    server.listen(port, () => resolve(server));
  });
}

