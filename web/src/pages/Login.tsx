import { useState, type FormEvent } from 'react';
import { Link, useLocation, useNavigate, Navigate } from 'react-router-dom';
import { Eye, EyeOff, Mail, Lock } from 'lucide-react';
import { useAuth } from '../lib/auth';
import { Button } from '../components/ui/Button';
import { Input } from '../components/ui/Input';
import AuthLayout from '../components/AuthLayout';

export default function Login() {
  const { signIn, session, loading } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  if (loading) {
    return (
      <div className="flex-1 w-full min-h-screen flex items-center justify-center bg-page text-ink-3">
        Loading…
      </div>
    );
  }

  if (session) {
    const from = (location.state as { from?: { pathname: string } } | null)?.from?.pathname;
    return <Navigate to={from ?? '/'} replace />;
  }

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    const cleanEmail = email.trim();
    if (!cleanEmail || !password) {
      setError('Email and password are required.');
      return;
    }
    setSubmitting(true);
    try {
      await signIn(cleanEmail, password);
      const from = (location.state as { from?: { pathname: string } } | null)?.from?.pathname;
      navigate(from ?? '/', { replace: true });
    } catch (err) {
      const msg = (err as Error).message ?? 'Sign-in failed';
      setError(/invalid login/i.test(msg) ? 'Invalid email or password.' : msg);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <AuthLayout
      title="Welcome back"
      subtitle="Sign in to your PrepShip account."
      footer={
        <>
          Don't have an account?{' '}
          <Link to="/signup" className="text-brand hover:underline font-semibold">
            Create one
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
            autoComplete="username"
            placeholder="you@drprepperusa.com"
            leading={<Mail size={13} />}
            required
            autoFocus
            disabled={submitting}
          />
        </div>
        <div>
          <div className="flex items-baseline justify-between mb-1.5">
            <label className="section-label">Password</label>
            <Link
              to="/forgot-password"
              className="text-tiny text-brand hover:underline font-semibold"
            >
              Forgot?
            </Link>
          </div>
          <div className="relative">
            <Input
              type={showPassword ? 'text' : 'password'}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoComplete="current-password"
              placeholder="••••••••"
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
          disabled={submitting || !email.trim() || !password}
        >
          {submitting ? 'Signing in…' : 'Sign in'}
        </Button>
      </form>
    </AuthLayout>
  );
}
