import { useQuery } from '@tanstack/react-query';
import { useRouterState } from '@tanstack/react-router';
import { useState } from 'react';
import { ArrowLeft } from 'lucide-react';
import { apiGet, useSession, invalidateFinancialData } from './lib/query';
import { useDisplayCurrency } from './lib/display-currency';
import type { Action, ReviewData } from './lib/transactions';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { PaymentView } from '@/components/transaction/detail';

/**
 * One payment, read: /transactions/:id. Reviewing it is one click away on the
 * review page; this page only shows what is known.
 */
export default function Payment() {
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const id = pathname.split('/')[2] ?? '';
  const session = useSession();
  const identity = session.data;
  const actor = identity?.actor;
  const { currency: displayCurrency } = useDisplayCurrency();
  const detail = useQuery({
    queryKey: ['review-detail', actor, id, displayCurrency],
    enabled: Boolean(actor && id),
    staleTime: 0,
    refetchOnMount: 'always',
    queryFn: ({ signal }) =>
      apiGet<ReviewData>(
        '/api/review?detailOnly=1&id=' +
          encodeURIComponent(id) +
          '&display=' +
          displayCurrency,
        signal,
      ),
  });
  const transaction = detail.data?.transactions.find((t) => t.id === id);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState('');
  const [error, setError] = useState('');
  // The refund block is the one thing here that can change a payment.
  const submit = async (action: Action, values: Record<string, string>) => {
    if (!identity || busy) return;
    setBusy(true);
    setError('');
    setNotice('');
    try {
      const response = await fetch(action, {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          ...values,
          csrf: identity.csrf,
          owner: identity.actor,
        }),
      });
      if (!response.ok)
        throw new Error(
          response.status === 409
            ? 'This payment changed. Refresh this payment before saving again.'
            : 'The action could not be confirmed. Refresh and check the latest state before trying again.',
        );
      setNotice(
        action === '/refund/unlink'
          ? 'Refund link removed. Both bank transactions remain in your history.'
          : 'Refund linked. It reduces what the purchase cost; both bank records are unchanged.',
      );
      await invalidateFinancialData();
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : 'Could not confirm the action. Refresh before trying again.',
      );
    } finally {
      setBusy(false);
    }
  };
  const back = (
    <Button
      variant="ghost"
      render={<a href={`/transactions?display=${displayCurrency}`} />}
    >
      <ArrowLeft className="size-4" />
      Back to transactions
    </Button>
  );
  if (!transaction || !identity || !detail.data)
    return (
      <div className="space-y-6">
        {back}
        {detail.isPending || session.isPending ? (
          <Skeleton className="h-64 rounded-lg" />
        ) : (
          <section className="space-y-3 rounded-lg border p-5">
            <h1 className="text-lg font-semibold tracking-tight">Payment</h1>
            <p className="text-sm">
              {detail.error?.message ??
                'This payment is not available to this account.'}
            </p>
            {detail.error && (
              <Button onClick={() => void detail.refetch()}>Retry</Button>
            )}
          </section>
        )}
      </div>
    );
  return (
    <div className="space-y-4">
      {notice && (
        <p role="status" className="rounded-lg border bg-muted/30 p-3 text-sm">
          {notice}
        </p>
      )}
      {(error || detail.error) && (
        <p role="alert" className="text-sm text-destructive">
          {error ||
            'Could not refresh this payment. Previously loaded information is kept below.'}
        </p>
      )}
      <PaymentView
        transaction={transaction}
        data={detail.data}
        identity={identity}
        displayCurrency={displayCurrency}
        busy={busy}
        refreshing={detail.isFetching}
        onRefresh={() => void detail.refetch()}
        submit={submit}
        back={back}
      />
    </div>
  );
}
