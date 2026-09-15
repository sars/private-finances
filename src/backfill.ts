import { setTimeout as sleep } from 'node:timers/promises';
import {
  ConnectorError,
  type BankAccount,
  type BankConnector,
} from './connectors/types.js';

export interface BackfillWindow {
  from: Date;
  to: Date;
}
export interface BackfillDependencies {
  covered(account: BankAccount, window: BackfillWindow): Promise<boolean>;
  sync(
    connector: BankConnector,
    from: Date,
    to: Date,
  ): Promise<{ changed: number }>;
  sleep?: (milliseconds: number) => Promise<unknown>;
  progress?: (event: BackfillProgress) => void;
}
export interface BackfillProgress {
  event:
    | 'backfill_window_completed'
    | 'backfill_window_skipped'
    | 'backfill_window_split'
    | 'backfill_retry';
  provider: BankConnector['source'];
  owner: BankConnector['owner'];
  from?: string;
  to?: string;
  changed?: number;
  attempt?: number;
  code?: 'rate_limit' | 'transient';
}

/** UTC calendar windows; touching boundaries are intentionally deduplicated by source ID. */
export function planBackfillWindows(
  provider: BankConnector['source'],
  from: Date,
  to: Date,
): BackfillWindow[] {
  if (
    !Number.isFinite(from.getTime()) ||
    !Number.isFinite(to.getTime()) ||
    from >= to ||
    from.getTime() % 1000 !== 0 ||
    to.getTime() % 1000 !== 0
  )
    throw new Error('invalid_backfill_window');
  if (provider === 'enablebanking')
    return [{ from: new Date(from), to: new Date(to) }];
  if (provider !== 'monobank') throw new Error('invalid_backfill_provider');
  const windows: BackfillWindow[] = [];
  let start = from.getTime();
  while (start < to.getTime()) {
    const date = new Date(start);
    const end = Math.min(
      Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 1),
      to.getTime(),
    );
    if (end <= start || windows.length >= 1200)
      throw new Error('invalid_backfill_window');
    windows.push({ from: new Date(start), to: new Date(end) });
    start = end;
  }
  return windows.reverse();
}

/** Progress is durable only through sync's committed account-window coverage. */
export async function runBackfill(
  connector: BankConnector,
  from: Date,
  to: Date,
  dependencies: BackfillDependencies,
) {
  const windows = planBackfillWindows(connector.source, from, to);
  if (to.getTime() > Date.now()) throw new Error('invalid_backfill_window');
  const wait = dependencies.sleep ?? sleep;
  const emit = (data: Omit<BackfillProgress, 'provider' | 'owner'>) =>
    dependencies.progress?.({
      ...data,
      provider: connector.source,
      owner: connector.owner,
    });
  const retry = async <T>(
    operation: () => Promise<T>,
    window?: BackfillWindow,
  ): Promise<T> => {
    for (let attempt = 1; ; attempt++) {
      try {
        return await operation();
      } catch (error) {
        if (
          !(error instanceof ConnectorError) ||
          !['rate_limit', 'transient'].includes(error.code) ||
          attempt >= 3
        )
          throw error;
        const delay =
          error.code === 'rate_limit'
            ? (error.retryAfterMs ?? 61000)
            : 1000 * 2 ** (attempt - 1);
        // Reject unreasonable delays rather than retrying earlier than instructed.
        if (!Number.isSafeInteger(delay) || delay < 0 || delay > 86400000)
          throw error;
        emit({
          event: 'backfill_retry',
          code: error.code as 'rate_limit' | 'transient',
          attempt,
          ...(window
            ? { from: window.from.toISOString(), to: window.to.toISOString() }
            : {}),
        });
        await wait(delay);
      }
    }
  };
  const accounts = await retry(() => connector.accounts());
  const seen = new Set<string>();
  if (!accounts.length) throw new ConnectorError('incomplete');
  for (const account of accounts) {
    if (
      account.source !== connector.source ||
      account.owner !== connector.owner ||
      !account.accountId ||
      seen.has(account.accountId)
    )
      throw new ConnectorError('schema');
    seen.add(account.accountId);
  }
  let completed = 0,
    skipped = 0,
    changed = 0;
  for (const account of accounts) {
    const singleAccount: BankConnector = {
      source: connector.source,
      owner: connector.owner,
      ...(connector.bank ? { bank: connector.bank } : {}),
      accounts: async () => [account],
      transactions: (current, start, end) =>
        connector.transactions(current, start, end),
    };
    for (const window of windows) {
      const pending = [window];
      let jobs = 0;
      while (pending.length) {
        if (++jobs > 255) throw new ConnectorError('incomplete');
        const current = pending.shift()!;
        const dates = {
          from: current.from.toISOString(),
          to: current.to.toISOString(),
        };
        if (await dependencies.covered(account, current)) {
          skipped++;
          emit({ event: 'backfill_window_skipped', ...dates });
          continue;
        }
        try {
          const result = await retry(
            () => dependencies.sync(singleAccount, current.from, current.to),
            current,
          );
          completed++;
          changed += result.changed;
          emit({
            event: 'backfill_window_completed',
            ...dates,
            changed: result.changed,
          });
        } catch (error) {
          // Monobank already exhausts bounded adaptive windows inside its connector.
          // Re-splitting here would reset its request budget after terminal failures.
          if (
            connector.source !== 'enablebanking' ||
            !(error instanceof ConnectorError) ||
            error.code !== 'incomplete'
          )
            throw error;
          const start = current.from.getTime(),
            end = current.to.getTime();
          const midpoint = Math.floor((start + end) / 2000) * 1000;
          if (
            end - start <= 1000 ||
            midpoint <= start ||
            midpoint >= end ||
            jobs + pending.length + 2 > 255
          )
            throw error;
          pending.unshift(
            { from: new Date(midpoint), to: current.to },
            { from: current.from, to: new Date(midpoint) },
          );
          emit({ event: 'backfill_window_split', ...dates });
        }
      }
    }
  }
  return { accounts: accounts.length, completed, skipped, changed };
}
