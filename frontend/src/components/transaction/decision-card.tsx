import { useEffect, useId, useRef, useState, type FormEvent } from 'react';
import {
  CheckCheck,
  LoaderCircle,
  MessageCircle,
  Repeat2,
  Sparkles,
} from 'lucide-react';
import {
  explanationSuggestion,
  suggestionFeedback,
} from '@/lib/payment-explanations';
import type { SavedReply as Reply } from '@/lib/reply-history';
import { invalidateFinancialData } from '@/lib/query';
import {
  kinds,
  type Bootstrap,
  type Kind,
  type Rule,
  type SpendingPattern,
  type Submit,
  type Transaction,
  type TriageDecision,
} from '@/lib/transactions';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Combobox,
  MultiCombobox,
  type ComboboxOption,
} from '@/components/combobox';
import { Choice } from '@/components/finance';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';

export type CategoryNode = {
  id: string;
  name: string;
  parentId: string | null;
  assignable: boolean;
  path: string;
};
export type Tag = { id: string; name: string };
export type Step = {
  action: Parameters<Submit>[0];
  values: Record<string, string>;
};

/**
 * Roughly what the owner means by a payment that stands outside the usual
 * pattern. It only ever prompts a question; nothing is decided from it.
 */
const exceptionalHint: Record<string, bigint> = {
  UAH: 2000000n,
  EUR: 50000n,
  USD: 50000n,
  GBP: 45000n,
};

function categoryOptions(nodes: CategoryNode[]): ComboboxOption[] {
  return nodes
    .filter((node) => node.assignable && node.path)
    .map((node) => {
      const parts = node.path.split(' / ');
      return {
        value: node.path,
        label: parts.length > 1 ? parts.slice(1).join(' / ') : node.path,
        display: node.path,
        // A category that hangs directly off the root still belongs under a
        // heading, or it reads as a list with no name above it.
        group: parts.length > 1 ? parts[0]! : 'Top level',
        keywords: parts,
      };
    })
    .sort(
      (a, b) =>
        (a.group ?? '').localeCompare(b.group ?? '') ||
        a.label.localeCompare(b.label),
    );
}

