import { useEffect, useState, type FormEvent } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { Eye, EyeOff, Lock, CheckCircle2 } from 'lucide-react';
import { useAuth } from '../lib/auth';
import { Button } from '../components/ui/Button';
import { Input } from '../components/ui/Input';
import AuthLayout from '../components/AuthLayout';

export default function ResetPassword() {
  const { updatePassword, session, loading } = useAuth();
  const navigate = useNavigate();
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [done, setDone] = useState(false);

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

  if (!session && !done) {
    return (
      <AuthLayout
        title="Reset link invalid"
        subtitle="This link is missing or has expired."
        footer={
          <Link
            to="/forgot-password"
            className="text-brand hover:underline font-semibold"
          >
            Request a new link
          </Link>
        }
      >
        <p className="text-tiny text-ink-2 leading-relaxed">
          For your security, password reset links can only be used once and
          expire after a short time. Request a new link to continue.
        </p>
      </AuthLayout>
    );
  }

  if (done) {
    return (
      <AuthLayout title="Password updated" subtitle="Redirecting to sign in…">
        <div className="flex flex-col items-center text-center py-2">
          <div className="w-14 h-14 rounded-full bg-ok-bg border border-ok-border flex items-center justify-center mb-4">
            <CheckCircle2 size={26} className="text-ok" />
          </div>
          <p className="text-tiny text-ink-2 leading-relaxed">
            Your password has been updated. You can now sign in with the new
            password.
          </p>
        </div>
      </AuthLayout>
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
    <AuthLayout
      title="Choose a new password"
      subtitle="Pick something secure you'll remember."
    >
      <form onSubmit={submit} className="space-y-4">
        <div>
          <label className="section-label block mb-1.5">New password</label>
          <div className="relative">
            <Input
              type={showPassword ? 'text' : 'password'}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoComplete="new-password"
              placeholder="At least 8 characters"
              leading={<Lock size={13} />}
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
          disabled={submitting || !password || !confirm}
        >
          {submitting ? 'Updating…' : 'Update password'}
        </Button>
      </form>
    </AuthLayout>
  );
}
