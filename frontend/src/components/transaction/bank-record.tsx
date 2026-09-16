import { useQuery } from '@tanstack/react-query';
import {
  Building2,
  ChevronDown,
  CreditCard,
  FileText,
  Hash,
  Landmark,
  Store,
  UserRound,
} from 'lucide-react';
import type { ComponentType } from 'react';
import { apiGet, useSession } from '@/lib/query';
import type { TransactionDetails } from '@/lib/transactions';
import { Button } from '@/components/ui/button';
import {
  HoverCard,
  HoverCardContent,
  HoverCardTrigger,
} from '@/components/ui/hover-card';

function Fact({
  icon: Icon,
  label,
  children,
}: {
  icon: ComponentType<{ className?: string }>;
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex min-w-0 gap-3">
      <Icon
        aria-hidden="true"
        className="mt-0.5 size-4 shrink-0 text-muted-foreground"
      />
      <div className="min-w-0">
        <dt className="text-xs text-muted-foreground">{label}</dt>
        <dd className="mt-0.5 text-sm break-words [overflow-wrap:anywhere]">
          {children}
        </dd>
      </div>
    </div>
  );
}

/**
 * What the bank said about this payment: the few facts that help a person place
 * it, laid out to be read, and the complete record kept collapsed underneath
 * for when the formatted view is not enough.
 */
export function BankRecord({
  id,
  cash = false,
}: {
  id: string;
  cash?: boolean;
}) {
  const { data: session } = useSession();
  const result = useQuery({
    queryKey: ['transaction-details', session?.actor, id],
    enabled: Boolean(session),
    queryFn: ({ signal }) =>
      apiGet<{ details: TransactionDetails }>(
        '/api/transaction-details?id=' + encodeURIComponent(id),
        signal,
      ),
  });
  const data = result.data?.details;
  if (result.error)
    return (
      <section
        aria-label={cash ? 'Payment record' : 'Bank record'}
        role="alert"
        className="space-y-2 rounded-lg border p-4 text-sm text-muted-foreground"
      >
        <p>The payment record could not be loaded.</p>
        <Button
          variant="outline"
          size="sm"
          onClick={() => void result.refetch()}
        >
          Try again
        </Button>
      </section>
    );
  if (!data)
    return (
      <section
        aria-label={cash ? 'Payment record' : 'Bank record'}
        className="rounded-lg border p-4"
      >
        <p role="status" className="text-sm text-muted-foreground">
          Loading the payment record…
        </p>
      </section>
    );
  const s = data.summary;
  const party = s.counterparty;
  const hasParty = Boolean(
    party.name || party.iban || party.card || party.bank,
  );
  const hasAnything =
    hasParty ||
    s.originalAmount ||
    s.purpose ||
    s.mcc ||
    s.cashback ||
    s.bankTransactionType;
  return (
    <section
      aria-label={cash ? 'Payment record' : 'Bank record'}
      className="space-y-4 rounded-lg border p-4 sm:p-5"
    >
      <h2 className="flex items-center gap-2 text-base font-semibold">
        <Landmark className="size-4" />
        {cash ? 'Payment record' : 'What the bank recorded'}
      </h2>
      {hasAnything ? (
        <dl className="grid gap-4 sm:grid-cols-2">
          {s.originalAmount && (
            <Fact icon={Hash} label="Original purchase amount">
              {s.originalAmount}
            </Fact>
          )}
          {s.purpose && (
            <Fact icon={FileText} label="Payment purpose">
              {s.purpose}
            </Fact>
          )}
          {s.mcc && (
            <Fact icon={Store} label="Merchant category">
              <HoverCard>
                <HoverCardTrigger
                  render={
                    <button
                      type="button"
                      className="text-left underline decoration-dotted underline-offset-4"
                    />
                  }
                >
                  {s.mcc.meaning}{' '}
                  <span className="text-muted-foreground">{s.mcc.code}</span>
                </HoverCardTrigger>
                <HoverCardContent className="text-xs leading-relaxed">
                  {s.mcc.note}
                </HoverCardContent>
              </HoverCard>
            </Fact>
          )}
          {party.name && (
            <Fact icon={UserRound} label={party.role}>
              {party.name}
            </Fact>
          )}
          {party.iban && (
            <Fact icon={Building2} label={`${party.role} IBAN`}>
              {party.iban}
            </Fact>
          )}
          {party.card && (
            <Fact icon={CreditCard} label={`${party.role} card`}>
              {party.card}
              {party.cardNetwork ? ` · ${party.cardNetwork}` : ''}
            </Fact>
          )}
          {party.bank && (
            <Fact icon={Landmark} label={`${party.role} bank`}>
              {party.bank}
              {party.bankSource && (
                <span className="mt-0.5 block text-xs text-muted-foreground">
                  {party.bankSource}
                </span>
              )}
            </Fact>
          )}
          {s.cashback && (
            <Fact icon={Hash} label="Cashback">
              {s.cashback}
            </Fact>
          )}
          {s.bankTransactionType && (
            <Fact icon={FileText} label="Bank transaction type">
              {s.bankTransactionType}
            </Fact>
          )}
        </dl>
      ) : (
        <p className="text-sm text-muted-foreground">
          This record carries nothing beyond the amount, date and description
          already shown above.
        </p>
      )}
      {!cash && !data.counterpartyAvailable && (
        <p className="text-xs text-muted-foreground">
          This bank record names no separate sender or recipient.
        </p>
      )}
      <details className="group rounded-lg border bg-muted/20">
        <summary className="flex min-h-11 cursor-pointer list-none items-center justify-between gap-2 px-3 text-sm font-medium">
          <span>
            {cash ? 'All recorded fields' : 'All fields as the bank sent them'}
          </span>
          <ChevronDown className="size-4 group-open:rotate-180" />
        </summary>
        <div className="space-y-3 border-t p-3">
          <dl className="grid gap-3 text-xs sm:grid-cols-2">
            {data.fields.map((field) => (
              <div key={field.label} className="min-w-0">
                <dt className="text-muted-foreground">{field.label}</dt>
                <dd className="mt-1 font-medium break-words whitespace-pre-wrap [overflow-wrap:anywhere]">
                  {field.value}
                </dd>
              </div>
            ))}
          </dl>
          {!cash && !data.cardReferenceAvailable && (
            <p className="text-xs text-muted-foreground">
              No counterparty card number was provided. Your own card is not a
              recipient card.
            </p>
          )}
        </div>
      </details>
    </section>
  );
}
