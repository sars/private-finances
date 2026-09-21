import { ArrowDownLeft, ArrowUpRight, History } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@/components/ui/tooltip';
import {
  replyHistoryStatus,
  replyTimestamp,
  type SavedReply as Reply,
} from '@/lib/reply-history';
import { money, type ReviewData, type Transaction } from '@/lib/transactions';

export function HistoryLink({
  id,
  label = 'Transaction history',
}: {
  id: string;
  label?: string;
}) {
  return (
    <a
      href={`/transactions/${encodeURIComponent(id)}/history`}
      className="inline-flex min-h-9 items-center gap-1.5 text-xs text-muted-foreground underline-offset-4 hover:text-foreground hover:underline"
    >
      <History className="size-3.5" />
      {label}
    </a>
  );
}

/** Which way the money went, as a mark rather than a sentence. */
export function DirectionMark({ amountMinor }: { amountMinor: string }) {
  const incoming = BigInt(amountMinor) > 0n;
  const Icon = incoming ? ArrowDownLeft : ArrowUpRight;
  return (
    <TooltipProvider>
      <Tooltip>
        <TooltipTrigger
          render={
            <span
              className={
                'flex size-7 items-center justify-center rounded-full ' +
                (incoming
                  ? 'bg-positive/10 text-positive'
                  : 'bg-muted text-muted-foreground')
              }
            />
          }
        >
          <Icon className="size-4" aria-hidden="true" />
          <span className="sr-only">{incoming ? 'Money in' : 'Money out'}</span>
        </TooltipTrigger>
        <TooltipContent>{incoming ? 'Money in' : 'Money out'}</TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}

export function DisplayAmount({
  transaction,
  reporting,
  requested,
  className,
  compact = false,
  signed = false,
}: {
  transaction: Pick<Transaction, 'id' | 'amountMinor' | 'currency' | 'refund'>;
  reporting?: ReviewData['reporting'];
  requested: string;
  className?: string;
  /** In a list row: the figure that counts, and one short word about it. */
  compact?: boolean;
  /** Prefix a plus sign on money coming in, where nothing else says so. */
  signed?: boolean;
}) {
  const row =
    reporting?.currency === requested
      ? reporting.rows.find((r) => r.id === transaction.id)
      : undefined;
  // What the payment finally cost leads, because that is what it cost. The
  // amount the bank recorded stays beside it: the net appears on no statement.
  const reduced =
    transaction.refund?.role === 'reduced' ? transaction.refund : undefined;
  const lead = className ?? 'text-2xl font-semibold tracking-tight';
  // A refunded purchase is money out however it nets, so the sign belongs only
  // on the two plain branches below.
  const plus = (minor: string) => (signed && BigInt(minor) > 0n ? '+' : '');
  if (reduced && compact)
    return (
      <span className="inline-flex flex-col items-end gap-0.5">
        <span className={lead}>
          {transaction.currency === requested || !row?.netAmountMinor
            ? money(reduced.netMinor, transaction.currency)
            : money(row.netAmountMinor, requested)}
        </span>
        <span className="text-xs font-normal text-muted-foreground">
          after refund
        </span>
      </span>
    );
  if (reduced)
    return (
      <span className="inline-flex flex-col gap-0.5">
        <span className={lead}>
          {transaction.currency === requested || !row?.netAmountMinor
            ? money(reduced.netMinor, transaction.currency)
            : money(row.netAmountMinor, requested)}
        </span>
        <span className="text-xs font-normal text-muted-foreground">
          {money(transaction.amountMinor, transaction.currency)} paid ·{' '}
          {money(reduced.reducedMinor, reduced.currency)} returned
          {reduced.provisional ? ' · still settling' : ''}
        </span>
      </span>
    );
  if (transaction.currency === requested)
    return (
      <span className={lead}>
        {plus(transaction.amountMinor)}
        {money(transaction.amountMinor, transaction.currency)}
      </span>
    );
  return (
    <span className="inline-flex flex-col gap-0.5">
      <span className={lead}>
        {row?.convertedAmountMinor != null
          ? `${row.method === 'market_estimate' ? '≈ ' : ''}${plus(row.convertedAmountMinor)}${money(row.convertedAmountMinor, requested)}`
          : row
            ? 'Conversion unavailable'
            : `Loading ${requested} conversion…`}
      </span>
      <span className="text-xs font-normal text-muted-foreground">
        Original {money(transaction.amountMinor, transaction.currency)}
      </span>
    </span>
  );
}

export function ReplyCard({
  reply,
  openPayment,
}: {
  reply: Reply;
  openPayment?: () => void;
}) {
  const status = replyHistoryStatus(reply);
  return (
    <Card className="py-0 shadow-xs">
      <CardContent className="space-y-3 p-4">
        <div className="flex flex-wrap items-start justify-between gap-2">
          <div className="flex flex-wrap items-center gap-2">
            <Badge variant="outline">{status.input}</Badge>
            <span className="text-xs text-muted-foreground">
              {reply.source === 'app' ? 'Saved in app' : 'Telegram'}
            </span>
          </div>
          <time
            dateTime={
              reply.created_at && Number.isFinite(Date.parse(reply.created_at))
                ? reply.created_at
                : undefined
            }
            className="text-xs text-muted-foreground"
          >
            {replyTimestamp(reply.created_at)}
          </time>
        </div>
        {openPayment && (
          <p className="text-sm font-medium break-words">
            {reply.transaction_description || 'Payment explanation'}
          </p>
        )}
        <p className="text-sm break-words whitespace-pre-wrap [overflow-wrap:anywhere]">
          {reply.input_text}
        </p>
        <p
          className={`text-xs ${status.needsAttention ? 'text-warning' : 'text-muted-foreground'}`}
        >
          {status.workflow}
        </p>
        {openPayment && (
          <Button size="sm" variant="outline" onClick={openPayment}>
            Open payment
          </Button>
        )}
      </CardContent>
    </Card>
  );
}
