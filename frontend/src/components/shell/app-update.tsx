import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { RefreshCw } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import {
  POLL_INTERVAL_MS,
  applyUpdate,
  checkForUpdate,
  useUpdateReady,
} from '@/lib/app-update';

/**
 * The household's two ways to move to a new release: a prompt that appears on
 * its own when one lands, and a button that asks on demand.
 *
 * Both are needed. The prompt is what makes a release arrive without anyone
 * thinking about it, but an installed app is easy to dismiss a toast in and
 * then wonder about, so the same answer is always available from the sidebar
 * footer, beside the version the app is actually running.
 *
 * `lib/app-update.ts` explains why an installed app needs any of this.
 */
export function AppUpdate({ release }: { release?: string }) {
  const ready = useUpdateReady();
  const [checking, setChecking] = useState(false);

  // While the app is in the foreground. Coming back from the background is
  // handled where the rest of the returning-to-the-app work lives, in main.tsx.
  useEffect(() => {
    const timer = window.setInterval(
      () => void checkForUpdate(),
      POLL_INTERVAL_MS,
    );
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    if (!ready) return;
    toast('A new version is ready', {
      id: 'app-update',
      description: 'Your work is saved; updating takes a moment.',
      duration: Infinity,
      action: { label: 'Update', onClick: () => applyUpdate() },
    });
  }, [ready]);

  const check = async () => {
    setChecking(true);
    try {
      if (!(await checkForUpdate()))
        toast('This is the latest version', { id: 'app-update' });
    } finally {
      setChecking(false);
    }
  };

  return (
    <div className="flex items-center justify-between gap-2 border-t pt-3">
      {/* The sidebar is narrow and the button beside this is wide, so the
          version has to keep to one line or it wraps under its own label. */}
      <span className="truncate text-xs whitespace-nowrap text-muted-foreground">
        Version {release ? release.slice(0, 7) : '—'}
      </span>
      {ready ? (
        <Button type="button" size="sm" onClick={() => applyUpdate()}>
          Update
        </Button>
      ) : (
        <Button
          type="button"
          size="sm"
          variant="ghost"
          disabled={checking}
          title="Check for updates"
          aria-label="Check for updates"
          onClick={() => void check()}
        >
          <RefreshCw className={cn('size-3.5', checking && 'animate-spin')} />
          {checking ? 'Checking…' : 'Check'}
        </Button>
      )}
    </div>
  );
}
