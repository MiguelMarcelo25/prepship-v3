/**
 * ForgotPassword — Network Globe design (matches Login + Signup).
 *
 * Auth logic UNCHANGED from the previous ForgotPassword.tsx:
 *   - useAuth().resetPasswordForEmail(cleanEmail)
 *   - email validation (trim + non-empty)
 *   - `sent` success state shows a "check your email" panel
 *   - all error messaging preserved
 *
 * Only the visual shell changed — uses AuthGlobeShell + DarkField +
 * PrimarySubmit so it matches the rest of the auth flow.
 */

import { useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { Mail, MailCheck } from 'lucide-react';
import { useAuth } from '../lib/auth';
import {
  AuthGlobeShell,
  DarkField,
  PrimarySubmit,
  ErrorBanner,
  C,
} from '../components/AuthGlobeShell';

export default function ForgotPassword() {
  const { resetPasswordForEmail } = useAuth();
  const [email, setEmail] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [sent, setSent] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    const cleanEmail = email.trim();
    if (!cleanEmail) {
      setError('Email is required.');
      return;
    }
    setSubmitting(true);
    try {
      await resetPasswordForEmail(cleanEmail);
      setSent(true);
    } catch (err) {
      setError((err as Error).message ?? 'Could not send reset email');
    } finally {
      setSubmitting(false);
    }
  };

  /* ─── "Check your email" success state ─── */
  if (sent) {
    return (
      <AuthGlobeShell
        title="Check your email"
        subtitle="We sent you a reset link."
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
            If an account exists for{' '}
            <span className="font-semibold" style={{ color: C.accent }}>
              {email.trim()}
            </span>
            , we sent a reset link. Click the link in the email to set a new
            password.
          </p>
          <p className="text-[11px] mt-3" style={{ color: C.faint }}>
            Didn&apos;t get it? Check your spam folder.
          </p>
        </div>
      </AuthGlobeShell>
    );
  }

  /* ─── Default reset form ─── */
  return (
    <AuthGlobeShell
      title="Reset your password"
      subtitle="Enter your email and we'll send you a reset link."
      footer={
        <>
          Remembered it?{' '}
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

        {error && <ErrorBanner message={error} />}

        <PrimarySubmit
          loading={submitting}
          loadingLabel="Sending"
          disabled={!email.trim()}
        >
          Send reset link
        </PrimarySubmit>

        {/* Trust microcopy */}
        <div
          className="flex items-center justify-center gap-2 pt-1 text-[10px] uppercase tracking-[0.22em]"
          style={{
            color: C.faint,
            fontFamily: 'ui-monospace, "JetBrains Mono", monospace',
          }}
        >
          {/* <Mail size={10} strokeWidth={1.8} aria-hidden />
          <span>Reset link is single-use and expires in 1 hour</span> */}
        </div>
      </form>
    </AuthGlobeShell>
  );
}
