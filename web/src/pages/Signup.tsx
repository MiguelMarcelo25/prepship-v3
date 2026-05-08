/**
 * Signup — Network Globe design (matches Login).
 *
 * Auth logic UNCHANGED from the previous Signup.tsx:
 *   - useAuth().signUp(cleanEmail, password) → { needsEmailConfirmation }
 *   - loading short-circuit
 *   - session redirect to "/"
 *   - validation: email + password required, password ≥ 8 chars,
 *     passwords must match
 *   - pendingVerification "check your email" success state
 *
 * Only the shell + form chrome changed — uses AuthGlobeShell + DarkField
 * + PrimarySubmit so it matches the Login page visually.
 */

import { useState, type FormEvent } from 'react';
import { Link, Navigate } from 'react-router-dom';
import { Eye, EyeOff, Mail, Lock, MailCheck } from 'lucide-react';
import { useAuth } from '../lib/auth';
import {
  AuthGlobeShell,
  DarkField,
  PrimarySubmit,
  ErrorBanner,
  C,
} from '../components/AuthGlobeShell';

export default function Signup() {
  const { signUp, session, loading } = useAuth();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [pendingVerification, setPendingVerification] = useState<string | null>(
    null,
  );

  if (loading) {
    return (
      <div
        className="flex-1 w-full min-h-screen flex items-center justify-center"
        style={{ background: C.canvas, color: C.muted }}
      >
        Loading…
      </div>
    );
  }

  if (session) return <Navigate to="/" replace />;

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    const cleanEmail = email.trim();
    if (!cleanEmail || !password) {
      setError('Email and password are required.');
      return;
    }
    if (password.length < 8) {
      setError('Password must be at least 8 characters.');
      return;
    }
    if (password !== confirm) {
      setError('Passwords do not match.');
      return;
    }
    setSubmitting(true);
    try {
      const { needsEmailConfirmation } = await signUp(cleanEmail, password);
      if (needsEmailConfirmation) setPendingVerification(cleanEmail);
    } catch (err) {
      setError((err as Error).message ?? 'Sign-up failed');
    } finally {
      setSubmitting(false);
    }
  };

  /* ─── "Check your email" success state ─── */
  if (pendingVerification) {
    return (
      <AuthGlobeShell
        title="Check your email"
        subtitle="One more step before you can sign in."
        footer={
          <Link
            to="/login"
            className="font-medium transition-colors"
            style={{ color: C.accent }}
            onMouseEnter={(e) => (e.currentTarget.style.color = C.accentSoft)}
            onMouseLeave={(e) => (e.currentTarget.style.color = C.accent)}
          >
            ← Back to sign in
          </Link>
        }
      >
        <div className="flex flex-col items-center text-center py-2">
          <div
            className="w-14 h-14 rounded-full flex items-center justify-center mb-4"
            style={{
              background: 'rgba(122, 162, 200, 0.10)',
              border: `1px solid ${C.line}`,
            }}
          >
            <MailCheck size={26} style={{ color: C.accent }} />
          </div>
          <p className="text-[13px] leading-relaxed" style={{ color: C.text }}>
            We sent a confirmation link to{' '}
            <span className="font-semibold" style={{ color: C.accent }}>
              {pendingVerification}
            </span>
            . Click the link in the email to verify your account, then come
            back and sign in.
          </p>
          <p className="text-[11px] mt-3" style={{ color: C.faint }}>
            Didn&apos;t get it? Check your spam folder.
          </p>
        </div>
      </AuthGlobeShell>
    );
  }

  /* ─── Default signup form ─── */
  return (
    <AuthGlobeShell
      title="Create your account"
      subtitle="Get access to the PrepShip dashboard."
      footer={
        <>
          Already have an account?{' '}
          <Link
            to="/login"
            className="font-medium transition-colors"
            style={{ color: C.accent }}
            onMouseEnter={(e) => (e.currentTarget.style.color = C.accentSoft)}
            onMouseLeave={(e) => (e.currentTarget.style.color = C.accent)}
          >
            Sign in
          </Link>
        </>
      }
    >
      <form onSubmit={submit} className="space-y-5">
        <DarkField
          label="Email"
          type="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          autoComplete="email"
          placeholder="you@drprepperusa.com"
          disabled={submitting}
          autoFocus
          required
          Icon={Mail}
        />

        <DarkField
          label="Password"
          type={showPassword ? 'text' : 'password'}
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          autoComplete="new-password"
          placeholder="At least 8 characters"
          disabled={submitting}
          required
          Icon={Lock}
          trailing={
            <button
              type="button"
              onClick={() => setShowPassword((v) => !v)}
              className="grid h-7 w-7 place-items-center transition-colors"
              style={{ color: C.muted }}
              onMouseEnter={(e) => (e.currentTarget.style.color = C.text)}
              onMouseLeave={(e) => (e.currentTarget.style.color = C.muted)}
              tabIndex={-1}
              aria-label={showPassword ? 'Hide password' : 'Show password'}
            >
              {showPassword ? <EyeOff size={16} /> : <Eye size={16} />}
            </button>
          }
        />

        <DarkField
          label="Confirm password"
          type={showPassword ? 'text' : 'password'}
          value={confirm}
          onChange={(e) => setConfirm(e.target.value)}
          autoComplete="new-password"
          placeholder="Re-enter password"
          disabled={submitting}
          required
          Icon={Lock}
        />

        {error && <ErrorBanner message={error} />}

        <PrimarySubmit
          loading={submitting}
          loadingLabel="Creating account"
          disabled={!email.trim() || !password || !confirm}
        >
          Create account
        </PrimarySubmit>

        {/* Trust microcopy */}
        <div
          className="flex items-center justify-center gap-2 pt-1 text-[10px] uppercase tracking-[0.22em]"
          style={{
            color: C.faint,
            fontFamily: 'ui-monospace, "JetBrains Mono", monospace',
          }}
        >
        </div>
      </form>
    </AuthGlobeShell>
  );
}
