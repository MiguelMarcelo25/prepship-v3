import type { Context } from 'hono';

export type NodeStyleRequest = {
  method?: string;
  url?: string;
  headers?: Record<string, string | string[] | undefined>;
  body?: unknown;
  on?: (event: string, listener: (...args: unknown[]) => void) => unknown;
};

export type NodeStyleResponse = {
  setHeader(name: string, value: string | number | readonly string[]): void;
  status(code: number): NodeStyleResponse;
  json(payload: unknown): NodeStyleResponse;
  end(payload?: unknown): NodeStyleResponse;
};

export type NodeStyleHandler = (
  req: NodeStyleRequest,
  res: NodeStyleResponse,
) => Promise<void> | void;

export async function readNodeJsonBody(
  req: NodeStyleRequest,
): Promise<Record<string, unknown>> {
  if (req.body != null) {
    if (typeof req.body === 'object' && !Array.isArray(req.body)) {
      return req.body as Record<string, unknown>;
    }
    if (typeof req.body === 'string') {
      try {
        const parsed: unknown = JSON.parse(req.body);
        return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
          ? (parsed as Record<string, unknown>)
          : {};
      } catch {
        return {};
      }
    }
  }

  if (!req.on) return {};

  return new Promise((resolve, reject) => {
    let raw = '';
    req.on?.('data', (chunk: unknown) => {
      raw += String(chunk);
    });
    req.on?.('end', () => {
      if (!raw) return resolve({});
      try {
        const parsed: unknown = JSON.parse(raw);
        resolve(
          parsed && typeof parsed === 'object' && !Array.isArray(parsed)
            ? (parsed as Record<string, unknown>)
            : {},
        );
      } catch (error) {
        reject(error);
      }
    });
    req.on?.('error', reject);
  });
}

function headersObject(headers: Headers): Record<string, string> {
  const out: Record<string, string> = {};
  headers.forEach((value, key) => {
    out[key] = value;
  });
  return out;
}

async function requestBody(c: Context): Promise<unknown> {
  if (c.req.method === 'GET' || c.req.method === 'HEAD') return undefined;

  const raw = await c.req.text();
  if (!raw) return undefined;

  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

export function runNodeHandler(handler: NodeStyleHandler) {
  return async (c: Context) => {
    const responseHeaders = new Headers();
    let statusCode = 200;
    let body: string | Uint8Array | null = null;

    function setBody(payload?: unknown) {
      if (payload == null) {
        body = null;
        return;
      }
      if (typeof payload === 'string' || payload instanceof Uint8Array) {
        body = payload;
        return;
      }
      if (payload instanceof ArrayBuffer) {
        body = new Uint8Array(payload);
        return;
      }
      if (!responseHeaders.has('Content-Type')) {
        responseHeaders.set('Content-Type', 'application/json');
      }
      body = JSON.stringify(payload);
    }

    const res: NodeStyleResponse = {
      setHeader(name: string, value: string | number | readonly string[]) {
        responseHeaders.set(name, Array.isArray(value) ? value.join(', ') : String(value));
      },
      status(code: number) {
        statusCode = code;
        return res;
      },
      json(payload: unknown) {
        responseHeaders.set('Content-Type', 'application/json');
        setBody(payload);
        return res;
      },
      end(payload?: unknown) {
        setBody(payload);
        return res;
      },
    };

    const req: NodeStyleRequest = {
      method: c.req.method,
      url: c.req.url,
      headers: headersObject(c.req.raw.headers),
      body: await requestBody(c),
    };

    await handler(req, res);
    return new Response(body, {
      status: statusCode,
      headers: responseHeaders,
    });
  };
}
