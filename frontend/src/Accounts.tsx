import {
  invalidateFinancialData,
  observeSession,
  useRefreshSignal,
} from './lib/query';
import { money } from './lib/format';
import { useCallback, useEffect, useId, useState, type FormEvent } from 'react';
import {
  ArrowLeftRight,
  ArrowRight,
  BriefcaseBusiness,
  Check,
  CircleAlert,
  Fingerprint,
  Landmark,
  Pencil,
  Plus,
  RefreshCw,
  ShieldCheck,
  TrendingUp,
  Wallet,
} from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  AccountBadge,
  Choice,
  PageHeader,
  RefreshButton,
} from '@/components/finance';
import { accountIdentity } from '@/lib/account-identity';
import { currencyFromLabel, owners, tileFor } from '@/lib/account-visuals';
import { Skeleton } from '@/components/ui/skeleton';

type Owner = 'rodion' | 'katya';
type Purpose = 'personal' | 'business' | 'investment' | 'unreviewed';
type Account = {
  source: string;
  accountId: string;
  owner: Owner;
  label: string;
  purpose: Purpose;
  identifierRegistered: boolean;
  revision: number;
  impact?: {
    transactionCount: number;
    personalExpenseCount: number;
    byCurrency: Array<{ currency: string; personalExpenseMinor: string }>;
  };
  history?: Array<{
    createdAt: string;
    reason: string;
    beforePurpose: string | null;
    afterPurpose: string;
    revision: number;
  }>;
};
type Suggestion = {
  transactionId: string;
  proposedKind: string | null;
  reason: string;
  requiresReview: true;
};
type Identity = { actor: Owner; csrf: string };
type Draft = {
  source: string;
  accountId: string;
  label: string;
  purpose: string;
  iban: string;
  reason: string;
};
const emptyDraft: Draft = {
  source: '',
  accountId: '',
  label: '',
  purpose: '',
  iban: '',
  reason: '',
};
const purposes = {
  personal: { name: 'Personal', icon: Wallet },
  business: { name: 'Business', icon: BriefcaseBusiness },
  investment: { name: 'Investment', icon: TrendingUp },
  unreviewed: { name: 'Purpose to review', icon: CircleAlert },
};
const reasonText: Record<string, string> = {
  known_account: 'The counterparty identifier matches a registered account.',
  cross_owner_account:
    'The counterparty identifier matches an account belonging to the other owner.',
  ambiguous_identifier:
    'The identifier match needs clarification before a decision.',
};
const kindText: Record<string, string> = {
  internal_transfer: 'Possible internal transfer',
  investment: 'Possible investment movement',
  non_personal: 'Possible business payment',
  unresolved: 'Needs clarification',
  personal_expense: 'Possible personal expense',
};
/** The bank as the owner knows it; never the connector that fetched the rows. */
function bankName(account: Account) {
  const { bank } = accountIdentity(account.source, '', account.label);
  return bank ? tileFor(bank, 'standard').name : 'Bank account';
}
function safeRequestId(response: Response) {
  const id = response.headers.get('X-Request-Id');
  return id && /^[a-zA-Z0-9-]{1,80}$/.test(id) ? ` Reference: ${id}.` : '';
}
async function readJson(response: Response) {
  if (!response.ok)
    throw new Error(
      (response.status === 401 || response.status === 403
        ? 'Your session needs attention. Reload the page to sign in again.'
        : 'The request could not be completed. Please try again.') +
        safeRequestId(response),
    );
  return response.json();
}

