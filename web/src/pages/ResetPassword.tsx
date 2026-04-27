import { useEffect, useState, type FormEvent } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { Eye, EyeOff } from 'lucide-react';
import { useAuth } from '../lib/auth';
import { Button } from '../components/ui/Button';
import { Input } from '../components/ui/Input';

export default function ResetPassword() {
  const { updatePassword, session, loading } = useAuth();
  const navigate = useNavigate();
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [done, setDone] = useState(false);

  // After a successful update, sit on the success screen for a moment so the
  // user sees confirmation, then send them to /login.
  useEffect(() => {
    if (!done) return;
    const t = window.setTimeout(() => {
      navigate('/login', { replace: true });
    }, 2500);
    return () => window.clearTimeout(t);
  }, [done, navigate]);

  if (loading) {
    return (
      <div className="flex-1 w-full min-h-screen flex items-center justify-center bg-page text-ink-3">
        Loading…
      </div>
    );
  }

  // Supabase exchanges the recovery token in the URL for a session
  // automatically (detectSessionInUrl: true). If there's no session here,
  // the link is invalid or expired.
  if (!session && !done) {
    return (
      <div className="flex-1 w-full min-h-screen flex items-center justify-center bg-page px-4">
        <div className="w-full max-w-sm bg-white rounded-card border border-line shadow-sm p-6 text-center">
          <div className="flex items-baseline justify-center text-[24px] font-extrabold tracking-[-0.5px] mb-4">
            <span className="text-ink">PREP</span>
            <span className="text-brand">SHIP</span>
          </div>
          <h1 className="text-[15px] font-semibold text-ink mb-2">
            Reset link invalid
          </h1>
          <p className="text-tiny text-ink-2 leading-relaxed mb-4">
            This password reset link is missing or expired. Request a new one
            and try again.
          </p>
          <Link
            to="/forgot-password"
            className="text-tiny text-brand hover:underline font-semibold"
          >
            Request a new link
          </Link>
        </div>
      </div>
    );
  }

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
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
      await updatePassword(password);
      setDone(true);
    } catch (err) {
      setError((err as Error).message ?? 'Could not update password');
    } finally {
      setSubmitting(false);
    }
  };

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
            Choose a new password
          </div>
        </div>

        {done ? (
          <div className="text-center">
            <h1 className="text-[15px] font-semibold text-ink mb-2">
              Password updated
            </h1>
            <p className="text-tiny text-ink-2 leading-relaxed">
              Redirecting to sign in…
            </p>
          </div>
        ) : (
          <div className="space-y-3">
            <div>
              <label className="section-label block mb-1.5">New password</label>
              <div className="relative">
                <Input
                  type={showPassword ? 'text' : 'password'}
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  autoComplete="new-password"
                  required
                  autoFocus
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
              <label className="section-label block mb-1.5">
                Confirm new password
              </label>
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
              disabled={submitting || !password || !confirm}
            >
              {submitting ? 'Updating…' : 'Update password'}
            </Button>
          </div>
        )}
      </form>
    </div>
  );
}
