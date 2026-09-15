import { invalidateFinancialData, observeSession } from './lib/query';
import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useState,
  type FormEvent,
} from 'react';
import {
  ArrowRight,
  Check,
  CircleAlert,
  FolderTree,
  ListFilter,
  Plus,
  RefreshCw,
  ShieldCheck,
  Tag,
  X,
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
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';

type Node = {
  id: string;
  slug: string;
  name: string;
  parentId: string | null;
  depth: number;
  sortOrder: number;
  /** A payment may only be filed on a leaf; a node with children is a heading. */
  assignable: boolean;
  path: string;
};
type TagRecord = { id: string; name: string };
type Rule = {
  id: string;
  owner: string;
  version: number;
  matcher: {
    field: 'description' | 'counterparty' | 'description_contains';
    value: string;
  };
  kind: string;
  categoryId: string | null;
  active: boolean;
};
type Identity = { actor: 'rodion' | 'katya'; csrf: string };
const kinds: Record<string, string> = {
  personal_expense: 'Personal expense',
  internal_transfer: 'Internal transfer',
  investment: 'Investment',
  non_personal: 'Non-personal',
  unresolved: 'Unresolved',
};
const initialRule = {
  matcherField: 'description' as
    'description' | 'counterparty' | 'description_contains',
  matcherValue: '',
  kind: 'personal_expense',
  categoryId: '',
  reason: '',
  confirmed: false,
};
function reference(response: Response) {
  const id = response.headers.get('X-Request-Id');
  return id && /^[a-zA-Z0-9-]{1,80}$/.test(id) ? ` Reference: ${id}.` : '';
}
function nodePath(nodes: Node[], id: string) {
  return nodes.find((n) => n.id === id)?.path ?? '';
}

export default function Categories() {
  const [identity, setIdentity] = useState<Identity>();
  const [nodes, setNodes] = useState<Node[]>([]);
  const [tagList, setTagList] = useState<TagRecord[]>([]);
  const [rules, setRules] = useState<Rule[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [dialog, setDialog] = useState<'node' | 'rule' | null>(null);
  const [formError, setFormError] = useState('');
  const [nodeDraft, setNodeDraft] = useState({
    name: '',
    type: 'category' as 'category' | 'tag',
    parentId: '',
  });
  const MAX_DEPTH = 3;
  const [ruleDraft, setRuleDraft] = useState(initialRule);
  const prefix = useId();
  const load = useCallback(async (signal?: AbortSignal) => {
    setLoading(true);
    setError('');
    try {
      const [bootstrap, data] = await Promise.all(
        ['/api/bootstrap', '/api/categories'].map(async (path) => {
          const response = await fetch(path, {
            signal,
            credentials: 'same-origin',
            headers: { Accept: 'application/json' },
          });
          if (!response.ok)
            throw new Error(
              (response.status === 401 || response.status === 403
                ? 'Your session needs attention. Reload to sign in again.'
                : 'Could not load categories and rules. Please try again.') +
                reference(response),
            );
          return response.json();
        }),
      );
      if (signal?.aborted) return;
      if (
        !['rodion', 'katya'].includes(bootstrap.actor) ||
        typeof bootstrap.csrf !== 'string' ||
        !bootstrap.csrf ||
        !Array.isArray(data.nodes) ||
        !Array.isArray(data.tags) ||
        !Array.isArray(data.rules)
      )
        throw new Error(
          'The categories response was incomplete. Please refresh.',
        );
      observeSession(bootstrap);
      setIdentity({ actor: bootstrap.actor, csrf: bootstrap.csrf });
      setNodes(data.nodes);
      setTagList(data.tags);
      setRules(data.rules);
    } catch (e) {
      if (!signal?.aborted)
        setError(
          e instanceof Error && !(e instanceof TypeError)
            ? e.message
            : 'Could not reach your categories. Check your connection and try again.',
        );
    } finally {
      if (!signal?.aborted) setLoading(false);
    }
  }, []);
  useEffect(() => {
    const controller = new AbortController();
    void load(controller.signal);
    return () => controller.abort();
  }, [load]);
  async function mutate(
    path: string,
    fields: Record<string, string>,
    key: string,
    success: string,
    inDialog = false,
  ) {
    if (!identity || busy) return;
    setBusy(key);
    setFormError('');
    setError('');
    setNotice('');
    try {
      const response = await fetch(path, {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ csrf: identity.csrf, ...fields }),
      });
      if (!response.ok)
        throw new Error(
          (response.status === 409
            ? 'This rule changed since you opened it. Refresh before making another change.'
            : response.status === 401 || response.status === 403
              ? 'Your session changed. Reload the page before saving.'
              : 'The change was not saved. Check the fields and any existing category names, then try again.') +
            reference(response),
        );
      if (
        !response.redirected ||
        new URL(response.url).pathname !== '/categories'
      )
        throw new Error(
          'The change could not be confirmed. Refresh before trying again.' +
            reference(response),
        );
      await invalidateFinancialData();
      setDialog(null);
      setNotice(success);
      await load();
    } catch (e) {
      const message =
        e instanceof Error && !(e instanceof TypeError)
          ? e.message
          : 'The change could not be confirmed. Check your connection and refresh before trying again.';
      if (inDialog) setFormError(message);
      else setError(message);
    } finally {
      setBusy('');
    }
  }
  function createNode(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!nodeDraft.name.trim()) {
      setFormError('Enter a name.');
      return;
    }
    if (nodeDraft.type === 'tag') {
      void mutate(
        '/tags/new',
        { name: nodeDraft.name.trim() },
        'node',
        'Tag added.',
        true,
      );
      return;
    }
    const parent = nodes.find((n) => n.id === nodeDraft.parentId);
    if (parent && parent.depth >= MAX_DEPTH) {
      setFormError(
        'Categories go three levels deep at most. Choose a higher parent.',
      );
      return;
    }
    void mutate(
      '/categories',
      { name: nodeDraft.name.trim(), parentId: nodeDraft.parentId },
      'node',
      parent && parent.assignable
        ? `Category added. Payments filed directly on ${parent.name} moved to ${parent.name} / Unspecified, because a category with subcategories is a heading.`
        : 'Category added.',
      true,
    );
  }
  function createRule(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (
      !ruleDraft.matcherValue.trim() ||
      !ruleDraft.reason.trim() ||
      !ruleDraft.confirmed
    ) {
      setFormError(
        'Add the exact match text and reason, then confirm this future suggestion rule.',
      );
      return;
    }
    if (ruleDraft.kind === 'personal_expense' && !ruleDraft.categoryId) {
      setFormError('Choose a category for personal expenses.');
      return;
    }
    void mutate(
      '/rules',
      {
        matcherField: ruleDraft.matcherField,
        matcherValue: ruleDraft.matcherValue,
        kind: ruleDraft.kind,
        categoryId: ruleDraft.categoryId,
        reason: ruleDraft.reason.trim(),
        confirmed: 'yes',
      },
      'rule',
      'Rule created. Future matches will be suggestions for review.',
      true,
    );
  }
  function addNode(type: 'category' | 'tag') {
    setNodeDraft({ name: '', type, parentId: '' });
    setFormError('');
    setDialog('node');
  }
  const categories = useMemo(
    () => [...nodes].sort((a, b) => a.path.localeCompare(b.path)),
    [nodes],
  );
  const tags = useMemo(
    () => [...tagList].sort((a, b) => a.name.localeCompare(b.name)),
    [tagList],
  );
  const activeRules = rules.filter((r) => r.active).length;
  const ownerName = identity?.actor === 'rodion' ? 'Rodion' : 'Katya';

  return (
    <div className="mx-auto max-w-7xl space-y-6 pb-8">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <p className="mb-1 text-xs font-medium uppercase tracking-[0.14em] text-muted-foreground">
            Household finances
          </p>
          <h1 className="text-2xl font-semibold tracking-tight sm:text-3xl">
            Categories & rules
          </h1>
          <p className="mt-2 max-w-xl text-sm leading-relaxed text-muted-foreground">
            Organize your spending and make repeat decisions easier, with you in
            control.
          </p>
        </div>
        <Button
          variant="outline"
          size="sm"
          disabled={loading || !!busy}
          onClick={() => void load()}
        >
          <RefreshCw
            className={`mr-2 size-3.5 ${loading ? 'animate-spin' : ''}`}
          />
          Refresh
        </Button>
      </div>
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
            disabled={loading || !!busy}
            onClick={() => void load()}
          >
            Refresh
          </Button>
        </div>
      )}
      {loading ? (
        <div
          role="status"
          aria-label="Loading categories"
          className="space-y-4"
        >
          <div className="grid gap-4 md:grid-cols-2">
            <Skeleton className="h-60 rounded-xl" />
            <Skeleton className="h-60 rounded-xl" />
          </div>
          <Skeleton className="h-56 rounded-xl" />
          <span className="sr-only">Loading your categories and rules</span>
        </div>
      ) : (
        identity && (
          <>
            <div className="flex flex-wrap items-center justify-between gap-3 text-xs text-muted-foreground">
              <span>
                Shared by the household · rules saved by{' '}
                <span className="font-medium text-foreground">{ownerName}</span>
              </span>
              <span>
                {categories.length} categories · {tags.length} tags ·{' '}
                {activeRules} active rules
              </span>
            </div>
            <div className="grid items-start gap-5 lg:grid-cols-2">
              {(
                [
                  {
                    type: 'category',
                    title: 'Spending categories',
                    subtitle:
                      'One shared tree, so a family total means something. A payment is filed on a leaf.',
                    list: categories,
                    icon: FolderTree,
                  },
                  {
                    type: 'tag',
                    title: 'Tags',
                    subtitle: 'Add another layer of context to a transaction.',
                    list: tags,
                    icon: Tag,
                  },
                ] as const
              ).map(({ type, title, subtitle, list, icon: Icon }) => (
                <Card key={type} className="min-w-0 shadow-none">
                  <CardHeader className="flex flex-row items-start justify-between gap-3">
                    <div>
                      <CardTitle className="flex items-center gap-2 text-base">
                        <Icon className="size-4 text-muted-foreground" />
                        {title}
                      </CardTitle>
                      <p className="mt-1.5 text-xs leading-relaxed text-muted-foreground">
                        {subtitle}
                      </p>
                    </div>
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={!!busy}
                      onClick={() => addNode(type)}
                    >
                      <Plus className="mr-1 size-3.5" />
                      Add
                    </Button>
                  </CardHeader>
                  <CardContent>
                    {list.length ? (
                      <div className="space-y-1">
                        {list.map((node) => (
                          <div
                            key={node.id}
                            className="flex items-start gap-2 rounded-md px-2 py-2 text-sm"
                          >
                            <Icon className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" />
                            <div className="min-w-0">
                              <p className="break-words font-medium">
                                {node.name}
                                {'assignable' in node && !node.assignable && (
                                  <span className="ml-2 text-xs font-normal text-muted-foreground">
                                    heading
                                  </span>
                                )}
                              </p>
                              {'parentId' in node && node.parentId && (
                                <p className="mt-0.5 break-words text-xs text-muted-foreground">
                                  Under {nodePath(nodes, node.parentId)}
                                </p>
                              )}
                            </div>
                          </div>
                        ))}
                      </div>
                    ) : (
                      <div className="rounded-lg bg-muted/40 p-5 text-center">
                        <p className="text-sm font-medium">
                          {type === 'category'
                            ? 'A useful place to start'
                            : 'No tags yet'}
                        </p>
                        <p className="mx-auto mt-1.5 max-w-sm text-xs leading-relaxed text-muted-foreground">
                          {type === 'category'
                            ? 'Add your own categories or start with a ready-made set.'
                            : 'Create tags for the context you want to keep, such as a trip or project.'}
                        </p>
                      </div>
                    )}
                    {type === 'category' && (
                      <div className="mt-4 border-t pt-4">
                        <p className="text-xs leading-relaxed text-muted-foreground">
                          The tree is shared by both of you and is meant to
                          change as your understanding does. Renaming a category
                          never rewrites past payments.
                        </p>
                      </div>
                    )}
                  </CardContent>
                </Card>
              ))}
            </div>
            <Card className="shadow-none">
              <CardHeader className="flex flex-row flex-wrap items-start justify-between gap-3">
                <div>
                  <CardTitle className="flex items-center gap-2 text-base">
                    <ListFilter className="size-4 text-muted-foreground" />
                    Confirmed suggestion rules
                  </CardTitle>
                  <p className="mt-1.5 max-w-lg text-xs leading-relaxed text-muted-foreground">
                    An exact match proposes a classification. It never applies a
                    decision automatically.
                  </p>
                </div>
                <Button
                  size="sm"
                  disabled={!!busy}
                  onClick={() => {
                    setRuleDraft({ ...initialRule });
                    setFormError('');
                    setDialog('rule');
                  }}
                >
                  <Plus className="mr-1.5 size-3.5" />
                  Create rule
                </Button>
              </CardHeader>
              <CardContent>
                {rules.length ? (
                  <div className="divide-y">
                    {[...rules]
                      .sort(
                        (a, b) =>
                          Number(b.active) - Number(a.active) ||
                          a.matcher.value.localeCompare(b.matcher.value),
                      )
                      .map((rule) => (
                        <div
                          key={rule.id}
                          className="flex flex-wrap items-start justify-between gap-4 py-4 first:pt-0 last:pb-0"
                        >
                          <div className="min-w-0 flex-1 basis-56">
                            <div className="flex flex-wrap items-center gap-2">
                              <Badge
                                variant={rule.active ? 'secondary' : 'outline'}
                              >
                                {rule.active ? 'Active' : 'Disabled'}
                              </Badge>
                              <span className="text-xs text-muted-foreground">
                                Version {rule.version} ·{' '}
                                {rule.matcher.field === 'counterparty'
                                  ? 'exact counterparty'
                                  : rule.matcher.field ===
                                      'description_contains'
                                    ? 'description contains'
                                    : 'exact description'}
                              </span>
                            </div>
                            <p className="mt-2 break-words text-sm font-medium">
                              {rule.matcher.value}
                            </p>
                            <div className="mt-2 flex items-start gap-1.5 text-xs text-muted-foreground">
                              <ArrowRight className="mt-0.5 size-3 shrink-0" />
                              <span>
                                {kinds[rule.kind] || 'Classification'}
                                {rule.categoryId
                                  ? ` · ${nodePath(nodes, rule.categoryId) || 'Category unavailable'}`
                                  : ''}
                              </span>
                            </div>
                          </div>
                          <Button
                            size="sm"
                            variant="ghost"
                            disabled={!rule.active || !!busy}
                            onClick={() =>
                              void mutate(
                                '/rules/disable',
                                { id: rule.id, version: String(rule.version) },
                                rule.id,
                                'Rule disabled. Previous transaction decisions are unchanged.',
                              )
                            }
                            aria-label={`Disable rule for ${rule.matcher.value}`}
                          >
                            <X className="mr-1.5 size-3.5" />
                            {busy === rule.id ? 'Disabling…' : 'Disable'}
                          </Button>
                        </div>
                      ))}
                  </div>
                ) : (
                  <div className="flex items-start gap-3 rounded-lg bg-muted/40 p-4">
                    <ShieldCheck className="mt-0.5 size-5 shrink-0 text-muted-foreground" />
                    <div>
                      <p className="text-sm font-medium">
                        No automatic assumptions
                      </p>
                      <p className="mt-1 max-w-lg text-xs leading-relaxed text-muted-foreground">
                        Create a rule when you’re confident a particular
                        description or counterparty should suggest the same
                        classification next time. You’ll still review each
                        suggestion.
                      </p>
                    </div>
                  </div>
                )}
              </CardContent>
            </Card>
            <p className="flex items-start gap-2 px-1 text-xs leading-relaxed text-muted-foreground">
              <ShieldCheck className="mt-0.5 size-3.5 shrink-0" />
              Categories, tags and rules belong to your signed-in account. An
              answer about one transaction does not create a future rule unless
              you explicitly confirm it.
            </p>
          </>
        )
      )}
      <Dialog
        open={dialog !== null}
        onOpenChange={(next) => {
          if (!next && !busy) setDialog(null);
        }}
      >
        <DialogContent className="max-h-[90dvh] overflow-y-auto sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>
              {dialog === 'node'
                ? `Add a ${nodeDraft.type}`
                : 'Create an exact-match rule'}
            </DialogTitle>
            <DialogDescription>
              {dialog === 'node'
                ? nodeDraft.type === 'tag'
                  ? 'Tags are free-form and never counted as spending.'
                  : 'One shared tree for the household.'
                : 'Save a suggestion for future matching transactions. Every application still needs review.'}
            </DialogDescription>
          </DialogHeader>
          {dialog === 'node' ? (
            <form onSubmit={createNode} className="space-y-4">
              <fieldset disabled={!!busy} className="space-y-4">
                <div className="space-y-1.5">
                  <Label htmlFor={`${prefix}-name`}>Name</Label>
                  <Input
                    id={`${prefix}-name`}
                    maxLength={80}
                    required
                    value={nodeDraft.name}
                    onChange={(e) =>
                      setNodeDraft((d) => ({ ...d, name: e.target.value }))
                    }
                    autoFocus
                  />
                </div>
                {nodeDraft.type === 'category' && (
                  <div className="space-y-1.5">
                    <Label htmlFor={`${prefix}-parent`}>Parent</Label>
                    <Select
                      disabled={!!busy}
                      value={nodeDraft.parentId || 'none'}
                      onValueChange={(value) =>
                        setNodeDraft((d) => ({
                          ...d,
                          parentId: value === 'none' ? '' : value,
                        }))
                      }
                    >
                      <SelectTrigger id={`${prefix}-parent`} className="w-full">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="none">None</SelectItem>
                        {categories
                          .filter((n) => n.depth < MAX_DEPTH)
                          .map((n) => (
                            <SelectItem key={n.id} value={n.id}>
                              {n.path}
                            </SelectItem>
                          ))}
                      </SelectContent>
                    </Select>
                  </div>
                )}
                <p className="text-xs leading-relaxed text-muted-foreground">
                  {nodeDraft.type === 'tag'
                    ? 'A tag groups payments without becoming a category, so it is never added to a category total.'
                    : 'Giving a category subcategories turns it into a heading; anything filed directly on it moves to its Unspecified leaf.'}
                </p>
              </fieldset>
              {formError && (
                <p role="alert" className="text-sm text-destructive">
                  {formError}
                </p>
              )}
              <DialogFooter>
                <Button
                  type="button"
                  variant="outline"
                  disabled={!!busy}
                  onClick={() => setDialog(null)}
                >
                  Cancel
                </Button>
                <Button disabled={!!busy} type="submit">
                  {busy ? 'Saving…' : `Add ${nodeDraft.type}`}
                </Button>
              </DialogFooter>
            </form>
          ) : (
            <form onSubmit={createRule} className="space-y-4">
              <fieldset disabled={!!busy} className="space-y-4">
                <div className="space-y-1.5">
                  <Label htmlFor={`${prefix}-matcher`}>Match on</Label>
                  <Select
                    disabled={!!busy}
                    value={ruleDraft.matcherField}
                    onValueChange={(value) =>
                      setRuleDraft((d) => ({
                        ...d,
                        matcherField: value as
                          | 'description'
                          | 'counterparty'
                          | 'description_contains',
                      }))
                    }
                  >
                    <SelectTrigger id={`${prefix}-matcher`} className="w-full">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="description">
                        Exact description
                      </SelectItem>
                      <SelectItem value="description_contains">
                        Descriptions containing this text
                      </SelectItem>
                      <SelectItem value="counterparty">
                        Exact counterparty identifier
                      </SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor={`${prefix}-description`}>
                    {ruleDraft.matcherField === 'description'
                      ? 'Exact transaction description'
                      : ruleDraft.matcherField === 'description_contains'
                        ? 'Text the description must contain'
                        : 'Exact counterparty identifier'}
                  </Label>
                  <Input
                    id={`${prefix}-description`}
                    required
                    maxLength={2000}
                    value={ruleDraft.matcherValue}
                    onChange={(e) =>
                      setRuleDraft((d) => ({
                        ...d,
                        matcherValue: e.target.value,
                      }))
                    }
                    autoFocus
                  />
                  <p className="text-xs leading-relaxed text-muted-foreground">
                    {ruleDraft.matcherField === 'counterparty'
                      ? 'Use the exact counterparty identifier supplied with the transaction. A display name is not sufficient.'
                      : ruleDraft.matcherField === 'description_contains'
                        ? 'Type only the part that stays the same, such as “Sent money to Rodion Salnik”. Capitalization does not matter, and there are no wildcards to add. A rule matching the whole description always wins over this one.'
                        : 'Copy the description exactly, including spaces and capitalization. Similar names alone won’t match.'}
                  </p>
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor={`${prefix}-kind`}>
                    Suggested classification
                  </Label>
                  <Select
                    disabled={!!busy}
                    value={ruleDraft.kind}
                    onValueChange={(kind) =>
                      setRuleDraft((d) => ({ ...d, kind, categoryId: '' }))
                    }
                  >
                    <SelectTrigger id={`${prefix}-kind`} className="w-full">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {Object.entries(kinds).map(([value, name]) => (
                        <SelectItem key={value} value={value}>
                          {name}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor={`${prefix}-category`}>
                    Category
                    {ruleDraft.kind === 'personal_expense'
                      ? ' (required)'
                      : ' (optional)'}
                  </Label>
                  <Select
                    disabled={!!busy}
                    value={ruleDraft.categoryId || 'none'}
                    onValueChange={(value) =>
                      setRuleDraft((d) => ({
                        ...d,
                        categoryId: value === 'none' ? '' : value,
                      }))
                    }
                  >
                    <SelectTrigger id={`${prefix}-category`} className="w-full">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="none">None</SelectItem>
                      {categories.map((n) => (
                        <SelectItem key={n.id} value={n.id}>
                          {nodePath(nodes, n.id)}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  {!categories.length && (
                    <p className="text-xs text-muted-foreground">
                      Add a category before creating a personal-expense rule.
                    </p>
                  )}
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor={`${prefix}-reason`}>
                    Why should this rule be suggested?
                  </Label>
                  <Input
                    id={`${prefix}-reason`}
                    required
                    maxLength={500}
                    value={ruleDraft.reason}
                    onChange={(e) =>
                      setRuleDraft((d) => ({ ...d, reason: e.target.value }))
                    }
                  />
                </div>
                <div className="flex items-start gap-3 rounded-lg border bg-muted/30 p-3">
                  <input
                    id={`${prefix}-confirmed`}
                    type="checkbox"
                    checked={ruleDraft.confirmed}
                    onChange={(e) =>
                      setRuleDraft((d) => ({
                        ...d,
                        confirmed: e.target.checked,
                      }))
                    }
                    required
                    className="mt-0.5 size-4 shrink-0 accent-primary"
                  />
                  <Label
                    htmlFor={`${prefix}-confirmed`}
                    className="text-xs font-normal leading-relaxed"
                  >
                    I confirm this exact-match rule should be suggested for
                    future transactions.
                  </Label>
                </div>
              </fieldset>
              {formError && (
                <p
                  role="alert"
                  className="flex items-start gap-2 text-sm text-destructive"
                >
                  <CircleAlert className="mt-0.5 size-4 shrink-0" />
                  {formError}
                </p>
              )}
              <DialogFooter>
                <Button
                  type="button"
                  variant="outline"
                  disabled={!!busy}
                  onClick={() => setDialog(null)}
                >
                  Cancel
                </Button>
                <Button disabled={!!busy} type="submit">
                  {busy ? 'Saving…' : 'Create rule'}
                </Button>
              </DialogFooter>
            </form>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}