export default function Accounts() {
  const [identity, setIdentity] = useState<Identity>();
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [suggestions, setSuggestions] = useState<Suggestion[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState<Account>();
  const [draft, setDraft] = useState<Draft>(emptyDraft);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState('');
  const purposeChanged = Boolean(
    draft.purpose && draft.purpose !== (editing?.purpose ?? 'unreviewed'),
  );
  const excludesSpending =
    draft.purpose === 'business' || draft.purpose === 'investment';
  const prefix = useId();
  const load = useCallback(async (signal?: AbortSignal) => {
    setLoading(true);
    setError('');
    try {
      const [bootstrap, data] = await Promise.all(
        ['/api/bootstrap', '/api/accounts'].map(async (path) =>
          readJson(
            await fetch(path, {
              signal,
              credentials: 'same-origin',
              headers: { Accept: 'application/json' },
            }),
          ),
        ),
      );
      if (signal?.aborted) return;
      if (
        !['rodion', 'katya'].includes(bootstrap.actor) ||
        typeof bootstrap.csrf !== 'string' ||
        !bootstrap.csrf ||
        !Array.isArray(data.accounts) ||
        !Array.isArray(data.suggestions)
      )
        throw new Error(
          'The accounts response was incomplete. Please refresh.',
        );
      observeSession(bootstrap);
      setIdentity({ actor: bootstrap.actor, csrf: bootstrap.csrf });
      setAccounts(data.accounts);
      setSuggestions(data.suggestions);
    } catch (e) {
      if (!signal?.aborted)
        setError(
          e instanceof Error && !(e instanceof TypeError)
            ? e.message
            : 'Could not reach your accounts. Check your connection and try again.',
        );
    } finally {
      if (!signal?.aborted) setLoading(false);
    }
  }, []);
  // `refresh` changes whenever the workspace is told its data is stale — a
  // save, the pull-down gesture, the Refresh button — so this screen re-reads
  // with everything else rather than keeping a private button of its own.
  const refresh = useRefreshSignal();
  useEffect(() => {
    const controller = new AbortController();
    void load(controller.signal);
    return () => controller.abort();
  }, [load, refresh]);
  function showForm(account?: Account) {
    setEditing(account);
    setSaveError('');
    setDraft(
      account
        ? {
            source: account.source,
            accountId: account.accountId,
            label: account.label,
            purpose: account.purpose === 'unreviewed' ? '' : account.purpose,
            iban: '',
            reason: '',
          }
        : { ...emptyDraft },
    );
    setOpen(true);
  }
  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (saving || !identity) return;
    if (
      ![draft.source, draft.accountId, draft.label].every((value) =>
        value.trim(),
      )
    ) {
      setSaveError('Enter an account name, provider and account reference.');
      return;
    }
    if (!['personal', 'business', 'investment'].includes(draft.purpose)) {
      setSaveError('Choose the purpose of this account.');
      return;
    }
    if (purposeChanged && !draft.reason.trim()) {
      setSaveError('Add a reason for changing this account’s spending rule.');
      return;
    }
    if (
      editing &&
      (!Number.isSafeInteger(editing.revision) ||
        (purposeChanged && !editing.impact))
    ) {
      setSaveError(
        'Refresh the account details and impact before changing this rule.',
      );
      return;
    }
    setSaving(true);
    setSaveError('');
    setNotice('');
    try {
      const body = new URLSearchParams({
        csrf: identity.csrf,
        source: draft.source.trim(),
        accountId: draft.accountId.trim(),
        label: draft.label.trim(),
        purpose: draft.purpose,
        iban: draft.iban.trim(),
        expectedRevision: String(editing?.revision ?? 0),
        reason:
          draft.reason.trim() ||
          'Owner updated account details without changing the spending rule',
      });
      const response = await fetch('/accounts', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body,
      });
      if (!response.ok) {
        const message =
          response.status === 401 || response.status === 403
            ? 'Your session has changed. Refresh the page before saving again.'
            : response.status === 409
              ? 'This account changed since you opened it. Close this form and refresh before saving again.'
              : 'Account not saved. Check the provider, reference and IBAN, then try again.';
        throw new Error(message + safeRequestId(response));
      }
      if (
        !response.redirected ||
        new URL(response.url).pathname !== '/accounts'
      )
        throw new Error(
          'The save could not be confirmed. Refresh your accounts before trying again.' +
            safeRequestId(response),
        );
      await invalidateFinancialData();
      setOpen(false);
      setDraft({ ...emptyDraft });
      setNotice(
        purposeChanged
          ? 'Account spending rule saved. Past and future payments use this rule; original records and individual classifications are retained.'
          : 'Account details saved.',
      );
      await load();
    } catch (e) {
      setSaveError(
        e instanceof Error && !(e instanceof TypeError)
          ? e.message
          : 'The save could not be confirmed. Check your connection and refresh your accounts before trying again.',
      );
    } finally {
      setSaving(false);
    }
  }
  const missingPurpose = accounts.filter(
    (a) => a.purpose === 'unreviewed',
  ).length;
  const missingIdentifier = accounts.filter(
    (a) => !a.identifierRegistered,
  ).length;
  const ownerName =
    identity?.actor === 'rodion'
      ? 'Rodion'
      : identity?.actor === 'katya'
        ? 'Katya'
        : 'you';

  return (
    <div className="mx-auto max-w-7xl space-y-5 pb-8">
      <PageHeader
        title="Accounts & exclusions"
        description="Which accounts belong in personal spending. Business and investment account rules keep their past and future payments out of personal totals."
        actions={
          <>
            <RefreshButton />
            <Button
              size="sm"
              disabled={!identity || saving}
              onClick={() => showForm()}
            >
              <Plus />
              Add account
            </Button>
          </>
        }
      />
      {notice && (
        <div
          role="status"
          className="flex items-start gap-2 rounded-lg border border-primary/20 bg-primary/5 px-4 py-3 text-sm"
        >
          <Check className="mt-0.5 size-4 shrink-0 text-primary" />
          {notice}
        </div>
      )}
      {error && (
        <div
          role="alert"
          className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-destructive/25 bg-destructive/5 p-4"
        >
          <p className="max-w-xl text-sm">{error}</p>
          <Button
            variant="outline"
            size="sm"
            onClick={() => void load()}
            disabled={loading}
          >
            Try again
          </Button>
        </div>
      )}
      {loading ? (
        <div
          role="status"
          aria-label="Loading accounts"
          className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3"
        >
          {[0, 1, 2].map((n) => (
            <Skeleton key={n} className="h-48 rounded-lg" />
          ))}
          <span className="sr-only">Loading your accounts</span>
        </div>
      ) : (
        identity && (
          <>
            <div className="flex flex-wrap items-center justify-between gap-3 text-xs text-muted-foreground">
              <span>
                Accounts belonging to{' '}
                <span className="font-medium text-foreground">{ownerName}</span>
              </span>
              <span>
                {accounts.length} registered · {missingIdentifier} without a
                matching identifier
              </span>
            </div>
            {missingPurpose > 0 && (
              <div className="flex items-start gap-3 rounded-lg border border-warning/20 bg-warning/5 px-4 py-3">
                <CircleAlert className="mt-0.5 size-4 shrink-0 text-warning" />
                <div>
                  <p className="text-sm font-medium">
                    {missingPurpose}{' '}
                    {missingPurpose === 1 ? 'account needs' : 'accounts need'} a
                    purpose
                  </p>
                  <p className="mt-1 text-xs text-muted-foreground">
                    Review newly imported accounts to choose personal, business
                    or investment use.
                  </p>
                </div>
              </div>
            )}
            {accounts.length ? (
              <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
                {accounts.map((account) => {
                  const purpose =
                    purposes[account.purpose] || purposes.unreviewed;
                  const Icon = purpose.icon;
                  return (
                    <Card
                      key={`${account.source}:${account.accountId}`}
                      className="flex min-w-0 flex-col shadow-xs"
                    >
                      <CardHeader className="flex flex-row items-start justify-between gap-3 space-y-0 pb-3">
                        <div className="flex min-w-0 items-center gap-3">
                          <AccountBadge
                            source={account.source}
                            label={account.label}
                            owner={account.owner}
                            currency={
                              currencyFromLabel(account.label) ??
                              (account.impact?.byCurrency.length === 1
                                ? account.impact.byCurrency[0].currency
                                : null)
                            }
                            size="lg"
                          />
                          <div className="min-w-0">
                            <CardTitle className="break-words text-base leading-snug">
                              {account.label}
                            </CardTitle>
                            <p className="mt-1 truncate text-xs text-muted-foreground">
                              {bankName(account)} · {owners[account.owner].name}
                            </p>
                          </div>
                        </div>
                        <Button
                          variant="ghost"
                          size="icon"
                          className="size-8 shrink-0"
                          onClick={() => showForm(account)}
                          aria-label={`Edit ${account.label}`}
                        >
                          <Pencil className="size-3.5" />
                        </Button>
                      </CardHeader>
                      <CardContent className="flex flex-1 flex-col gap-4">
                        <div className="flex flex-wrap items-center gap-2">
                          <Badge
                            variant="secondary"
                            className="gap-1.5 font-normal"
                          >
                            <Icon className="size-3" />
                            {purpose.name}
                          </Badge>
                          <span className="text-xs text-muted-foreground">
                            {account.owner === 'rodion' ? 'Rodion' : 'Katya'}
                          </span>
                        </div>
                        <p className="rounded-md bg-muted/40 p-2 text-xs leading-relaxed text-muted-foreground">
                          {account.purpose === 'business' ||
                          account.purpose === 'investment'
                            ? 'Excluded from personal spending — applies to all past and future payments on this account.'
                            : account.purpose === 'personal'
                              ? 'No account exclusion. Each payment’s own classification determines whether it counts as personal spending.'
                              : 'No account exclusion has been set. Review this account’s spending rule.'}
                        </p>
                        {account.impact && (
                          <p className="text-xs text-muted-foreground">
                            {account.impact.transactionCount} imported
                            transactions · {account.impact.personalExpenseCount}{' '}
                            classified personal expenses
                          </p>
                        )}
                        {Boolean(account.history?.length) && (
                          <details className="rounded-md border px-2.5 py-1.5 text-xs">
                            <summary className="cursor-pointer py-1 font-medium">
                              Rule history
                            </summary>
                            <ol className="mt-1 divide-y">
                              {account.history!.slice(0, 5).map((entry) => {
                                const before =
                                  entry.beforePurpose === null
                                    ? null
                                    : (purposes[entry.beforePurpose as Purpose]
                                        ?.name ?? entry.beforePurpose);
                                const after =
                                  purposes[entry.afterPurpose as Purpose]
                                    ?.name ?? entry.afterPurpose;
                                return (
                                  <li
                                    key={`${entry.revision}:${entry.createdAt}`}
                                    className="space-y-1 py-2 leading-relaxed"
                                  >
                                    <p className="font-medium">
                                      {before === null
                                        ? `Registered as ${after}`
                                        : before === after
                                          ? `${after} — account details updated`
                                          : `${before} → ${after}`}
                                    </p>
                                    <p className="text-muted-foreground">
                                      <time dateTime={entry.createdAt}>
                                        {entry.createdAt.slice(0, 10)}
                                      </time>{' '}
                                      · UTC · Revision {entry.revision}
                                    </p>
                                    <p className="break-words text-muted-foreground">
                                      {entry.reason}
                                    </p>
                                  </li>
                                );
                              })}
                            </ol>
                          </details>
                        )}
                        <div className="min-w-0 text-xs">
                          <p className="mb-1 text-muted-foreground">
                            Account reference
                          </p>
                          <p className="break-all font-mono leading-relaxed">
                            {account.accountId}
                          </p>
                        </div>
                        <div className="mt-auto flex items-center gap-2 border-t pt-3 text-xs text-muted-foreground">
                          <Fingerprint
                            className={`size-3.5 shrink-0 ${account.identifierRegistered ? 'text-primary' : ''}`}
                          />
                          {account.identifierRegistered
                            ? 'Matching identifier registered'
                            : 'No matching identifier yet'}
                        </div>
                      </CardContent>
                    </Card>
                  );
                })}
              </div>
            ) : (
              <Card className="shadow-xs">
                <CardContent className="flex flex-col items-center gap-3 py-14 text-center">
                  <div className="rounded-full bg-muted p-4">
                    <Landmark className="size-6 text-muted-foreground" />
                  </div>
                  <h2 className="text-lg font-semibold">
                    Build your account registry
                  </h2>
                  <p className="max-w-md text-sm leading-relaxed text-muted-foreground">
                    Add an account you own, including savings or brokerage
                    accounts, to help recognize transfers between accounts.
                  </p>
                  <Button onClick={() => showForm()}>
                    <Plus className="mr-1.5 size-4" />
                    Add your first account
                  </Button>
                </CardContent>
              </Card>
            )}
            <Card className="shadow-xs">
              <CardHeader className="flex flex-row items-start justify-between gap-3">
                <div>
                  <CardTitle className="text-base">
                    Transfers to review
                  </CardTitle>
                  <p className="mt-1.5 text-xs leading-relaxed text-muted-foreground">
                    Suggestions from explicit account identifier matches. Your
                    confirmation is always required.
                  </p>
                </div>
                <Badge variant="secondary">{suggestions.length}</Badge>
              </CardHeader>
              <CardContent>
                {suggestions.length ? (
                  <div className="divide-y">
                    {suggestions.map((s) => (
                      <div
                        key={s.transactionId}
                        className="flex flex-wrap items-center justify-between gap-3 py-4 first:pt-0 last:pb-0"
                      >
                        <div className="flex min-w-0 items-start gap-3">
                          <ArrowLeftRight className="mt-1 size-4 shrink-0 text-muted-foreground" />
                          <div>
                            <p className="text-sm font-medium">
                              {s.proposedKind
                                ? kindText[s.proposedKind] ||
                                  'Suggested classification'
                                : 'Ambiguous account match'}
                            </p>
                            <p className="mt-1 max-w-lg text-xs leading-relaxed text-muted-foreground">
                              {reasonText[s.reason] ||
                                'Review the account match and transaction context.'}
                            </p>
                            <a
                              href={`/transactions/${encodeURIComponent(s.transactionId)}/history`}
                              className="mt-2 inline-flex items-center gap-1 text-xs font-medium text-primary"
                            >
                              Transaction history
                              <ArrowRight className="size-3" />
                            </a>
                          </div>
                        </div>
                        <Button
                          variant="outline"
                          size="sm"
                          render={<a href="/review" />}
                        >
                          Review classification
                          <ArrowRight className="ml-1.5 size-3.5" />
                        </Button>
                      </div>
                    ))}
                  </div>
                ) : (
                  <div className="flex items-start gap-3 rounded-lg bg-muted/40 p-4">
                    <ShieldCheck className="mt-0.5 size-5 shrink-0 text-muted-foreground" />
                    <div>
                      <p className="text-sm font-medium">
                        No account matches awaiting review
                      </p>
                      <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
                        Matches appear when an imported transaction contains a
                        known counterparty identifier. This doesn’t mean all
                        transfers have been identified.
                      </p>
                    </div>
                  </div>
                )}
              </CardContent>
            </Card>
            <p className="flex items-start gap-2 px-1 text-xs leading-relaxed text-muted-foreground">
              <ShieldCheck className="mt-0.5 size-3.5 shrink-0" />
              Matching identifiers are stored as hashes and aren’t displayed.
              Account rules change what enters personal totals. Original bank
              records and individual classifications are retained.
            </p>
          </>
        )
      )}
      <Dialog
        open={open}
        onOpenChange={(next) => {
          if (!saving) {
            setOpen(next);
            if (!next) setDraft({ ...emptyDraft });
          }
        }}
      >
        <DialogContent className="max-h-[90dvh] overflow-y-auto sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>
              {editing
                ? 'Edit account & spending rule'
                : 'Add an account & spending rule'}
            </DialogTitle>
            <DialogDescription>
              Registered to {ownerName}. Review how this account’s payments
              should affect personal spending.
            </DialogDescription>
          </DialogHeader>
          <form onSubmit={save} className="space-y-4">
            <fieldset disabled={saving} className="space-y-4">
              <div className="space-y-1.5">
                <Label htmlFor={`${prefix}-label`}>Account name</Label>
                <Input
                  id={`${prefix}-label`}
                  name="label"
                  required
                  maxLength={100}
                  value={draft.label}
                  onChange={(e) =>
                    setDraft((d) => ({ ...d, label: e.target.value }))
                  }
                  placeholder="e.g. Savings account"
                  autoFocus
                />
              </div>
              <div className="grid gap-4 sm:grid-cols-2">
                <div className="space-y-1.5">
                  <Label htmlFor={`${prefix}-source`}>Provider</Label>
                  <Input
                    id={`${prefix}-source`}
                    name="source"
                    required
                    maxLength={64}
                    value={draft.source}
                    readOnly={Boolean(editing)}
                    onChange={(e) =>
                      setDraft((d) => ({ ...d, source: e.target.value }))
                    }
                    placeholder="e.g. revolut"
                  />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor={`${prefix}-reference`}>
                    Account reference
                  </Label>
                  <Input
                    id={`${prefix}-reference`}
                    name="accountId"
                    required
                    maxLength={200}
                    value={draft.accountId}
                    readOnly={Boolean(editing)}
                    onChange={(e) =>
                      setDraft((d) => ({ ...d, accountId: e.target.value }))
                    }
                    autoComplete="off"
                  />
                </div>
              </div>
              <p className="text-xs leading-relaxed text-muted-foreground">
                {editing
                  ? 'Provider and reference identify this account and cannot be changed here. Add a separate account for a different reference.'
                  : 'Use the same provider and account reference as imported records, or a unique reference for an account you register manually.'}
              </p>
              <div className="space-y-1.5">
                <Label htmlFor={`${prefix}-purpose`}>
                  Account spending rule
                </Label>
                <Choice
                  id={`${prefix}-purpose`}
                  className="w-full"
                  value={draft.purpose}
                  onChange={(purpose) =>
                    setDraft((d) => ({
                      ...d,
                      purpose: purpose as typeof d.purpose,
                    }))
                  }
                  options={[
                    {
                      value: 'personal',
                      label: 'Personal — no account exclusion',
                    },
                    {
                      value: 'business',
                      label: 'Business — exclude from personal spending',
                    },
                    {
                      value: 'investment',
                      label: 'Investment — exclude from personal spending',
                    },
                  ]}
                  placeholder="Choose a spending rule"
                  disabled={saving}
                />
              </div>
              {draft.purpose && (
                <div
                  role="status"
                  className="space-y-2 rounded-lg border bg-muted/40 p-3 text-xs leading-relaxed"
                >
                  <p className="font-medium">
                    {excludesSpending
                      ? 'Effect: exclude this account from personal spending'
                      : 'Effect: remove the account-level exclusion'}
                  </p>
                  <p>
                    {excludesSpending
                      ? 'Every past and future payment on this account is excluded from personal spending totals. This includes transactions individually classified as personal expenses.'
                      : 'This account no longer excludes payments as a group. Individual classifications still apply: transfers, investments and non-personal payments stay outside personal spending.'}
                  </p>
                  <p>
                    Original transactions and their classifications remain
                    available. You can edit this rule later.
                  </p>
                  {editing?.impact ? (
                    <div className="space-y-1 border-t pt-2">
                      <p>
                        {editing.impact.transactionCount} imported transactions
                        on this account.
                      </p>
                      <p>
                        {editing.impact.personalExpenseCount} booked outflows
                        are currently classified as personal expenses:
                      </p>
                      {editing.impact.byCurrency.length ? (
                        editing.impact.byCurrency.map((amount) => (
                          <p
                            key={amount.currency}
                            className="font-medium tabular-nums"
                          >
                            {money(
                              amount.personalExpenseMinor,
                              amount.currency,
                            )}
                          </p>
                        ))
                      ) : (
                        <p>No classified personal-spending amount.</p>
                      )}
                      <p className="text-muted-foreground">
                        These are stored classifications, before the account
                        rule is applied.
                      </p>
                    </div>
                  ) : (
                    <p className="text-muted-foreground">
                      {editing
                        ? 'Impact unavailable. Refresh before changing the rule.'
                        : 'The rule also applies to future imports that match this account reference.'}
                    </p>
                  )}
                </div>
              )}
              <div className="space-y-1.5">
                <Label htmlFor={`${prefix}-reason`}>
                  Reason
                  {purposeChanged ? ' for changing the rule' : ' (optional)'}
                </Label>
                <Input
                  id={`${prefix}-reason`}
                  value={draft.reason}
                  onChange={(event) =>
                    setDraft((current) => ({
                      ...current,
                      reason: event.target.value,
                    }))
                  }
                  required={purposeChanged}
                  maxLength={500}
                  placeholder="e.g. This account is used only for business"
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor={`${prefix}-iban`}>
                  IBAN{' '}
                  <span className="font-normal text-muted-foreground">
                    (optional)
                  </span>
                </Label>
                <Input
                  id={`${prefix}-iban`}
                  name="iban"
                  maxLength={200}
                  value={draft.iban}
                  onChange={(e) =>
                    setDraft((d) => ({ ...d, iban: e.target.value }))
                  }
                  autoComplete="off"
                  spellCheck={false}
                  aria-describedby={`${prefix}-iban-help`}
                />
                <p
                  id={`${prefix}-iban-help`}
                  className="text-xs leading-relaxed text-muted-foreground"
                >
                  {editing?.identifierRegistered
                    ? 'An identifier is already registered. Leave blank to keep it, or enter an IBAN to replace it.'
                    : 'An IBAN helps match transfers. Only its matching hash is stored.'}
                </p>
              </div>
            </fieldset>
            {saveError && (
              <p
                role="alert"
                className="rounded-md bg-destructive/5 p-3 text-sm text-destructive"
              >
                {saveError}
              </p>
            )}
            <DialogFooter>
              <Button
                type="button"
                variant="outline"
                disabled={saving}
                onClick={() => {
                  setOpen(false);
                  setDraft({ ...emptyDraft });
                }}
              >
                Cancel
              </Button>
              <Button
                type="submit"
                disabled={
                  saving ||
                  !identity ||
                  (purposeChanged && !draft.reason.trim()) ||
                  Boolean(editing && purposeChanged && !editing.impact)
                }
              >
                {saving ? (
                  <>
                    <RefreshCw className="mr-2 size-3.5 animate-spin" />
                    Saving…
                  </>
                ) : purposeChanged ? (
                  'Save spending rule'
                ) : (
                  'Save account details'
                )}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </div>
  );
}
