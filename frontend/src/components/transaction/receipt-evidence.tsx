import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Camera, ExternalLink, Receipt as ReceiptIcon } from 'lucide-react';
import { apiGet } from '@/lib/query';
import { money, type Owner } from '@/lib/transactions';

type LinkedReceipt = {
  id: string;
  mime?: string | null;
  extraction: {
    merchant: string | null;
    amountMinor: string | null;
    currency: string | null;
    items: unknown[];
  } | null;
};

function itemText(item: unknown) {
  if (typeof item === 'string') return item;
  const row =
    typeof item === 'object' && item !== null
      ? (item as Record<string, unknown>)
      : {};
  if (typeof row.description === 'string') return row.description;
  if (typeof row.name === 'string') return row.name;
  return 'Receipt item';
}

/** The photo beside what was read from it, so the reading can be checked. */
function Thumbnail({ id }: { id: string }) {
  const [broken, setBroken] = useState(false);
  const href = `/receipts?receiptId=${encodeURIComponent(id)}`;
  if (broken)
    return (
      <a
        href={href}
        className="flex size-24 shrink-0 items-center justify-center rounded-md border bg-muted/40 text-muted-foreground"
        aria-label="Open the receipt photo"
      >
        <Camera className="size-5" />
      </a>
    );
  return (
    <a href={href} className="shrink-0" aria-label="Open the receipt photo">
      <img
        src={`/api/receipt-image?id=${encodeURIComponent(id)}`}
        alt="Receipt photo"
        loading="lazy"
        onError={() => setBroken(true)}
        className="size-24 rounded-md border object-cover"
      />
    </a>
  );
}

export function ReceiptEvidence({ id, actor }: { id: string; actor: Owner }) {
  const receiptQuery = useQuery({
    queryKey: ['receipts', actor, id],
    staleTime: 0,
    refetchOnMount: 'always',
    queryFn: ({ signal }) =>
      apiGet<{ receipts: LinkedReceipt[] }>(
        '/api/receipts?transactionId=' + encodeURIComponent(id),
        signal,
      ),
  });
  const receipts = receiptQuery.data?.receipts ?? [];
  return (
    <section
      aria-label="Receipt evidence"
      className="space-y-3 rounded-lg border p-4 sm:p-5"
    >
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="flex items-center gap-2 text-base font-semibold">
          <ReceiptIcon className="size-4" />
          Receipt evidence
        </h2>
        <a
          className="text-sm underline underline-offset-4"
          href={'/receipts?transactionId=' + encodeURIComponent(id)}
        >
          Manage receipts
        </a>
      </div>
      {receiptQuery.isPending ? (
        <p className="text-sm text-muted-foreground">
          Loading linked receipts…
        </p>
      ) : receiptQuery.error ? (
        <p className="text-sm text-destructive">
          Could not load receipts.{' '}
          <button
            className="underline"
            onClick={() => void receiptQuery.refetch()}
          >
            Retry
          </button>
        </p>
      ) : receipts.length ? (
        receipts.map((receipt) => (
          <div
            key={receipt.id}
            className="flex gap-4 rounded-lg border bg-muted/20 p-3"
          >
            <Thumbnail id={receipt.id} />
            <div className="min-w-0 flex-1 space-y-2">
              <p className="text-sm font-medium break-words">
                {receipt.extraction?.merchant ?? 'Linked receipt'}
              </p>
              {receipt.extraction?.amountMinor &&
                receipt.extraction.currency && (
                  <p className="text-sm text-muted-foreground">
                    Receipt total:{' '}
                    {money(
                      receipt.extraction.amountMinor,
                      receipt.extraction.currency,
                    )}
                  </p>
                )}
              <ul className="space-y-1 text-sm text-muted-foreground">
                {(receipt.extraction?.items ?? [])
                  .slice(0, 8)
                  .map((item, index) => (
                    <li key={index} className="break-words">
                      {itemText(item)}
                    </li>
                  ))}
              </ul>
              <a
                className="inline-flex items-center gap-1.5 text-sm underline underline-offset-4"
                href={
                  '/receipts?transactionId=' +
                  encodeURIComponent(id) +
                  '&receiptId=' +
                  encodeURIComponent(receipt.id)
                }
              >
                <ExternalLink className="size-3.5" />
                Open the receipt and all its items
              </a>
            </div>
          </div>
        ))
      ) : (
        <p className="text-sm text-muted-foreground">
          No receipt linked yet. Photos sent to the family Telegram chat can be
          attached here.
        </p>
      )}
    </section>
  );
}
