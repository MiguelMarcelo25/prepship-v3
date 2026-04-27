import { useState, type FormEvent } from 'react';
import { Link, Navigate } from 'react-router-dom';
import { Eye, EyeOff } from 'lucide-react';
import { useAuth } from '../lib/auth';
import { Button } from '../components/ui/Button';
import { Input } from '../components/ui/Input';

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
      if (needsEmailConfirmation) {
        setPendingVerification(cleanEmail);
      } else {
        // Account created and signed in immediately — Navigate handles redirect
        // on next render via `session`.
      }
    } catch (err) {
      setError((err as Error).message ?? 'Sign-up failed');
    } finally {
      setSubmitting(false);
    }
  };

  if (pendingVerification) {
    return (
      <div className="flex-1 w-full min-h-screen flex items-center justify-center bg-page px-4">
        <div className="w-full max-w-sm bg-white rounded-card border border-line shadow-sm p-6 text-center">
          <div className="flex items-baseline justify-center text-[24px] font-extrabold tracking-[-0.5px] mb-4">
            <span className="text-ink">PREP</span>
            <span className="text-brand">SHIP</span>
          </div>
          <h1 className="text-[15px] font-semibold text-ink mb-2">
            Check your email
          </h1>
          <p className="text-tiny text-ink-2 leading-relaxed mb-4">
            We sent a confirmation link to{' '}
            <span className="font-semibold text-ink">{pendingVerification}</span>.
            Click the link to verify your account, then sign in.
          </p>
          <Link
            to="/login"
            className="text-tiny text-brand hover:underline font-semibold"
          >
            Back to sign in
          </Link>
        </div>
      </div>
    );
  }

  return (
    <div className="flex-1 w-full min-h-screen flex items-center justify-center bg-page px-4">
      <form
        onSubmit={submit}
        className="w-full max-w-sm bg-white rounded-card border border-line shadow-sm p-6"
      >
        <div className="text-center mb-6">
          <div className="flex items-baseline justify-center text-[24px] font-extrabold tracking-[-0.5px]">
            <span className="text-ink">PREP</span>
            <span className="text-brand">SHIP</span>
          </div>
          <div className="text-[10px] uppercase tracking-[0.4px] text-ink-3 mt-1">
            Create your account
          </div>
        </div>

        <div className="space-y-3">
          <div>
            <label className="section-label block mb-1.5">Email</label>
            <Input
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              autoComplete="email"
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
            <div className="text-[10.5px] text-ink-3 mt-1">
              At least 8 characters.
            </div>
          </div>
          <div>
            <label className="section-label block mb-1.5">Confirm password</label>
            <Input
              type={showPassword ? 'text' : 'password'}
              value={confirm}
              onChange={(e) => setConfirm(e.target.value)}
              autoComplete="new-password"
              required
              disabled={submitting}
            />
          </div>
          {error && (
            <div className="text-danger text-tiny py-1" role="alert">
              {error}
            </div>
          )}
          <Button
            type="submit"
            variant="primary"
            size="md"
            className="w-full"
            disabled={
              submitting || !email.trim() || !password || !confirm
            }
          >
            {submitting ? 'Creating account…' : 'Create account'}
          </Button>
        </div>

        <div className="mt-5 text-tiny text-ink-3 text-center">
          Already have an account?{' '}
          <Link to="/login" className="text-brand hover:underline font-semibold">
            Sign in
          </Link>
        </div>
      </form>
    </div>
  );
}
