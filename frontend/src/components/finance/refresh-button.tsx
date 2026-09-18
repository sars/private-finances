import { useEffect, useRef, useState } from 'react';
import { RefreshCw } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { invalidateFinancialData } from '@/lib/query';

/**
 * Re-read everything this workspace shows from the server, without the browser
 * reloading the app.
 *
 * It is hidden wherever the finger is the pointer: on a phone or a tablet the
 * pull-down gesture in the shell does the same thing and a button beside it
 * would be a website's control, not an app's. On a desktop, where there is no
 * gesture to make, it stays.
 *
 * The spin is held for a moment even when the server answers instantly. A
 * refresh that finishes in fifteen milliseconds looks exactly like a button
 * that does nothing, which is the complaint this replaces.
 */
export function RefreshButton({ className }: { className?: string }) {
  const [busy, setBusy] = useState(false);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  return (
    <Button
      variant="outline"
      size="sm"
      disabled={busy}
      className={
        className
          ? `pointer-coarse:hidden ${className}`
          : 'pointer-coarse:hidden'
      }
      onClick={() => {
        if (busy) return;
        setBusy(true);
        void Promise.all([
          invalidateFinancialData(),
          new Promise((resolve) => setTimeout(resolve, 600)),
        ]).finally(() => {
          if (alive.current) setBusy(false);
        });
      }}
    >
      <RefreshCw className={busy ? 'animate-spin' : ''} />
      Refresh
    </Button>
  );
}
