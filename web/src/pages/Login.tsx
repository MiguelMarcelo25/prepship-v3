import { useState, type FormEvent } from 'react';
import { useLocation, useNavigate, Navigate } from 'react-router-dom';
import { Eye, EyeOff } from 'lucide-react';
import { useAuth } from '../lib/auth';
import { Button } from '../components/ui/Button';
import { Input } from '../components/ui/Input';

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
      <div className="min-h-screen flex items-center justify-center bg-page text-ink-3">
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
    <div className="min-h-screen flex items-center justify-center bg-page px-4">
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
            Dr Prepper Fulfillment
          </div>
        </div>

        <div className="space-y-3">
          <div>
            <label className="section-label block mb-1.5">Email</label>
            <Input
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              autoComplete="username"
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
                autoComplete="current-password"
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
            <div className="text-danger text-tiny py-1" role="alert">
              {error}
            </div>
          )}
          <Button
            type="submit"
            variant="primary"
            size="md"
            className="w-full"
            disabled={submitting || !email.trim() || !password}
          >
            {submitting ? 'Signing in…' : 'Sign in'}
          </Button>
        </div>

        <div className="mt-5 text-tiny text-ink-3 leading-relaxed">
          Need an account? Have an admin create one from the Supabase
          dashboard — self-signup is off.
        </div>
      </form>
    </div>
  );
}
