import { createMiddleware } from 'hono/factory';
import { jwtVerify } from 'jose';
import { env } from '../lib/env';

const jwtSecret = new TextEncoder().encode(env.SUPABASE_JWT_SECRET);

export type AuthVars = {
  userId: string;
  email?: string;
  role?: string;
};

export const requireAuth = createMiddleware<{ Variables: AuthVars }>(
  async (c, next) => {
    const auth = c.req.header('authorization');
    if (!auth?.toLowerCase().startsWith('bearer ')) {
      return c.json({ error: 'Missing bearer token' }, 401);
    }
    const token = auth.slice(7).trim();
    try {
      const { payload } = await jwtVerify(token, jwtSecret);
      if (!payload.sub) return c.json({ error: 'Invalid token' }, 401);
      c.set('userId', payload.sub);
      c.set('email', payload.email as string | undefined);
      c.set('role', payload.role as string | undefined);
      await next();
    } catch {
      return c.json({ error: 'Invalid token' }, 401);
    }
  }
);
