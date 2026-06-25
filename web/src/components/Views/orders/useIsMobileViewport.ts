// PS-317: tracks whether the viewport is mobile-width (<=768px), pulled out of OrdersView.
import { useEffect, useState } from 'react';

export function useIsMobileViewport(): boolean {
  const [isMobileViewport, setIsMobileViewport] = useState(() =>
    typeof window !== 'undefined' ? window.matchMedia('(max-width: 768px)').matches : false,
  );

  useEffect(() => {
    if (typeof window === 'undefined') return;
    const query = window.matchMedia('(max-width: 768px)');
    const updateMobileViewport = () => setIsMobileViewport(query.matches);
    updateMobileViewport();
    query.addEventListener?.('change', updateMobileViewport);
    return () => query.removeEventListener?.('change', updateMobileViewport);
  }, []);

  return isMobileViewport;
}
