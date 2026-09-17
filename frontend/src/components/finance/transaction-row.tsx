import type { ReactNode } from 'react';

/**
 * One payment in a list: what it was, when and where it is filed, what it
 * cost, and what can be done with it. One dense line on desktop, two on the
 * phone. Amount and badges arrive rendered, because each screen knows what
 * they mean; this only lays them out. With `href`, the whole row opens the
 * payment on the phone and the action button is kept for wider screens.
 */
export function TransactionRow({
  mark,
  markOnPhone = false,
  description,
  href,
  meta,
  amount,
  badges,
  action,
}: {
  /** Direction or status glyph; hidden on the phone unless `markOnPhone`. */
  mark?: ReactNode;
  /** Keep the mark on the phone, for one that identifies the row (an account). */
  markOnPhone?: boolean;
  description: ReactNode;
  /** Where the row leads; on the phone the whole row is the link. */
  href?: string;
  /** Date, category, account — the small line under the description. */
  meta: ReactNode;
  amount: ReactNode;
  badges?: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div className="relative flex gap-3 border-b py-3 last:border-b-0 sm:gap-4">
      {mark && (
        <span
          className={
            markOnPhone ? 'shrink-0 pt-0.5' : 'hidden shrink-0 pt-0.5 sm:block'
          }
        >
          {mark}
        </span>
      )}
      <div className="min-w-0 flex-1">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <p className="text-sm font-medium break-words [overflow-wrap:anywhere]">
              {href ? (
                <a
                  href={href}
                  className="after:absolute after:inset-0 after:content-[''] sm:after:hidden"
                >
                  {description}
                </a>
              ) : (
                description
              )}
            </p>
            <p className="mt-0.5 text-xs text-muted-foreground">{meta}</p>
          </div>
          <div className="shrink-0 text-right text-sm font-semibold tabular-nums">
            {amount}
          </div>
        </div>
        {(badges || action) && (
          <div className="mt-2 flex flex-wrap items-center justify-between gap-2">
            <div className="flex min-w-0 flex-wrap gap-1.5">{badges}</div>
            {action && (
              <div
                className={
                  href
                    ? 'relative z-10 ml-auto hidden items-center gap-3 sm:flex'
                    : 'ml-auto flex items-center gap-3'
                }
              >
                {action}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
