import type { ComponentType, ReactNode } from 'react';
import {
  ArrowLeft,
  Clock,
  Ellipsis,
  FolderTree,
  History,
  Hourglass,
  ListChecks,
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
import { owners } from '@/lib/account-visuals';
import { Badge } from '@/components/ui/badge';
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@/components/ui/tooltip';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { AccountChip } from './account-chip';
import { BankRecord } from './bank-record';
import {
  DecisionCard,
  type CategoryNode,
  type Step,
  type Tag,
} from './decision-card';
import { DirectionMark, DisplayAmount, ReplyCard } from './pieces';
import { ReceiptEvidence } from './receipt-evidence';
import { RefundPanel } from './refund-panel';

/** The secondary actions of a payment page, folded behind one button on the phone. */
function MoreMenu({
  items,
}: {
  items: Array<{ label: string; onClick?: () => void; href?: string }>;
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <Button variant="outline" size="icon" aria-label="More actions" />
        }
      >
        <Ellipsis className="size-4" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        {items.map((item) =>
          item.href ? (
            <DropdownMenuItem key={item.label} render={<a href={item.href} />}>
              {item.label}
            </DropdownMenuItem>
          ) : (
            <DropdownMenuItem key={item.label} onClick={item.onClick}>
              {item.label}
            </DropdownMenuItem>
          ),
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

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

/**
 * The payment's header: what it was, what it cost, when, which account and
 * whose, and how it is filed. The same on both pages, because recognising the
 * payment comes first whether one is deciding or looking.
 */
export function PaymentHeader({
  transaction: t,
  data,
  displayCurrency,
  eyebrow,
}: {
  transaction: Transaction;
  data: ReviewData;
  displayCurrency: string;
  eyebrow: string;
}) {
  const moment = bookedMoment(t.bookedAt, t.source);
  const tags = data.tags[t.id] ?? [];
  const pattern = t.spendingPattern?.pattern;
  return (
    <header className="space-y-4 rounded-lg border p-4 sm:p-5">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0 space-y-2">
          <p className="text-xs font-medium text-muted-foreground">{eyebrow}</p>
          <h1 className="text-xl font-semibold tracking-tight break-words sm:text-2xl">
            {t.description || 'Payment'}
          </h1>
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
            <span className="text-xs text-muted-foreground">
              {owners[t.owner].name}’s account
            </span>
            {t.status === 'pending' && (
              <TooltipProvider>
                <Tooltip>
                  <TooltipTrigger
                    render={
                      <span className="inline-flex cursor-help items-center gap-1.5 rounded-full bg-muted px-2.5 py-1 text-xs text-muted-foreground" />
                    }
                  >
                    <Hourglass aria-hidden="true" className="size-3" />
                    Bank processing
                  </TooltipTrigger>
                  <TooltipContent className="max-w-64">
                    The bank may still change the amount when it settles. The
                    money has already left the account, so it counts as
                    spending; you can decide it now.
                  </TooltipContent>
                </Tooltip>
              </TooltipProvider>
            )}
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-3 sm:justify-end sm:text-right">
          <DirectionMark amountMinor={t.amountMinor} />
          <DisplayAmount
            transaction={t}
            reporting={data.reporting}
            requested={displayCurrency}
          />
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-2 border-t pt-4">
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
  );
}

/**
 * The review page: the decision first, on the left and widest, and beside it
 * the evidence that informs it — receipt, refunds, the bank record. Saved
 * explanations sit inside the decision block, so one that did not work is in
 * view when the next is written.
 */
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
  const tags = data.tags[t.id] ?? [];
  const replies = repliesForTransaction(data.replies, t.id);
  const reportingRow =
    data.reporting?.currency === displayCurrency
      ? data.reporting.rows.find((row) => row.id === t.id)
      : undefined;
  const cash = t.source === 'manual_cash';
  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <Button variant="ghost" onClick={onBack} disabled={busy}>
          <ArrowLeft className="size-4" />
          Back to review
        </Button>
        <div className="hidden items-center gap-2 sm:flex">
          <Button
            variant="ghost"
            size="sm"
            render={<a href={`/transactions/${encodeURIComponent(t.id)}`} />}
          >
            Payment page
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
        <div className="sm:hidden">
          <MoreMenu
            items={[
              { label: 'Refresh payment', onClick: onRefresh },
              {
                label: 'Payment page',
                href: `/transactions/${encodeURIComponent(t.id)}`,
              },
            ]}
          />
        </div>
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
      <PaymentHeader
        transaction={t}
        data={data}
        displayCurrency={displayCurrency}
        eyebrow="Payment review"
      />
      <div className="grid items-start gap-6 xl:grid-cols-[minmax(0,1.1fr)_minmax(20rem,0.9fr)]">
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
        <div className="min-w-0 space-y-5">
          <ReceiptEvidence id={t.id} actor={identity.actor} />
          <RefundPanel transaction={t} busy={busy} submit={submit} />
          <BankRecord key={t.id} id={t.id} cash={cash} />
        </div>
      </div>
    </div>
  );
}

/**
 * The payment page: the facts, then what is known about the payment —
 * explanations, receipt, refunds — and the bank record beside them. No form;
 * deciding is the review page's job, one click away.
 */
export function PaymentView({
  transaction: t,
  data,
  identity,
  displayCurrency,
  busy,
  refreshing,
  onRefresh,
  submit,
  back,
}: {
  transaction: Transaction;
  data: ReviewData;
  identity: Bootstrap;
  displayCurrency: string;
  busy: boolean;
  refreshing: boolean;
  onRefresh: () => void;
  submit: Submit;
  /** Where "Back" goes: the list the reader came from. */
  back: ReactNode;
}) {
  const replies = repliesForTransaction(data.replies, t.id);
  const cash = t.source === 'manual_cash';
  const reviewHref = `/review?id=${encodeURIComponent(t.id)}&display=${displayCurrency}`;
  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        {back}
        <div className="hidden items-center gap-2 sm:flex">
          <Button
            variant="ghost"
            size="sm"
            render={
              <a href={`/transactions/${encodeURIComponent(t.id)}/history`} />
            }
          >
            <History className="size-4" />
            Decision history
          </Button>
          <Button
            variant="outline"
            size="sm"
            disabled={refreshing}
            onClick={onRefresh}
          >
            Refresh payment
          </Button>
          <Button size="sm" render={<a href={reviewHref} />}>
            <ListChecks className="size-4" />
            Review this payment
          </Button>
        </div>
        <div className="sm:hidden">
          <MoreMenu
            items={[
              { label: 'Refresh payment', onClick: onRefresh },
              {
                label: 'Decision history',
                href: `/transactions/${encodeURIComponent(t.id)}/history`,
              },
            ]}
          />
        </div>
      </div>
      <PaymentHeader
        transaction={t}
        data={data}
        displayCurrency={displayCurrency}
        eyebrow="Payment"
      />
      <Button className="w-full sm:hidden" render={<a href={reviewHref} />}>
        <ListChecks className="size-4" />
        Review this payment
      </Button>
      <div className="grid items-start gap-6 xl:grid-cols-[minmax(0,1fr)_minmax(22rem,0.95fr)]">
        <div className="min-w-0 space-y-5">
          {replies.length > 0 && (
            <section
              aria-label="Your explanations"
              className="space-y-3 rounded-lg border p-4 sm:p-5"
            >
              <h2 className="flex items-center gap-2 text-base font-semibold">
                <MessageCircle className="size-4" />
                Your explanations
              </h2>
              {replies.map((reply) => (
                <ReplyCard
                  key={`${reply.source ?? 'telegram'}:${reply.id}`}
                  reply={reply}
                />
              ))}
            </section>
          )}
          <ReceiptEvidence id={t.id} actor={identity.actor} />
          <RefundPanel transaction={t} busy={busy} submit={submit} />
        </div>
        <div className="min-w-0 space-y-5">
          <BankRecord key={t.id} id={t.id} cash={cash} />
        </div>
      </div>
    </div>
  );
}
