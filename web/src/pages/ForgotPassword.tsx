import { useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { useAuth } from '../lib/auth';
import { Button } from '../components/ui/Button';
import { Input } from '../components/ui/Input';

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
            Reset your password
          </div>
        </div>

        {sent ? (
          <div className="text-center">
            <h1 className="text-[15px] font-semibold text-ink mb-2">
              Check your email
            </h1>
            <p className="text-tiny text-ink-2 leading-relaxed mb-4">
              If an account exists for{' '}
              <span className="font-semibold text-ink">{email.trim()}</span>,
              we sent a reset link. Click the link to choose a new password.
            </p>
            <Link
              to="/login"
              className="text-tiny text-brand hover:underline font-semibold"
            >
              Back to sign in
            </Link>
          </div>
        ) : (
          <>
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
                disabled={submitting || !email.trim()}
              >
                {submitting ? 'Sending…' : 'Send reset link'}
              </Button>
            </div>

            <div className="mt-5 text-tiny text-ink-3 text-center">
              Remembered it?{' '}
              <Link
                to="/login"
                className="text-brand hover:underline font-semibold"
              >
                Sign in
              </Link>
            </div>
          </>
        )}
      </form>
    </div>
  );
}
