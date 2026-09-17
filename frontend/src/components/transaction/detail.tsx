import type { ComponentType } from 'react';
import {
  ArrowLeft,
  Clock,
  FolderTree,
  Hourglass,
  Info,
  MessageCircle,
  Repeat2,
  Tag as TagIcon,
  Wallet,
} from 'lucide-react';
import { repliesForTransaction } from '@/lib/reply-history';
import {
  bookedMoment,
  kinds,
  type Bootstrap,
  type ReviewData,
  type Submit,
  type Transaction,
} from '@/lib/transactions';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { AccountChip } from './account-chip';
import { BankRecord } from './bank-record';
import {
  DecisionCard,
  type CategoryNode,
  type Step,
  type Tag,
} from './decision-card';
import { DirectionMark, DisplayAmount, HistoryLink, ReplyCard } from './pieces';
import { ReceiptEvidence } from './receipt-evidence';
import { RefundPanel } from './refund-panel';

/** A labelled fact, so no value on this page appears as a bare word. */
function Pill({
  icon: Icon,
  label,
  value,
  muted = false,
}: {
  icon: ComponentType<{ className?: string }>;
  label: string;
  value: string;
  muted?: boolean;
}) {
  return (
    <span className="inline-flex max-w-full items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs">
      <Icon
        aria-hidden="true"
        className="size-3.5 shrink-0 text-muted-foreground"
      />
      <span className="shrink-0 text-muted-foreground">{label}</span>
      <span
        className={
          'min-w-0 break-words ' +
          (muted ? 'text-muted-foreground italic' : 'font-medium')
        }
      >
        {value}
      </span>
    </span>
  );
}

