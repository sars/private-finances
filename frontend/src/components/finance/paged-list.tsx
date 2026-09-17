import { useEffect, useRef, type ReactNode } from 'react';
import { useWindowVirtualizer } from '@tanstack/react-virtual';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';

/**
 * A long list that stays light: only the rows in view are in the document,
 * the page scrolls as one, and the next page is asked for when the end
 * comes near. Rows measure themselves, so a row with many badges takes the
 * room it needs. A "Show more" button remains for anyone whose browser
 * does not report the scroll position.
 */
export function PagedList<T>({
  items,
  keyOf,
  renderRow,
  estimateSize = 72,
  hasMore,
  loadingMore,
  onLoadMore,
  loading,
  empty,
  footer,
}: {
  items: T[];
  keyOf: (item: T) => string;
  renderRow: (item: T) => ReactNode;
  /** A typical row height in pixels; rows correct it once rendered. */
  estimateSize?: number;
  hasMore: boolean;
  loadingMore: boolean;
  onLoadMore: () => void;
  /** The first page is still on its way. */
  loading?: boolean;
  /** Shown instead of the card when there is nothing to list. */
  empty?: ReactNode;
  /** A line under the list, such as how many rows the filters select. */
  footer?: ReactNode;
}) {
  const listRef = useRef<HTMLDivElement>(null);
  const sentinelRef = useRef<HTMLDivElement>(null);
  const virtualizer = useWindowVirtualizer({
    count: items.length,
    estimateSize: () => estimateSize,
    overscan: 8,
    scrollMargin: listRef.current?.offsetTop ?? 0,
    getItemKey: (index) => keyOf(items[index]!),
  });
  useEffect(() => {
    const sentinel = sentinelRef.current;
    if (!sentinel || !hasMore) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting) && !loadingMore)
          onLoadMore();
      },
      { rootMargin: '600px 0px' },
    );
    observer.observe(sentinel);
    return () => observer.disconnect();
  }, [hasMore, loadingMore, onLoadMore]);

  if (loading)
    return (
      <div role="status" aria-label="Loading payments" className="space-y-3">
        {[0, 1, 2, 3].map((n) => (
          <Skeleton key={n} className="h-16 rounded-lg" />
        ))}
      </div>
    );
  if (!items.length) return <>{empty}</>;
  const virtualRows = virtualizer.getVirtualItems();
  return (
    <div className="space-y-3">
      <Card className="gap-0 py-0 shadow-xs">
        <CardContent ref={listRef} className="px-4 py-0 sm:px-5">
          <div
            style={{
              height: virtualizer.getTotalSize(),
              position: 'relative',
            }}
          >
            {virtualRows.map((row) => (
              <div
                key={row.key}
                data-index={row.index}
                ref={virtualizer.measureElement}
                style={{
                  position: 'absolute',
                  top: 0,
                  left: 0,
                  width: '100%',
                  transform: `translateY(${row.start - virtualizer.options.scrollMargin}px)`,
                }}
              >
                {renderRow(items[row.index]!)}
              </div>
            ))}
          </div>
        </CardContent>
      </Card>
      <div ref={sentinelRef} aria-hidden="true" />
      {hasMore && (
        <Button
          variant="outline"
          className="w-full"
          disabled={loadingMore}
          onClick={onLoadMore}
        >
          {loadingMore ? 'Loading more…' : 'Show more'}
        </Button>
      )}
      {footer && (
        <p className="text-center text-xs text-muted-foreground">{footer}</p>
      )}
    </div>
  );
}
