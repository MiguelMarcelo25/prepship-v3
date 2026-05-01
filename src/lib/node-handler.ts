import type { Context } from 'hono';

type NodeStyleHandler = (req: any, res: any) => Promise<void> | void;

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

    const res = {
      setHeader(name: string, value: string | number | readonly string[]) {
        responseHeaders.set(name, Array.isArray(value) ? value.join(', ') : String(value));
      },
      status(code: number) {
        statusCode = code;
        return res;
      },
      json(payload: unknown) {
        responseHeaders.set('Content-Type', 'application/json');
        body = JSON.stringify(payload);
        return res;
      },
      end(payload?: string | Uint8Array | Buffer | null) {
        body = payload ?? null;
        return res;
      },
    };

    const req = {
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