export function DecisionCard({
  transaction: t,
  recognized,
  savedExplanations,
  identity,
  nodes,
  allTags,
  currentTags,
  suggestions,
  convertedMinor,
  displayCurrency,
  busy,
  error,
  submit,
  submitSteps,
}: {
  transaction: Transaction;
  recognized?: TriageDecision;
  savedExplanations: Reply[];
  identity: Bootstrap;
  nodes: CategoryNode[];
  allTags: Tag[];
  currentTags: Tag[];
  suggestions?: { ambiguous: boolean; rules: Rule[] };
  convertedMinor: string | null;
  displayCurrency: string;
  busy: boolean;
  error: string;
  submit: Submit;
  submitSteps: (steps: Step[], message: string) => Promise<void>;
}) {
  const id = useId();
  const initialExplanation = savedExplanations.find(
    (reply) =>
      reply.source === 'app' &&
      reply.revision === t.revision &&
      reply.status !== 'confirmed' &&
      reply.status !== 'rejected',
  );
  const initialSuggestion = explanationSuggestion(initialExplanation?.proposal);
  const [explanationText, setExplanationText] = useState(
    initialExplanation?.input_text ??
      (t.source === 'manual_cash' ? t.description : ''),
  );
  const [explaining, setExplaining] = useState(false);
  const [explanationNotice, setExplanationNotice] = useState('');
  const [explanationError, setExplanationError] = useState('');
  const request = useRef<{ key: string; id: string } | null>(null);
  const edited = useRef(false);
  const [savedText, setSavedText] = useState(
    initialExplanation?.input_text ?? '',
  );
  const [explanationId, setExplanationId] = useState<string | undefined>(
    initialExplanation?.id,
  );
  const [kind, setKind] = useState<Kind>(
    initialSuggestion?.kind ?? t.storedClassification?.kind ?? t.kind,
  );
  const [category, setCategory] = useState(
    (initialSuggestion?.category ??
      (t.storedClassification
        ? t.storedClassification.category
        : t.category)) ||
      '',
  );
  const [reason, setReason] = useState(
    initialExplanation?.input_text.slice(0, 500) ?? '',
  );
  const [futureRule, setFutureRule] = useState(false);
  const [tagIds, setTagIds] = useState<string[]>(
    currentTags.map((tag) => tag.id),
  );
  const [pattern, setPattern] = useState<SpendingPattern>(
    t.spendingPattern?.pattern ?? 'unreviewed',
  );
  // An exact-match rule needs description text to match on, and 'unresolved'
  // is the absence of a decision rather than one worth repeating.
  const ruleAvailable = kind !== 'unresolved' && t.description.trim() !== '';
  const outgoing = BigInt(t.amountMinor) < 0n;
  const patternAvailable =
    t.owner === identity.actor && t.status === 'booked' && outgoing;
  const threshold = exceptionalHint[displayCurrency];
  const looksExceptional =
    patternAvailable &&
    pattern === 'unreviewed' &&
    threshold !== undefined &&
    convertedMinor !== null &&
    BigInt(convertedMinor) < -threshold;
  const fields = { id: t.id, revision: String(t.revision) };
  /**
   * A suggestion names tags; the editor works in ids. Names the household no
   * longer has are dropped rather than silently recreated, and tags the owner
   * already put on the payment are kept: a suggestion adds, it does not clear.
   */
  const withSuggestedTags = (names: string[] | undefined) => {
    if (!names?.length) return;
    const byName = new Map(
      allTags.map((tag) => [tag.name.toLocaleLowerCase(), tag.id]),
    );
    const suggested = names
      .map((name) => byName.get(name.toLocaleLowerCase()))
      .filter((id): id is string => Boolean(id));
    if (suggested.length)
      setTagIds((current) => [...new Set([...current, ...suggested])]);
  };
  useEffect(() => {
    if (edited.current) return;
    const saved = savedExplanations.find(
      (reply) =>
        reply.source === 'app' &&
        reply.revision === t.revision &&
        reply.status !== 'confirmed' &&
        reply.status !== 'rejected',
    );
    const suggestion = explanationSuggestion(saved?.proposal);
    if (saved) {
      setExplanationText(saved.input_text);
      setSavedText(saved.input_text);
      setExplanationId(saved.id);
    }
    if (suggestion) {
      setKind(suggestion.kind);
      setCategory(suggestion.category ?? '');
      withSuggestedTags(suggestion.tags);
      setReason(
        saved?.input_text.slice(0, 500) ?? suggestion.explanation.slice(0, 500),
      );
    }
  }, [savedExplanations, t.source, t.revision]);

  async function saveExplanation(event: FormEvent) {
    event.preventDefault();
    if (!explanationText.trim() || busy || explaining) return;
    const key = JSON.stringify([t.id, t.revision, explanationText.trim()]);
    if (request.current?.key !== key)
      request.current = { key, id: crypto.randomUUID() };
    setExplaining(true);
    setExplanationError('');
    setExplanationNotice('');
    try {
      const response = await fetch('/api/payment-explanations', {
        method: 'POST',
        credentials: 'same-origin',
        body: new URLSearchParams({
          ...fields,
          text: explanationText.trim(),
          csrf: identity.csrf,
          requestId: request.current.id,
        }),
      });
      if (!response.ok)
        throw new Error(
          response.status === 409
            ? 'This payment changed. Refresh it before trying again.'
            : 'Could not confirm the save. Retry the same explanation to check safely.',
        );
      const result = (await response.json()) as {
        explanation: Reply;
        proposal?: { id: string; proposal: unknown };
        suggestionStatus?: string;
      };
      if (!result.explanation?.id)
        throw new Error(
          'Could not confirm the saved explanation. Retry to check safely.',
        );
      setSavedText(explanationText.trim());
      setExplanationId(result.explanation.id);
      setReason(explanationText.trim().slice(0, 500));
      setExplanationNotice(suggestionFeedback(result.suggestionStatus));
      const suggestion = explanationSuggestion(result.proposal?.proposal);
      if (suggestion) {
        edited.current = true;
        setKind(suggestion.kind);
        setCategory(suggestion.category ?? '');
        withSuggestedTags(suggestion.tags);
        setReason(explanationText.trim().slice(0, 500));
      }
      await invalidateFinancialData();
    } catch (cause) {
      setExplanationError(
        cause instanceof Error
          ? cause.message
          : 'Could not save this explanation.',
      );
    } finally {
      setExplaining(false);
    }
  }

  function confirm(event: FormEvent) {
    event.preventDefault();
    if (busy || explaining) return;
    const steps: Step[] = [];
    // Order matters: confirming the decision raises the payment's revision, so
    // anything checked against the current revision has to be saved first.
    if (
      patternAvailable &&
      pattern !== (t.spendingPattern?.pattern ?? 'unreviewed')
    )
      steps.push({
        action: '/spending-pattern',
        values: {
          ...fields,
          annotationRevision: String(t.spendingPattern?.revision ?? 0),
          pattern,
          reason: `Owner marked this payment as ${pattern}`,
        },
      });
    const before = [...currentTags.map((tag) => tag.id)].sort().join(',');
    if ([...tagIds].sort().join(',') !== before)
      steps.push({
        action: '/tags',
        values: { id: t.id, tagIds: tagIds.join(',') },
      });
    steps.push({
      action: '/classify',
      values: {
        ...fields,
        ...(explanationId ? { explanationId } : {}),
        ...(futureRule && ruleAvailable ? { futureRule: 'yes' } : {}),
        kind,
        category,
        reason,
      },
    });
    void submitSteps(
      steps,
      futureRule && ruleAvailable
        ? 'Your decision was saved, and future payments with the same description will follow it.'
        : 'Your decision was saved.',
    );
  }

  const options = categoryOptions(nodes);
  const tagOptions: ComboboxOption[] = allTags.map((tag) => ({
    value: tag.id,
    label: tag.name,
  }));
  const disabled = busy || explaining;
  return (
    <div className="space-y-5">
      <form onSubmit={saveExplanation} className="space-y-3">
        <div className="grid gap-2">
          <Label
            htmlFor={`${id}-explanation`}
            className="text-base font-semibold"
          >
            What was this payment for?
          </Label>
          <p className="text-sm text-muted-foreground">
            Explain it in your own words. We save your explanation first, then
            suggest the fields for you to confirm.
          </p>
          <textarea
            id={`${id}-explanation`}
            value={explanationText}
            onChange={(event) => {
              edited.current = true;
              setExplanationText(event.target.value);
            }}
            maxLength={2000}
            required
            disabled={disabled}
            rows={4}
            className="min-h-28 w-full rounded-md border border-input bg-transparent px-3 py-2 text-base outline-none focus-visible:ring-2 focus-visible:ring-ring sm:text-sm"
            placeholder="For example: dinner with friends, or a gift for our parents"
          />
        </div>
        <div className="flex flex-wrap gap-2">
          <Button
            className="flex-1"
            disabled={
              disabled ||
              !explanationText.trim() ||
              explanationText.trim() === savedText.trim()
            }
          >
            {explaining ? (
              <LoaderCircle className="size-4 animate-spin" />
            ) : (
              <Sparkles className="size-4" />
            )}
            {explaining ? 'Saving explanation…' : 'Save explanation & suggest'}
          </Button>
          <Button
            type="button"
            variant="outline"
            disabled={busy || !identity.features.telegram}
            title={
              identity.features.telegram
                ? 'Send this payment to Telegram and answer there'
                : 'Telegram is not configured yet'
            }
            onClick={() => void submit('/telegram/queue', fields)}
          >
            <MessageCircle className="size-4" />
            Ask in Telegram
          </Button>
        </div>
        {explanationNotice && (
          <p role="status" className="text-sm text-muted-foreground">
            {explanationNotice}
          </p>
        )}
        {explanationError && (
          <p role="alert" className="text-sm text-destructive">
            {explanationError}
          </p>
        )}
        {explanationText.trim() &&
          explanationText.trim() === savedText.trim() && (
            <p className="text-xs text-muted-foreground">
              This explanation is already saved. Edit it to add new context.
            </p>
          )}
      </form>

      {!outgoing && (
        <p className="rounded-lg border bg-muted/30 p-3 text-sm text-muted-foreground">
          Money in — outside personal spending. Classification is optional and
          will not turn this into a purchase.
        </p>
      )}
      {error && (
        <p
          role="alert"
          className="rounded-lg border border-destructive/30 p-3 text-sm text-destructive"
        >
          {error}
        </p>
      )}
      {t.spendingPolicy?.excluded && (
        <section
          className="space-y-2 rounded-lg border border-amber-500/30 bg-amber-500/5 p-3 text-xs leading-relaxed"
          aria-label="Account spending exclusion"
        >
          <p className="font-medium text-amber-800 dark:text-amber-300">
            Excluded from personal spending by an account rule
          </p>
          <p>
            {t.spendingPolicy.accountLabel || 'This account'} is marked as{' '}
            {t.spendingPolicy.accountPurpose === 'investment'
              ? 'an investment account'
              : 'a business account'}
            . Its past and future payments stay outside personal spending
            totals.
          </p>
          <a
            href="/accounts"
            className="inline-flex min-h-9 items-center font-medium text-primary underline underline-offset-4"
          >
            Edit the account rule in Accounts &amp; exclusions
          </a>
        </section>
      )}
      {recognized && (
        <div className="space-y-2 rounded-lg border bg-muted/30 p-3">
          {recognized.source === 'historical_evidence' && (
            <p className="text-xs font-medium text-muted-foreground">
              Based on your previous explanation · matched privately on this
              server
            </p>
          )}
          <p className="text-sm font-medium">
            {recognized.category ?? kinds[recognized.kind]}
          </p>
          <p className="text-sm text-muted-foreground">
            {recognized.explanation}
          </p>
          <Button
            size="sm"
            variant="outline"
            disabled={disabled}
            onClick={() => {
              edited.current = true;
              setKind(recognized.kind);
              setCategory(recognized.category ?? '');
              setReason(recognized.explanation.slice(0, 500));
            }}
          >
            Use suggestion
          </Button>
        </div>
      )}
      {Boolean(suggestions?.rules.length) && (
        <div className="space-y-2 rounded-lg border bg-muted/30 p-3">
          <p className="text-xs font-medium">
            {suggestions?.ambiguous
              ? 'Conflicting rules — check the context'
              : 'Your confirmed-rule suggestions'}
          </p>
          {suggestions!.rules.map((rule) => {
            const rulePath =
              nodes.find((node) => node.id === rule.categoryId)?.path ?? '';
            return (
              <div
                key={rule.id}
                className="flex flex-wrap items-center justify-between gap-2"
              >
                <p className="min-w-0 text-xs break-words">
                  {kinds[rule.kind]}
                  {rulePath ? ` · ${rulePath}` : ''}
                </p>
                <Button
                  variant="outline"
                  size="sm"
                  type="button"
                  disabled={disabled}
                  onClick={() => {
                    edited.current = true;
                    setKind(rule.kind);
                    setCategory(rulePath);
                  }}
                >
                  Use in form
                </Button>
              </div>
            );
          })}
          <p className="text-xs text-muted-foreground">
            Using a suggestion fills the form. Save your decision to confirm it.
          </p>
        </div>
      )}

      <form onSubmit={confirm} className="space-y-4">
        <h2 className="text-base font-semibold">
          {t.spendingPolicy?.excluded
            ? 'Stored payment classification'
            : 'Your decision'}
        </h2>
        <fieldset disabled={disabled} className="space-y-4">
          <div className="grid gap-2">
            <Label htmlFor={`${id}-kind`}>Payment type</Label>
            <Choice
              id={`${id}-kind`}
              className="w-full"
              value={kind}
              onChange={(value) => {
                edited.current = true;
                setKind(value as Kind);
              }}
              options={Object.entries(kinds).map(([value, label]) => ({
                value,
                label,
              }))}
              disabled={disabled}
            />
          </div>
          <div className="grid gap-2">
            <Label htmlFor={`${id}-category`}>
              Category{kind === 'personal_expense' ? '' : ' (optional)'}
            </Label>
            <Combobox
              id={`${id}-category`}
              options={options}
              value={category}
              onChange={(value) => {
                edited.current = true;
                setCategory(value);
              }}
              placeholder="Choose a category"
              searchPlaceholder="Type to search categories…"
              // A payment is filed on a node of the shared tree, so an invented
              // name would only be rejected on save. Offer the way to add one.
              empty={
                <span className="block text-sm">
                  No category matches that search.{' '}
                  <a
                    href="/categories"
                    className="underline underline-offset-4"
                  >
                    Add one under Categories &amp; rules
                  </a>
                  .
                </span>
              }
              disabled={disabled}
              invalid={kind === 'personal_expense' && !category.trim()}
            />
            <a
              href="/categories"
              className="text-xs text-muted-foreground underline underline-offset-4"
            >
              Manage categories
            </a>
          </div>
          <div className="grid gap-2">
            <Label htmlFor={`${id}-tags`}>Tags (optional)</Label>
            <MultiCombobox
              id={`${id}-tags`}
              options={tagOptions}
              values={tagIds}
              onChange={(values) => {
                edited.current = true;
                setTagIds(values);
              }}
              placeholder={
                tagOptions.length ? 'Add a tag' : 'No tags created yet'
              }
              searchPlaceholder="Type to search tags…"
              emptyText="No tag matches that search."
              disabled={disabled || !tagOptions.length}
            />
          </div>
          {patternAvailable && (
            <div className="grid gap-2">
              {/* A toggle group is not a labelable control, so it is named
                  rather than pointed at with `for`. */}
              <p
                id={`${id}-pattern-label`}
                className="flex items-center gap-2 text-sm font-medium"
              >
                <Repeat2 aria-hidden="true" className="size-4" />
                How does this fit your spending?
              </p>
              <ToggleGroup
                aria-labelledby={`${id}-pattern-label`}
                variant="outline"
                className="w-full"
                value={pattern === 'unreviewed' ? [] : [pattern]}
                onValueChange={(values) => {
                  edited.current = true;
                  setPattern((values[0] || 'unreviewed') as SpendingPattern);
                }}
              >
                <ToggleGroupItem value="routine" className="flex-1">
                  Routine
                </ToggleGroupItem>
                <ToggleGroupItem value="exceptional" className="flex-1">
                  Exceptional
                </ToggleGroupItem>
              </ToggleGroup>
              {looksExceptional && (
                <p className="text-xs text-amber-700 dark:text-amber-400">
                  This is a large payment. Mark it exceptional if it was not
                  part of your usual spending.
                </p>
              )}
              {t.spendingPattern?.needsReview && (
                <p
                  role="status"
                  className="text-xs text-amber-700 dark:text-amber-400"
                >
                  The payment changed since this was last reviewed. Confirm it
                  again.
                </p>
              )}
            </div>
          )}
          <div className="grid gap-2">
            <Label htmlFor={`${id}-reason`}>Why this decision?</Label>
            <Input
              id={`${id}-reason`}
              value={reason}
              onChange={(event) => {
                edited.current = true;
                setReason(event.target.value);
              }}
              required
              maxLength={500}
              placeholder="A brief explanation for your records"
            />
          </div>
          {ruleAvailable && (
            <label className="flex items-start gap-2 rounded-lg border p-3 text-sm">
              <input
                type="checkbox"
                className="mt-0.5"
                checked={futureRule}
                disabled={disabled}
                onChange={(event) => setFutureRule(event.target.checked)}
              />
              <span className="text-muted-foreground">
                Apply this to future payments described exactly as{' '}
                <span className="font-medium text-foreground [overflow-wrap:anywhere]">
                  “{t.description}”
                </span>
                . Saved as a rule you can see and disable under{' '}
                <a href="/categories" className="underline underline-offset-4">
                  Categories &amp; rules
                </a>
                .
              </span>
            </label>
          )}
          <Button
            type="submit"
            className="w-full"
            disabled={
              disabled ||
              !reason.trim() ||
              (kind === 'personal_expense' && !category.trim())
            }
          >
            {busy ? (
              <LoaderCircle className="size-4 animate-spin" />
            ) : (
              <CheckCheck className="size-4" />
            )}
            {t.spendingPolicy?.excluded
              ? 'Confirm stored classification'
              : 'Confirm decision'}
          </Button>
        </fieldset>
      </form>
    </div>
  );
}
