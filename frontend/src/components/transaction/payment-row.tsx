import type { ReactNode } from 'react';
import { Receipt, Repeat2, Tag } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { AccountBadge, TransactionRow } from '@/components/finance';
import { accountIdentity } from '@/lib/account-identity';
import type { PaymentContext } from '@/lib/payments';
import { bookedMoment, kinds, type Transaction } from '@/lib/transactions';
import { DisplayAmount, HistoryLink } from './pieces';

/**
 * One payment as both lists show it: which account paid and whose it is (the
 * badge), what it was, when, where it is filed and what it cost, with the
 * facts a reviewer needs as badges. The action is the screen's: review it, or
 * open it.
 */
export function PaymentRow({
  transaction: t,
  context,
  displayCurrency,
  showKind = true,
  action,
}: {
  transaction: Transaction;
  context: PaymentContext;
  displayCurrency: string;
  /** Off where every row shares one kind, as on the review list. */
  showKind?: boolean;
  action?: ReactNode;
}) {
  const moment = bookedMoment(t.bookedAt, t.source);
  const account = accountIdentity(
    t.source,
    t.currency,
    t.spendingPolicy?.accountLabel,
  );
  const incoming = BigInt(t.amountMinor) >= 0n;
  const suggestions = context.suggestions[t.id];
  const estimate = context.estimate.get(t.id);
  const recognized = context.recognized.get(t.id);
  const tags = context.tags[t.id] ?? [];
  const receipts = context.receipts[t.id] ?? 0;
  return (
    <TransactionRow
      mark={
        <AccountBadge
          source={t.source}
          currency={t.currency}
          label={t.spendingPolicy?.accountLabel}
          owner={t.owner}
          size="md"
        />
      }
      markOnPhone
      description={t.description || 'Payment without a description'}
      meta={
        <>
          <time dateTime={moment.iso}>
            {moment.day}
            {moment.time ? ` · ${moment.time}` : ''}
          </time>
          {' · '}
          {account.name}
          {' · '}
          {t.category ||
            (incoming ? 'Money in · not spending' : 'No category yet')}
        </>
      }
      amount={
        <DisplayAmount
          transaction={t}
          reporting={context.reporting}
          requested={displayCurrency}
          className="text-sm font-semibold"
        />
      }
      badges={
        <>
          {showKind && t.kind !== 'personal_expense' && (
            <Badge variant={t.kind === 'unresolved' ? 'secondary' : 'outline'}>
              {incoming && t.kind === 'unresolved'
                ? 'Money in · not spending'
                : kinds[t.kind]}
            </Badge>
          )}
          {t.provisional && <Badge variant="secondary">Provisional</Badge>}
          {t.spendingPattern?.pattern === 'exceptional' && (
            <Badge variant="outline">
              <Repeat2 className="size-3" />
              Exceptional
            </Badge>
          )}
          {t.status === 'pending' && (
            <Badge variant="outline">Bank processing</Badge>
          )}
          {estimate && (
            <Badge variant="outline">
              Estimated: {estimate.category} ·{' '}
              {estimate.method === 'mcc' ? 'MCC' : 'AI suggestion'}
            </Badge>
          )}
          {recognized?.decision && (
            <Badge variant="secondary">
              Suggested:{' '}
              {recognized.decision.category ?? kinds[recognized.decision.kind]}
            </Badge>
          )}
          {suggestions && suggestions.rules.length > 0 && (
            <Badge variant="outline">
              {suggestions.ambiguous
                ? 'Conflicting suggestions'
                : `${suggestions.rules.length} rule suggestion${suggestions.rules.length === 1 ? '' : 's'}`}
            </Badge>
          )}
          {receipts > 0 && (
            <Badge variant="outline">
              <Receipt className="size-3" />
              {receipts === 1 ? 'Receipt' : `${receipts} receipts`}
            </Badge>
          )}
          {tags.map((tag) => (
            <Badge
              key={tag.id}
              variant="secondary"
              className="max-w-full break-words whitespace-normal"
            >
              <Tag className="size-3" />
              {tag.name}
            </Badge>
          ))}
        </>
      }
      history={<HistoryLink id={t.id} label="History" />}
      action={action}
    />
  );
}