export function TransactionDetail({
  transaction: t,
  data,
  identity,
  nodes,
  allTags,
  displayCurrency,
  busy,
  actionError,
  notice,
  detailError,
  refreshing,
  onBack,
  onRefresh,
  submit,
  submitSteps,
}: {
  transaction: Transaction;
  data: ReviewData;
  identity: Bootstrap;
  nodes: CategoryNode[];
  allTags: Tag[];
  displayCurrency: string;
  busy: boolean;
  actionError: string;
  notice: string;
  detailError: boolean;
  refreshing: boolean;
  onBack: () => void;
  onRefresh: () => void;
  submit: Submit;
  submitSteps: (steps: Step[], message: string) => Promise<void>;
}) {
  const moment = bookedMoment(t.bookedAt, t.source);
  const tags = data.tags[t.id] ?? [];
  const replies = repliesForTransaction(data.replies, t.id);
  const reportingRow =
    data.reporting?.currency === displayCurrency
      ? data.reporting.rows.find((row) => row.id === t.id)
      : undefined;
  const pattern = t.spendingPattern?.pattern;
  const cash = t.source === 'manual_cash';
  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <Button variant="ghost" onClick={onBack} disabled={busy}>
          <ArrowLeft className="size-4" />
          Back to transactions
        </Button>
        <Button
          variant="outline"
          size="sm"
          disabled={refreshing}
          onClick={onRefresh}
        >
          Refresh payment
        </Button>
      </div>
      {notice && (
        <p role="status" className="rounded-lg border bg-muted/30 p-3 text-sm">
          {notice}
        </p>
      )}
      {detailError && (
        <p role="alert" className="text-sm text-destructive">
          Could not refresh this payment. Previously loaded information is kept
          below; refresh before saving.
        </p>
      )}

      <header className="space-y-4 rounded-lg border p-4 sm:p-5">
        <div className="space-y-1">
          <p className="text-xs font-medium text-muted-foreground">
            Payment review
          </p>
          <h1 className="text-2xl font-semibold tracking-tight break-words">
            {t.description || 'Payment'}
          </h1>
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <DirectionMark amountMinor={t.amountMinor} />
          <DisplayAmount
            transaction={t}
            reporting={data.reporting}
            requested={displayCurrency}
          />
        </div>
        <div className="flex flex-wrap items-center gap-2 text-sm">
          <span className="inline-flex items-center gap-1.5 text-muted-foreground">
            <Clock aria-hidden="true" className="size-3.5" />
            <time dateTime={moment.iso}>
              {moment.day}
              {moment.time ? ` · ${moment.time}` : ''}
            </time>
          </span>
          <AccountChip
            source={t.source}
            currency={t.currency}
            label={t.spendingPolicy?.accountLabel}
            owner={t.owner}
          />
          {t.status === 'pending' && (
            <span className="inline-flex items-center gap-1.5 rounded-full bg-muted px-2.5 py-1 text-xs text-muted-foreground">
              <Hourglass aria-hidden="true" className="size-3" />
              Bank processing
            </span>
          )}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Pill icon={Wallet} label="Type" value={kinds[t.kind]} />
          <Pill
            icon={FolderTree}
            label="Category"
            value={t.category ?? 'not set yet'}
            muted={!t.category}
          />
          {pattern && pattern !== 'unreviewed' && (
            <Pill
              icon={Repeat2}
              label="Pattern"
              value={pattern === 'routine' ? 'Routine' : 'Exceptional'}
            />
          )}
          {tags.length > 0 ? (
            tags.map((tag) => (
              <Badge key={tag.id} variant="secondary" className="gap-1 py-1">
                <TagIcon aria-hidden="true" className="size-3" />
                {tag.name}
              </Badge>
            ))
          ) : (
            <span className="text-xs text-muted-foreground">No tags</span>
          )}
        </div>
      </header>

      {t.status === 'pending' && (
        <Alert>
          <Info />
          <AlertDescription>
            The bank is still processing this payment and may change its amount
            when it settles. The money has already left the account, so it
            counts as spending; you can explain and categorise it now.
          </AlertDescription>
        </Alert>
      )}

      <div className="grid items-start gap-6 xl:grid-cols-[minmax(0,1fr)_minmax(22rem,0.95fr)]">
        <div className="min-w-0 space-y-5">
          <section
            aria-label="Your explanations"
            className="space-y-3 rounded-lg border p-4 sm:p-5"
          >
            <h2 className="flex items-center gap-2 text-base font-semibold">
              <MessageCircle className="size-4" />
              Your explanations
            </h2>
            <p className="text-sm text-muted-foreground">
              Everything you saved in Telegram or this app stays here, including
              confirmed and rejected suggestions.
            </p>
            {replies.length ? (
              replies.map((reply) => (
                <ReplyCard
                  key={`${reply.source ?? 'telegram'}:${reply.id}`}
                  reply={reply}
                />
              ))
            ) : (
              <p className="text-sm text-muted-foreground">
                No explanation saved yet. Tell us what this payment was for.
              </p>
            )}
          </section>
          <ReceiptEvidence id={t.id} actor={identity.actor} />
          <RefundPanel transaction={t} busy={busy} submit={submit} />
          <BankRecord key={t.id} id={t.id} cash={cash} />
          <HistoryLink
            id={t.id}
            label="Everything that happened to this payment"
          />
        </div>
        <div className="min-w-0 rounded-lg border p-4 sm:p-5">
          <DecisionCard
            key={`${t.id}:${t.revision}`}
            transaction={t}
            identity={identity}
            nodes={nodes}
            allTags={allTags}
            currentTags={tags}
            suggestions={data.suggestions[t.id]}
            recognized={
              data.triage?.find(
                (item) =>
                  item.transaction_id === t.id &&
                  item.revision === t.revision &&
                  item.state === 'ready',
              )?.decision ?? undefined
            }
            savedExplanations={replies}
            convertedMinor={
              reportingRow?.convertedAmountMinor ??
              (t.currency === displayCurrency ? t.amountMinor : null)
            }
            displayCurrency={displayCurrency}
            busy={busy}
            error={actionError}
            submit={submit}
            submitSteps={submitSteps}
          />
        </div>
      </div>
    </div>
  );
}
