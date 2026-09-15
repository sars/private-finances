import { useEffect, useId, useState } from 'react';
import { ChevronDown, LoaderCircle, Undo2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Combobox, type ComboboxOption } from '@/components/ui/combobox';
import { money, type Submit, type Transaction } from '@/lib/transactions';
import { HistoryLink } from './pieces';

type RefundCandidate = {
  id: string;
  revision: number;
  description: string;
  bookedAt: string;
  amountMinor: string;
  currency: string;
  remainingMinor: string;
  originalAmountMinor: string;
  originalCurrency: string;
  exactOriginal: boolean;
};

async function getJson<T>(url: string, signal: AbortSignal): Promise<T> {
  const response = await fetch(url, {
    signal,
    credentials: 'same-origin',
    headers: { Accept: 'application/json' },
  });
  if (!response.ok)
    throw new Error('Could not load refund candidates. Refresh to try again.');
  return response.json();
}

function Reductions({
  transaction: t,
  busy,
  submit,
}: {
  transaction: Transaction;
  busy: boolean;
  submit: Submit;
}) {
  const [unlinking, setUnlinking] = useState('');
  const reductions = t.refund?.reductions ?? [];
  if (!reductions.length) return null;
  return (
    <div className="space-y-3">
      {reductions.map((item) => (
        <div
          key={item.linkId}
          className="space-y-2 border-t pt-3 first:border-0 first:pt-0"
        >
          <p className="text-sm">
            {money(item.reductionMinor, item.currency)}{' '}
            {t.refund?.role === 'reduced' ? 'received' : 'returned'}{' '}
            {item.peerBookedAt.slice(0, 10)}
            {item.approximate && item.convertedMinor
              ? ` ≈ ${money(item.convertedMinor, t.currency)}`
              : ''}
          </p>
          <p className="text-xs text-muted-foreground">
            {item.origin === 'automatic'
              ? 'Matched automatically'
              : 'Confirmed by you'}
            {item.provisional ? ' · still settling' : ''}
          </p>
          {item.discrepancy && (
            <p
              role="status"
              className="text-xs text-amber-700 dark:text-amber-400"
            >
              An amount changed after this refund was linked. The link is kept;
              review both transaction histories.
            </p>
          )}
          <div className="flex flex-wrap items-center gap-3">
            <HistoryLink
              id={item.peerId}
              label={
                t.refund?.role === 'reduced'
                  ? 'History of the refund'
                  : 'History of the purchase'
              }
            />
            {unlinking === item.linkId ? (
              <>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  disabled={busy}
                  onClick={() =>
                    void submit('/refund/unlink', {
                      id: item.linkId,
                      revision: String(item.linkRevision),
                      reason: 'Owner removed the refund link',
                    })
                  }
                >
                  Confirm removal
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  disabled={busy}
                  onClick={() => setUnlinking('')}
                >
                  Cancel
                </Button>
              </>
            ) : (
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={busy}
                onClick={() => setUnlinking(item.linkId)}
              >
                <Undo2 className="size-3.5" />
                Undo this refund link
              </Button>
            )}
          </div>
        </div>
      ))}
    </div>
  );
}

