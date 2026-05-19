import { Hono } from 'hono';
import { createClient } from '@supabase/supabase-js';
import { env } from '../lib/env';
import { isAdminEmail } from '../lib/admin-emails';
import { requirePermission } from '../middleware/auth';

const app = new Hono();

// GET /users — list of users that orders can be assigned to. Pulled from
// Supabase Auth via the service-role key (admin API). Cached briefly so
// repeat calls from the assignment dropdown don't hammer Supabase.
//
// Response shape (one row per user):
//   { id: <uuid>, email: <string>, isAdmin: <bool>, createdAt: <iso>,
//     lastSignInAt: <iso|null> }
//
// The root list requires `users:manage` because it is backed by Supabase
// service-role access. /users/me remains available to any authenticated caller.

type CachedUsers = {
  users: Array<{
    id: string;
    email: string;
    isAdmin: boolean;
    createdAt: string | null;
    lastSignInAt: string | null;
  }>;
  fetchedAt: number;
};

const CACHE_TTL_MS = 60_000; // 1 minute
let cache: CachedUsers | null = null;

let cachedAdminClient: ReturnType<typeof createClient> | null = null;
function getAdminClient() {
  if (cachedAdminClient) return cachedAdminClient;
  cachedAdminClient = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  return cachedAdminClient;
}

app.get('/', requirePermission('users:manage'), async (c) => {
  if (cache && Date.now() - cache.fetchedAt < CACHE_TTL_MS) {
    return c.json({ users: cache.users, cached: true });
  }

  const adminClient = getAdminClient();
  const { data, error } = await adminClient.auth.admin.listUsers({
    page: 1,
    perPage: 200,
  });
  if (error) {
    console.warn('[users] listUsers failed:', error.message);
    return c.json({ error: 'Failed to load users' }, 500);
  }

  const users = (data?.users ?? [])
    .map((u) => ({
      id: u.id,
      email: u.email ?? '',
      isAdmin: isAdminEmail(u.email),
      createdAt: u.created_at ?? null,
      lastSignInAt: u.last_sign_in_at ?? null,
    }))
    .filter((u) => u.email)
    .sort((a, b) => {
      if (a.isAdmin && !b.isAdmin) return -1;
      if (!a.isAdmin && b.isAdmin) return 1;
      return a.email.localeCompare(b.email);
    });

  cache = { users, fetchedAt: Date.now() };
  return c.json({ users, cached: false });
});

// GET /users/me — caller's own identity + admin flag. Lighter than /users
// when the frontend only needs to decide whether to show admin UI.
app.get('/me', (c) => {
  const userId = c.get('userId' as never) as string | undefined;
  const email = (c.get('email' as never) as string | undefined) ?? null;
  return c.json({
    id: userId ?? null,
    email,
    isAdmin: isAdminEmail(email),
  });
});

export default app;
