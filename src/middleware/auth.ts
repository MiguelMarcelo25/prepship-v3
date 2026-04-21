import { createMiddleware } from 'hono/factory';
import { supabaseAdmin } from '../lib/supabase';

export type AuthVars = {
  userId: string;
  email?: string;
  role?: string;
};

// Paths that are served unauthenticated even when they sit under an auth-gated
// prefix. Mock test labels live at /labels/mock/:id — the browser loads them
// via window.open which can't attach a bearer token, and they're fake data
// anyway. The shipmentId is effectively unguessable (random 8-digit int).
const AUTH_BYPASS_PREFIXES = ['/labels/mock/'];

export const requireAuth = createMiddleware<{ Variables: AuthVars }>(
  async (c, next) => {
    if (AUTH_BYPASS_PREFIXES.some((p) => c.req.path.startsWith(p))) {
      await next();
      return;
    }
    const auth = c.req.header('authorization');
    if (!auth?.toLowerCase().startsWith('bearer ')) {
      return c.json({ error: 'Missing bearer token' }, 401);
    }
    const token = auth.slice(7).trim();
    const { data, error } = await supabaseAdmin.auth.getUser(token);
    if (error || !data.user) {
      return c.json({ error: 'Invalid token' }, 401);
    }
    c.set('userId', data.user.id);
    c.set('email', data.user.email ?? undefined);
    c.set('role', (data.user.app_metadata?.role as string | undefined) ?? undefined);
    await next();
  }
);