function LinkCredit({
  transaction: t,
  busy,
  submit,
}: {
  transaction: Transaction;
  busy: boolean;
  submit: Submit;
}) {
  const id = useId();
  const [candidates, setCandidates] = useState<RefundCandidate[]>();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [attempt, setAttempt] = useState(0);
  const [debitId, setDebitId] = useState('');
  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError('');
    setDebitId('');
    getJson<{ candidates: RefundCandidate[] }>(
      `/api/refund-candidates?id=${encodeURIComponent(t.id)}`,
      controller.signal,
    )
      .then((result) => {
        if (!Array.isArray(result.candidates))
          throw new Error('invalid_refund_response');
        if (!controller.signal.aborted) setCandidates(result.candidates);
      })
      .catch(() => {
        if (!controller.signal.aborted)
          setError(
            'Could not check which purchase this returns. Try again before linking it.',
          );
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [t.id, t.revision, attempt]);
  const selected = candidates?.find((candidate) => candidate.id === debitId);
  const options: ComboboxOption[] = (candidates ?? []).map((candidate) => ({
    value: candidate.id,
    label: `${candidate.bookedAt.slice(0, 10)} · ${candidate.description || 'Purchase'}`,
    hint: money(candidate.amountMinor, candidate.currency),
    keywords: [candidate.description, candidate.bookedAt],
  }));
  if (loading)
    return (
      <p
        role="status"
        className="flex items-center gap-2 text-sm text-muted-foreground"
      >
        <LoaderCircle aria-hidden="true" className="size-4 animate-spin" />
        Checking which purchase this returns…
      </p>
    );
  if (error)
    return (
      <div className="space-y-2">
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={busy}
          onClick={() => setAttempt((value) => value + 1)}
        >
          Try again
        </Button>
      </div>
    );
  if (!options.length)
    return (
      <p className="text-sm leading-relaxed text-muted-foreground">
        No purchase on this account matches this credit. It stays visible as
        incoming money until someone explains it.
      </p>
    );
  return (
    <form
      className="space-y-3"
      onSubmit={(event) => {
        event.preventDefault();
        if (selected)
          void submit('/refund/link', {
            debitId: selected.id,
            creditId: t.id,
            debitRevision: String(selected.revision),
            creditRevision: String(t.revision),
            reason:
              'Owner confirmed this credit returned the selected purchase',
          });
      }}
    >
      <p className="text-sm leading-relaxed text-muted-foreground">
        Attach this credit to the purchase it returns. The purchase keeps its
        bank amount and its category; only what it finally cost changes.
      </p>
      <Label htmlFor={`${id}-debit`}>Choose the purchase</Label>
      <Combobox
        id={`${id}-debit`}
        options={options}
        value={debitId}
        onChange={setDebitId}
        placeholder="Choose the purchase this returns"
        searchPlaceholder="Search by merchant or date…"
        emptyText="No purchase matches that search."
        disabled={busy}
      />
      {selected && (
        <div className="space-y-2 rounded-lg bg-muted/40 p-3">
          <p className="text-sm font-medium break-words">
            {selected.description || 'Purchase'}
          </p>
          <p className="text-xs text-muted-foreground">
            {selected.bookedAt.slice(0, 10)} ·{' '}
            {money(selected.amountMinor, selected.currency)} ·{' '}
            {money(selected.remainingMinor, selected.currency)} not yet returned
          </p>
          <p className="text-xs leading-relaxed text-muted-foreground">
            {selected.exactOriginal
              ? `The merchant charged and returned ${money(selected.originalAmountMinor.replace('-', ''), selected.originalCurrency)}.`
              : 'The amounts differ; confirm only if this credit belongs to this purchase.'}
          </p>
          <HistoryLink id={selected.id} label="History of the purchase" />
        </div>
      )}
      <Button
        type="submit"
        variant="outline"
        className="w-full"
        disabled={busy || !selected}
      >
        Link this refund
      </Button>
    </form>
  );
}

/**
 * Everything about money that came back, in one place. The headline amount
 * already says what the payment finally cost, so this stays closed until it is
 * either needed for an action or opened on purpose.
 */
export function RefundPanel({
  transaction: t,
  busy,
  submit,
}: {
  transaction: Transaction;
  busy: boolean;
  submit: Submit;
}) {
  const incoming = /^\d+$/.test(t.amountMinor) && BigInt(t.amountMinor) > 0n;
  const reductions = t.refund?.reductions ?? [];
  const linked = reductions.length > 0;
  // A credit the bank is still holding can still change, so it is shown but not
  // yet offered for linking. Links that already exist stay visible either way.
  const needsAction = incoming && !linked && t.status === 'booked';
  if (!incoming && !linked) return null;
  const summary = t.refund;
  return (
    <details
      open={needsAction}
      className="group rounded-xl border"
      aria-label="Refunds"
    >
      <summary className="flex min-h-12 cursor-pointer list-none items-center justify-between gap-2 px-4 py-2 text-base font-semibold">
        <span className="flex items-center gap-2">
          <Undo2 className="size-4" />
          {incoming ? 'Money that came back' : 'Refunds'}
          {linked && (
            <span className="text-sm font-normal text-muted-foreground">
              ({reductions.length})
            </span>
          )}
        </span>
        <ChevronDown className="size-4 shrink-0 group-open:rotate-180" />
      </summary>
      <div className="space-y-4 border-t p-4">
        {!incoming && summary?.role === 'reduced' && (
          <>
            <p className="text-sm font-medium">
              {money(t.amountMinor, t.currency)} paid ·{' '}
              {reductions
                .map((item) => money(item.reductionMinor, item.currency))
                .join(' + ')}{' '}
              returned · {summary.approximate ? '≈ ' : ''}
              {money(summary.netMinor, t.currency)} after refunds
            </p>
            <p className="text-xs leading-relaxed text-muted-foreground">
              The bank amount is unchanged. Spending totals count what the
              payment finally cost.
              {summary.provisional
                ? ' The bank is still holding one of these amounts, so it is recalculated when it settles.'
                : ''}
              {summary.approximate
                ? ' A refund in another currency was converted at the rate for the day it arrived, so the result is close, not exact.'
                : ''}
            </p>
          </>
        )}
        {incoming && linked && (
          <>
            <p className="text-sm font-medium">
              {money(t.amountMinor, t.currency)} returned against a purchase of{' '}
              {reductions[0]!.peerBookedAt.slice(0, 10)}.
            </p>
            <p className="text-xs leading-relaxed text-muted-foreground">
              The purchase keeps the amount the bank recorded and shows this
              reduction beside it. This credit is already counted through that
              purchase, so it is normally hidden from the list.
            </p>
          </>
        )}
        {incoming && !linked && !needsAction && (
          <p className="text-sm leading-relaxed text-muted-foreground">
            The bank is still processing this credit, so its amount can change.
            It can be attached to the purchase it returns once it settles.
          </p>
        )}
        <Reductions transaction={t} busy={busy} submit={submit} />
        {needsAction && (
          <LinkCredit transaction={t} busy={busy} submit={submit} />
        )}
      </div>
    </details>
  );
}
