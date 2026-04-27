import { useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { Mail, MailCheck } from 'lucide-react';
import { useAuth } from '../lib/auth';
import { Button } from '../components/ui/Button';
import { Input } from '../components/ui/Input';
import AuthLayout from '../components/AuthLayout';

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

  if (sent) {
    return (
      <AuthLayout
        title="Check your email"
        subtitle="We sent you a reset link."
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
            If an account exists for{' '}
            <span className="font-semibold text-ink">{email.trim()}</span>, we
            sent a reset link. Click the link in the email to set a new
            password.
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
      title="Reset your password"
      subtitle="Enter your email and we'll send you a reset link."
      footer={
        <>
          Remembered it?{' '}
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
          disabled={submitting || !email.trim()}
        >
          {submitting ? 'Sending…' : 'Send reset link'}
        </Button>
      </form>
    </AuthLayout>
  );
}
