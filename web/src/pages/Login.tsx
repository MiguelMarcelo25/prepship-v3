import { useState, type FormEvent } from 'react';
import { useLocation, useNavigate, Navigate } from 'react-router-dom';
import { useAuth } from '../lib/auth';
import { Button } from '../components/ui/Button';
import { Input } from '../components/ui/Input';

export default function Login() {
  const { signIn, session, loading } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
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
    setSubmitting(true);
    try {
      await signIn(email, password);
      const from = (location.state as { from?: { pathname: string } } | null)?.from?.pathname;
      navigate(from ?? '/', { replace: true });
    } catch (err) {
      setError((err as Error).message);
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
            />
          </div>
          <div>
            <label className="section-label block mb-1.5">Password</label>
            <Input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoComplete="current-password"
              required
            />
          </div>
          {error && (
            <div className="text-danger text-tiny py-1">{error}</div>
          )}
          <Button
            type="submit"
            variant="primary"
            size="md"
            className="w-full"
            disabled={submitting}
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
