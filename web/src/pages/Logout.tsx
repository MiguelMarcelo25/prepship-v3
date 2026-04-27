import { useEffect } from 'react';
import { Navigate } from 'react-router-dom';
import { useAuth } from '../lib/auth';

export default function Logout() {
  const { session, signOut, loading } = useAuth();

  useEffect(() => {
    if (session) void signOut();
  }, [session, signOut]);

  if (loading) {
    return (
      <div className="flex-1 w-full min-h-screen flex items-center justify-center bg-page text-ink-3">
        Signing out…
      </div>
    );
  }

  return <Navigate to="/login" replace />;
}
