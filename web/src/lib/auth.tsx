import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import type { Session, User } from '@supabase/supabase-js';
import { supabase } from './supabase';

type SignUpResult = {
  needsEmailConfirmation: boolean;
};

type AuthState = {
  session: Session | null;
  user: User | null;
  loading: boolean;
  signIn: (email: string, password: string) => Promise<void>;
  signUp: (email: string, password: string) => Promise<SignUpResult>;
  signOut: () => Promise<void>;
  resetPasswordForEmail: (email: string) => Promise<void>;
  updatePassword: (newPassword: string) => Promise<void>;
};

const Ctx = createContext<AuthState | null>(null);

function buildRedirect(path: string): string {
  if (typeof window === 'undefined') return path;
  return `${window.location.origin}${path}`;
}

// Wipes the stale refresh-token entry from localStorage without
// waiting on /auth/v1/logout. We use this when the browser needs to
// become logged out even if remote session revocation is slow or fails.
async function clearLocalSession() {
  try {
    await supabase.auth.signOut({ scope: 'local' });
  } catch {
    // Best effort: the next session refresh attempt will retry cleanup.
  }
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<Session | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;

    // Wipes the stale refresh-token entry from localStorage without
    // hitting /auth/v1/logout. We use this when we know the token the
    // browser is holding is already invalid — calling the server to
    // revoke an already-invalid token would just produce another 4xx.
    async function clearLocalSession() {
      try {
        await supabase.auth.signOut({ scope: 'local' });
      } catch {
        // The local-scope signOut is best-effort; if it fails we just
        // leave localStorage alone — the next session refresh attempt
        // will retry the same recovery path.
      }
    }

    async function loadInitialSession() {
      try {
        const { data, error } = await supabase.auth.getSession();
        if (cancelled) return;
        if (error) {
          // localStorage holds a session Supabase no longer recognizes
          // (typical causes: project key rotation, server-side session
          // cleanup, signed out on another device, dev DB reset).
          // Clear it locally so the background autoRefresh loop doesn't
          // keep hitting the 400 on every page load.
          console.warn('[auth] Stored session invalid, clearing:', error.message);
          await clearLocalSession();
          setSession(null);
        } else {
          setSession(data.session);
        }
      } catch (err) {
        if (cancelled) return;
        // getSession itself shouldn't throw (it just reads localStorage),
        // but a hard catch is cheap insurance against SDK changes.
        console.warn('[auth] getSession threw:', err);
        await clearLocalSession();
        setSession(null);
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    void loadInitialSession();

    const { data: sub } = supabase.auth.onAuthStateChange((event, s) => {
      // Supabase emits SIGNED_OUT with s=null when a background token
      // refresh fails — the existing setSession(s) call covers that.
      // We additionally clear localStorage on a hard sign-out so a
      // stale refresh token isn't left behind for the next page load.
      if (event === 'SIGNED_OUT' && !s) {
        void clearLocalSession();
      }
      setSession(s);
    });

    return () => {
      cancelled = true;
      sub.subscription.unsubscribe();
    };
  }, []);

  const value = useMemo<AuthState>(
    () => ({
      session,
      user: session?.user ?? null,
      loading,
      signIn: async (email, password) => {
        const { data, error } = await supabase.auth.signInWithPassword({
          email,
          password,
        });
        if (error) throw error;
        if (data.session) setSession(data.session);
      },
      signUp: async (email, password) => {
        const { data, error } = await supabase.auth.signUp({
          email,
          password,
          options: {
            emailRedirectTo: buildRedirect('/login'),
          },
        });
        if (error) throw error;
        // If Supabase has email confirmation enabled, `session` is null and
        // a verification email is sent. If it's disabled, a session is
        // returned immediately.
        return { needsEmailConfirmation: !data.session };
      },
      signOut: async () => {
        setSession(null);
        setLoading(false);
        await clearLocalSession();
      },
      resetPasswordForEmail: async (email) => {
        const { error } = await supabase.auth.resetPasswordForEmail(email, {
          redirectTo: buildRedirect('/reset-password'),
        });
        if (error) throw error;
      },
      updatePassword: async (newPassword) => {
        const { error } = await supabase.auth.updateUser({
          password: newPassword,
        });
        if (error) throw error;
      },
    }),
    [session, loading]
  );

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useAuth() {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error('useAuth must be used inside <AuthProvider>');
  return ctx;
}
