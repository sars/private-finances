import { useQuery } from '@tanstack/react-query';
import { apiGet, useSession, invalidateFinancialData } from './lib/query';
import { useUrlSearch, useSearchPatch } from './lib/navigation';
import { useEffect, useState } from 'react';
import {
  CircleAlert,
  FileText,
  Image,
  Link2,
  LoaderCircle,
  ReceiptText,
  RefreshCw,
  Trash2,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Skeleton } from '@/components/ui/skeleton';
import { ownerName } from './lib/account-visuals';
type Receipt = {
  id: string;
  state: string;
  owner: string;
  transaction_owner: string | null;
  transaction_category: string | null;
  category_check: string | null;
  extraction: {
    merchant: string | null;
    date: string | null;
    amountMinor: string | null;
    currency: string | null;
    items: unknown[];
  } | null;
  transaction_id: string | null;
  mime: string | null;
  reason: string | null;
  settlement_difference: {
    receiptAmountMinor: string | null;
    receiptCurrency: string | null;
    paymentAmountMinor: string | null;
    paymentCurrency: string | null;
  } | null;
  created_at: string;
};
type Transaction = {
  id: string;
  owner: string;
  description: string;
  bookedAt: string;
  amountMinor: string;
  currency: string;
  status?: string;
};
function amount(
  value: string | null | undefined,
  currency: string | null | undefined,
) {
  if (!value || !currency || !/^[-]?\d+$/.test(value))
    return 'Amount not available';
  const exponent = (
    {
      UAH: 2,
      EUR: 2,
      USD: 2,
      GBP: 2,
      JPY: 0,
      KWD: 3,
      BHD: 3,
      PLN: 2,
      CHF: 2,
    } as Record<string, number>
  )[currency];
  if (exponent === undefined) return `Amount in ${currency}`;
  const digits = value.replace(/^-/, '').padStart(exponent + 1, '0');
  return `${value.startsWith('-') ? '−' : ''}${exponent ? `${digits.slice(0, -exponent)}.${digits.slice(-exponent)}` : digits} ${currency}`;
}
export default function Receipts() {
  const url = useUrlSearch();
  const patch = useSearchPatch();
  const transactionId = url.transactionId;
  const session = useSession();
  const actor = session.data?.actor ?? '';
  const csrf = session.data?.csrf ?? '';
  const receiptQuery = useQuery({
    queryKey: ['receipts', actor, transactionId ?? null],
    enabled: Boolean(actor),
    queryFn: ({ signal }) =>
      apiGet<{ receipts: Receipt[] }>(
        '/api/receipts' +
          (transactionId
            ? '?transactionId=' + encodeURIComponent(transactionId)
            : ''),
        signal,
      ),
  });
  const receipts = receiptQuery.data?.receipts ?? [];
  const loading = session.isPending || receiptQuery.isPending;
  const [actionError, setError] = useState('');
  const error =
    actionError || session.error?.message || receiptQuery.error?.message || '';
  const imageId = url.receiptId ?? null;
  const setImageId = (id: string | null) =>
    patch({ receiptId: id ?? undefined });
  const attachId = url.attach ?? null;
  const setAttachId = (id: string | null) => patch({ attach: id ?? undefined });
  const [query, setQuery] = useState('');
  const [debounced, setDebounced] = useState('');
  const [selected, setSelected] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(query), 250);
    return () => clearTimeout(timer);
  }, [query]);
  useEffect(() => setSelected(''), [attachId, debounced]);
  const candidates = useQuery({
    queryKey: ['receipt-candidates', actor, debounced],
    enabled: Boolean(actor && attachId),
    queryFn: ({ signal }) =>
      apiGet<{ transactions: Transaction[] }>(
        '/api/receipt-candidates?q=' + encodeURIComponent(debounced),
        signal,
      ),
  });
  const transactions = candidates.data?.transactions ?? [];
  const transactionsLoading = candidates.isFetching;
  const refresh = () => {
    setError('');
    void invalidateFinancialData();
  };
  async function action(id: string, type: 'attach' | 'rematch' | 'delete') {
    setBusy(id);
    setError('');
    try {
      const response = await fetch(`/receipts/${type}`, {
        method: 'POST',
        credentials: 'same-origin',
        body: new URLSearchParams({
          csrf,
          id,
          ...(type === 'attach' ? { transactionId: selected } : {}),
        }),
      });
      if (!response.ok)
        throw new Error(
          response.status === 409
            ? type === 'delete'
              ? 'This receipt is still being processed. Try again in a minute.'
              : 'This receipt or payment changed. Refresh and try again.'
            : 'Could not update this receipt. Please try again.',
        );
      await invalidateFinancialData();
      if (type === 'delete') setConfirmDeleteId(null);
      else setAttachId(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not update receipt.');
    } finally {
      setBusy(null);
    }
  }
  const matches = transactions;
  return (
    <div className="mx-auto max-w-5xl space-y-5 pb-8">
      <header className="flex items-start justify-between gap-3">
        <div>
          <h1 className="text-lg font-semibold tracking-tight">
            {transactionId ? 'Payment receipts' : 'Receipts'}
          </h1>
          {transactionId && (
            <a
              href="/receipts"
              className="mt-2 inline-block text-sm underline underline-offset-4"
            >
              View all receipts
            </a>
          )}
          <p className="mt-1 max-w-2xl text-sm text-muted-foreground">
            Photos sent to the family Telegram chat, matched to payments; link
            one by hand when the match is missing.
          </p>
        </div>
        <Button
          variant="outline"
          size="icon"
          aria-label="Refresh receipts"
          disabled={receiptQuery.isFetching}
          onClick={() => refresh()}
        >
          <RefreshCw className="size-4" />
        </Button>
      </header>
      {(error || candidates.error) && (
        <div role="alert" className="rounded-lg border p-4 text-sm">
          {error || candidates.error?.message}
        </div>
      )}
      {loading ? (
        <Skeleton className="h-48" />
      ) : receipts.length === 0 ? (
        <Card>
          <CardContent className="flex flex-col items-center gap-3 py-12 text-center">
            <ReceiptText className="size-7 text-muted-foreground" />
            <h2 className="font-medium">
              {transactionId
                ? 'No receipt linked yet'
                : 'No receipt photos yet'}
            </h2>
            <p className="max-w-md text-sm text-muted-foreground">
              {transactionId
                ? 'Open all family receipts to link a photo, or wait for an automatic match once the payment appears.'
                : 'Send a clear photo showing the merchant, date and total to the paired Telegram chat. You can review the result here.'}
            </p>
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-3">
          {receipts.map((receipt) => (
            <Card key={receipt.id}>
              <CardContent className="space-y-4 p-4 sm:p-5">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="min-w-0">
                    <h2 className="break-words font-medium">
                      {receipt.extraction?.merchant || 'Receipt photo'}
                    </h2>
                    <p className="mt-1 text-sm text-muted-foreground">
                      {receipt.extraction?.date || 'Date not identified'} ·{' '}
                      {amount(
                        receipt.extraction?.amountMinor,
                        receipt.extraction?.currency,
                      )}
                    </p>
                  </div>
                  <Badge
                    variant={receipt.transaction_id ? 'secondary' : 'outline'}
                  >
                    {receipt.transaction_id
                      ? 'Linked'
                      : receipt.state === 'pending'
                        ? 'Waiting for a match'
                        : receipt.state === 'duplicate'
                          ? 'Duplicate'
                          : receipt.state.replaceAll('_', ' ')}
                  </Badge>
                </div>
                {receipt.reason && (
                  <p className="break-words text-sm text-muted-foreground">
                    {receipt.reason === 'unresolved'
                      ? 'Waiting for one unique payment with a matching amount and merchant, on the same day, or within three days for Wise/Revolut bookings.'
                      : receipt.reason === 'receipt_pdf_too_many_pages'
                        ? 'This PDF has too many pages to read. Please send the receipt page only.'
                        : receipt.reason === 'receipt_pdf_render_failed'
                          ? 'I could not read this PDF. Please send a photo of the receipt instead.'
                          : receipt.reason === 'duplicate_image' ||
                              receipt.reason === 'duplicate_receipt' ||
                              receipt.reason === 'duplicate_payment'
                            ? 'Looks like a receipt you already sent (same merchant, date and total).'
                            : receipt.reason.replaceAll('_', ' ')}
                  </p>
                )}
                {receipt.settlement_difference && (
                  <div
                    role="note"
                    className="flex items-start gap-3 rounded-lg border border-warning/40 bg-warning/10 p-3 text-sm"
                  >
                    <CircleAlert className="mt-0.5 size-4 shrink-0 text-warning" />
                    <div className="min-w-0">
                      <p className="font-medium">
                        This payment settled at a different amount than the
                        receipt total. The receipt is still linked.
                      </p>
                      <p className="mt-1 break-words text-muted-foreground">
                        Receipt total{' '}
                        {amount(
                          receipt.settlement_difference.receiptAmountMinor,
                          receipt.settlement_difference.receiptCurrency,
                        )}
                        {' · '}Payment settled at{' '}
                        {amount(
                          receipt.settlement_difference.paymentAmountMinor,
                          receipt.settlement_difference.paymentCurrency,
                        )}
                        . Check it and change the link if it is wrong.
                      </p>
                    </div>
                  </div>
                )}
                <p className="text-xs text-muted-foreground">
                  Uploaded by {ownerName(receipt.owner)}
                  {receipt.transaction_owner
                    ? ` · Payment by ${ownerName(receipt.transaction_owner)}`
                    : ''}
                </p>
                {receipt.transaction_id &&
                  receipt.transaction_owner === actor && (
                    <a
                      className="inline-flex items-center gap-1.5 text-sm underline underline-offset-4"
                      href={`/review?id=${encodeURIComponent(receipt.transaction_id)}&all=1&window=all`}
                    >
                      <Link2 className="size-3.5" />
                      View linked payment
                    </a>
                  )}
                {receipt.transaction_id && (
                  <div className="rounded-md border px-3 py-2 text-sm">
                    <p className="font-medium">
                      Category: {receipt.transaction_category || 'Needs review'}
                    </p>
                    <p className="mt-1 text-muted-foreground">
                      {receipt.category_check === 'applied'
                        ? 'Categorized using this receipt.'
                        : receipt.category_check === 'protected'
                          ? 'Your saved decision or account rule takes priority.'
                          : receipt.category_check === 'needs_review'
                            ? 'Receipt checked; evidence is not clear enough for an automatic change.'
                            : 'Attached receipt evidence is considered automatically. Your manual choices stay protected.'}
                    </p>
                  </div>
                )}
                {receipt.extraction &&
                  Array.isArray(receipt.extraction.items) &&
                  receipt.extraction.items.length > 0 && (
                    <details className="text-sm">
                      <summary className="cursor-pointer text-muted-foreground">
                        Extracted items ({receipt.extraction.items.length})
                      </summary>
                      <ul className="mt-2 space-y-1">
                        {receipt.extraction.items
                          .slice(0, 100)
                          .map((item, index) => {
                            const row =
                              typeof item === 'object' && item !== null
                                ? (item as Record<string, unknown>)
                                : {};
                            return (
                              <li key={index} className="break-words">
                                {typeof item === 'string'
                                  ? item
                                  : typeof row.description === 'string'
                                    ? row.description
                                    : typeof row.name === 'string'
                                      ? row.name
                                      : 'Item'}
                                {typeof row.amountMinor === 'string'
                                  ? ` · ${amount(row.amountMinor, receipt.extraction?.currency)}`
                                  : ''}
                              </li>
                            );
                          })}
                      </ul>
                    </details>
                  )}
                <div className="flex flex-wrap gap-2">
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() =>
                      setImageId(imageId === receipt.id ? null : receipt.id)
                    }
                  >
                    <Image className="size-4" />
                    {receipt.mime === 'application/pdf'
                      ? imageId === receipt.id
                        ? 'Hide first page'
                        : 'View first page'
                      : imageId === receipt.id
                        ? 'Hide photo'
                        : 'View photo'}
                  </Button>
                  {receipt.mime === 'application/pdf' && (
                    <a
                      className="inline-flex items-center gap-1.5 rounded-md border px-3 py-1.5 text-sm underline underline-offset-4"
                      href={`/api/receipt-file?id=${encodeURIComponent(receipt.id)}`}
                      target="_blank"
                      rel="noopener noreferrer"
                    >
                      <FileText className="size-4" />
                      Open PDF
                    </a>
                  )}
                  {receipt.state !== 'duplicate' && (
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={busy !== null || !receipt.extraction}
                      onClick={() => {
                        setQuery('');
                        setAttachId(
                          attachId === receipt.id ? null : receipt.id,
                        );
                      }}
                    >
                      <Link2 className="size-4" />
                      {receipt.transaction_id
                        ? 'Change payment'
                        : 'Link payment'}
                    </Button>
                  )}
                  {!receipt.transaction_id && receipt.state !== 'duplicate' && (
                    <Button
                      variant="ghost"
                      size="sm"
                      disabled={busy !== null || !receipt.extraction}
                      onClick={() => action(receipt.id, 'rematch')}
                    >
                      {busy === receipt.id ? (
                        <LoaderCircle className="size-4 animate-spin" />
                      ) : (
                        <RefreshCw className="size-4" />
                      )}
                      Try matching again
                    </Button>
                  )}
                  <Button
                    variant="ghost"
                    size="sm"
                    disabled={busy !== null || receipt.state === 'processing'}
                    onClick={() =>
                      setConfirmDeleteId(
                        confirmDeleteId === receipt.id ? null : receipt.id,
                      )
                    }
                  >
                    <Trash2 className="size-4" />
                    Delete
                  </Button>
                </div>
                {confirmDeleteId === receipt.id && (
                  <div className="space-y-4 rounded-lg border p-4">
                    <p className="text-sm">
                      Delete this receipt photo? It will be unlinked from any
                      payment and the photo removed. This cannot be undone.
                    </p>
                    <div className="flex flex-wrap gap-2">
                      <Button
                        variant="destructive"
                        size="sm"
                        disabled={busy !== null}
                        onClick={() => action(receipt.id, 'delete')}
                      >
                        {busy === receipt.id && (
                          <LoaderCircle className="size-4 animate-spin" />
                        )}
                        Delete
                      </Button>
                      <Button
                        variant="ghost"
                        size="sm"
                        disabled={busy !== null}
                        onClick={() => setConfirmDeleteId(null)}
                      >
                        Cancel
                      </Button>
                    </div>
                  </div>
                )}
                {imageId === receipt.id && (
                  <img
                    src={`/api/receipt-image?id=${encodeURIComponent(receipt.id)}`}
                    alt={
                      receipt.mime === 'application/pdf'
                        ? 'First page of the receipt PDF, for visual verification'
                        : 'Receipt photo for visual verification'
                    }
                    className="max-h-[32rem] w-full rounded-md border object-contain"
                    onError={() =>
                      setError('This receipt photo could not be loaded.')
                    }
                  />
                )}
                {attachId === receipt.id && (
                  <div className="space-y-4 rounded-lg border p-4">
                    <Label htmlFor={`receipt-search-${receipt.id}`}>
                      Find the payment
                    </Label>
                    <Input
                      id={`receipt-search-${receipt.id}`}
                      value={query}
                      onChange={(e) => {
                        setQuery(e.target.value);
                        setSelected('');
                      }}
                      placeholder="Search merchant"
                    />
                    {transactionsLoading ? (
                      <p className="text-sm text-muted-foreground">
                        Loading payments…
                      </p>
                    ) : (
                      <>
                        <Label htmlFor={`receipt-payment-${receipt.id}`}>
                          Matching payments
                        </Label>
                        <select
                          id={`receipt-payment-${receipt.id}`}
                          value={selected}
                          onChange={(e) => setSelected(e.target.value)}
                          className="h-10 w-full min-w-0 rounded-md border bg-background px-2 text-sm"
                        >
                          <option value="">Choose a payment</option>
                          {matches.slice(0, 60).map((t) => (
                            <option key={t.id} value={t.id}>
                              {ownerName(t.owner)} · {t.bookedAt.slice(0, 10)} ·{' '}
                              {t.description} ·{' '}
                              {amount(t.amountMinor, t.currency)}
                              {t.status === 'pending' ? ' · Pending' : ''}
                            </option>
                          ))}
                        </select>
                        <p className="text-xs text-muted-foreground">
                          {matches.length === 0
                            ? 'No payments match this search.'
                            : matches.length > 60
                              ? `${matches.length} matches. Narrow the search to find your payment.`
                              : 'Check the merchant, date and amount before linking.'}
                        </p>
                      </>
                    )}
                    <div className="flex gap-2">
                      <Button
                        size="sm"
                        disabled={
                          !selected || busy !== null || transactionsLoading
                        }
                        onClick={() => action(receipt.id, 'attach')}
                      >
                        {busy === receipt.id && (
                          <LoaderCircle className="size-4 animate-spin" />
                        )}
                        Attach to payment
                      </Button>
                      <Button
                        variant="ghost"
                        size="sm"
                        disabled={busy !== null}
                        onClick={() => setAttachId(null)}
                      >
                        Cancel
                      </Button>
                    </div>
                  </div>
                )}
              </CardContent>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}
