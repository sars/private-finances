import { useEffect, useRef, useState } from 'react';
import { Check, RefreshCw } from 'lucide-react';
import { invalidateFinancialData } from '@/lib/query';

/**
 * Pull the page down at the top to re-read everything from the server — the
 * gesture every phone application has, doing exactly what the Refresh button
 * does on a desktop.
 *
 * It is written here rather than taken from a package. The two maintained ones
 * are a styled widget that would have to be re-skinned to match this design
 * system, and a bare hook about the size of this file; neither knows that this
 * app scrolls the document itself, sits under a notch, and must not fire while
 * a dialog has the page locked. Ninety lines we own were the smaller cost.
 *
 * Only a finger gets it. A desktop keeps its button, and the two never both
 * appear: this arms on `(pointer: coarse)` and the button hides on the same
 * test.
 */

/** How far the finger travels before the pull is taken as a refresh. */
const THRESHOLD = 64;
/** The pull is deliberately heavier than the finger: half a pixel per pixel. */
const RESISTANCE = 0.5;
/** Where the indicator rests while the data is being re-read. */
const RESTING = 28;
const MAX = 84;

/** Something above the page has taken the scroll: a dialog, a sheet, a menu. */
function pageIsLocked(target: Element | null) {
  if (document.querySelector('[role="dialog"],[role="alertdialog"]'))
    return true;
  const overflow = getComputedStyle(document.body).overflow;
  if (overflow === 'hidden') return true;
  // A list that scrolls sideways (the analytics grid) owns its own gestures.
  for (let node = target; node; node = node.parentElement) {
    if (node.scrollWidth > node.clientWidth + 1) {
      const x = getComputedStyle(node).overflowX;
      if (x === 'auto' || x === 'scroll') return true;
    }
  }
  return false;
}

export function PullToRefresh() {
  const indicator = useRef<HTMLDivElement>(null);
  const [phase, setPhase] = useState<'idle' | 'refreshing' | 'done'>('idle');
  const refreshing = useRef(false);

  useEffect(() => {
    if (!matchMedia('(pointer: coarse)').matches) return;
    const node = indicator.current;
    if (!node) return;

    let startY = 0;
    let startX = 0;
    let tracking = false;
    let engaged = false;
    let pull = 0;

    // While the finger is down the indicator fades in with the pull; once the
    // refresh is under way it is fully drawn, however short the pull was.
    const place = (distance: number, animate: boolean, opacity?: number) => {
      const progress = Math.min(1, distance / THRESHOLD);
      node.style.transition = animate
        ? 'transform 200ms ease-out, opacity 200ms ease-out'
        : 'none';
      node.style.transform = `translateY(${distance}px)`;
      node.style.opacity = String(opacity ?? Math.min(1, progress * 1.4));
      node.style.setProperty('--pull-turn', `${progress * 360}deg`);
    };

    const settle = () => {
      tracking = false;
      engaged = false;
      pull = 0;
      place(0, true);
    };

    const onStart = (event: TouchEvent) => {
      if (refreshing.current || event.touches.length !== 1) return;
      const scroller = document.scrollingElement ?? document.documentElement;
      if (scroller.scrollTop > 0) return;
      const target =
        event.target instanceof Element
          ? event.target
          : ((event.target as Node | null)?.parentElement ?? null);
      if (pageIsLocked(target)) return;
      startY = event.touches[0].clientY;
      startX = event.touches[0].clientX;
      tracking = true;
      engaged = false;
    };

    const onMove = (event: TouchEvent) => {
      if (!tracking || refreshing.current) return;
      const dy = event.touches[0].clientY - startY;
      const dx = event.touches[0].clientX - startX;
      const scroller = document.scrollingElement ?? document.documentElement;
      if (dy <= 0 || Math.abs(dx) > Math.abs(dy) || scroller.scrollTop > 0) {
        if (engaged) settle();
        else tracking = false;
        return;
      }
      if (!engaged && dy < 8) return;
      engaged = true;
      // Claim the gesture: without this the page rubber-bands underneath the
      // indicator and the two move at different speeds.
      if (event.cancelable) event.preventDefault();
      pull = Math.min(MAX, dy * RESISTANCE);
      place(pull, false);
    };

    const onEnd = () => {
      if (!engaged) {
        tracking = false;
        return;
      }
      if (pull < THRESHOLD) {
        settle();
        return;
      }
      tracking = false;
      engaged = false;
      refreshing.current = true;
      setPhase('refreshing');
      place(RESTING, true, 1);
      void Promise.all([
        invalidateFinancialData(),
        // Long enough to be read as an answer rather than a flicker.
        new Promise((resolve) => setTimeout(resolve, 500)),
      ])
        .catch(() => {})
        .then(() => {
          setPhase('done');
          setTimeout(() => {
            refreshing.current = false;
            pull = 0;
            place(0, true, 0);
            setPhase('idle');
          }, 700);
        });
    };

    document.addEventListener('touchstart', onStart, { passive: true });
    document.addEventListener('touchmove', onMove, { passive: false });
    document.addEventListener('touchend', onEnd, { passive: true });
    document.addEventListener('touchcancel', settle, { passive: true });
    return () => {
      document.removeEventListener('touchstart', onStart);
      document.removeEventListener('touchmove', onMove);
      document.removeEventListener('touchend', onEnd);
      document.removeEventListener('touchcancel', settle);
    };
  }, []);

  return (
    <>
      <div
        ref={indicator}
        aria-hidden
        style={{ opacity: 0, transform: 'translateY(0)' }}
        className="pointer-events-none fixed inset-x-0 top-[calc(env(safe-area-inset-top)+3.5rem)] z-50 flex justify-center pointer-fine:hidden"
      >
        <div className="flex size-9 items-center justify-center rounded-full border bg-background shadow-md">
          {phase === 'done' ? (
            <Check className="size-4 text-positive" />
          ) : (
            <RefreshCw
              className={`size-4 text-muted-foreground ${phase === 'refreshing' ? 'animate-spin' : ''}`}
              style={
                phase === 'refreshing'
                  ? undefined
                  : { transform: 'rotate(var(--pull-turn, 0deg))' }
              }
            />
          )}
        </div>
      </div>
      <span role="status" aria-live="polite" className="sr-only">
        {phase === 'refreshing'
          ? 'Refreshing'
          : phase === 'done'
            ? 'Updated'
            : ''}
      </span>
    </>
  );
}
