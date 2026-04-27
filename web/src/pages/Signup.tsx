import { useState, type FormEvent } from 'react';
import { Link, Navigate } from 'react-router-dom';
import { Eye, EyeOff, Mail, Lock, MailCheck } from 'lucide-react';
import { useAuth } from '../lib/auth';
import { Button } from '../components/ui/Button';
import { Input } from '../components/ui/Input';
import AuthLayout from '../components/AuthLayout';

export default function Signup() {
  const { signUp, session, loading } = useAuth();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [pendingVerification, setPendingVerification] = useState<string | null>(
    null
  );

  if (loading) {
    return (
      <div className="flex-1 w-full min-h-screen flex items-center justify-center bg-page text-ink-3">
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

  if (pendingVerification) {
    return (
      <AuthLayout
        title="Check your email"
        subtitle="One more step before you can sign in."
        footer={
          <Link to="/login" className="text-brand hover:underline font-semibold">
            Back to sign in
          </Link>
        }
      >
        <div className="flex flex-col items-center text-center py-2">
          <div className="w-14 h-14 rounded-full bg-brand-bg border border-brand-border flex items-center justify-center mb-4">
            <MailCheck size={26} className="text-brand" />
          </div>
          <p className="text-tiny text-ink-2 leading-relaxed">
            We sent a confirmation link to{' '}
            <span className="font-semibold text-ink">{pendingVerification}</span>.
            Click the link in the email to verify your account, then come back
            and sign in.
          </p>
          <p className="text-[10.5px] text-ink-3 mt-3">
            Didn't get it? Check your spam folder.
          </p>
        </div>
      </AuthLayout>
    );
  }

  return (
    <AuthLayout
      title="Create your account"
      subtitle="Get access to the PrepShip dashboard."
      footer={
        <>
          Already have an account?{' '}
          <Link to="/login" className="text-brand hover:underline font-semibold">
            Sign in
          </Link>
        </>
      }
    >
      <form onSubmit={submit} className="space-y-4">
        <div>
          <label className="section-label block mb-1.5">Email</label>
          <Input
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            autoComplete="email"
            placeholder="you@drprepperusa.com"
            leading={<Mail size={13} />}
            required
            autoFocus
            disabled={submitting}
          />
        </div>
        <div>
          <label className="section-label block mb-1.5">Password</label>
          <div className="relative">
            <Input
              type={showPassword ? 'text' : 'password'}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoComplete="new-password"
              placeholder="At least 8 characters"
              leading={<Lock size={13} />}
              required
              disabled={submitting}
              className="pr-9"
            />
            <button
              type="button"
              onClick={() => setShowPassword((v) => !v)}
              className="absolute right-2 top-1/2 -translate-y-1/2 text-ink-3 hover:text-ink"
              tabIndex={-1}
              aria-label={showPassword ? 'Hide password' : 'Show password'}
            >
              {showPassword ? <EyeOff size={14} /> : <Eye size={14} />}
            </button>
          </div>
        </div>
        <div>
          <label className="section-label block mb-1.5">Confirm password</label>
          <Input
            type={showPassword ? 'text' : 'password'}
            value={confirm}
            onChange={(e) => setConfirm(e.target.value)}
            autoComplete="new-password"
            placeholder="Re-enter password"
            leading={<Lock size={13} />}
            required
            disabled={submitting}
          />
        </div>
        {error && (
          <div className="rounded-btn bg-danger-bg border border-danger-border text-danger text-tiny px-2.5 py-2" role="alert">
            {error}
          </div>
        )}
        <Button
          type="submit"
          variant="primary"
          size="md"
          className="w-full !py-2.5 !text-[13px] !font-semibold"
          disabled={submitting || !email.trim() || !password || !confirm}
        >
          {submitting ? 'Creating account…' : 'Create account'}
        </Button>
      </form>
    </AuthLayout>
  );
}
