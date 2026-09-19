import { Accounts } from './accounts.js';
import { AccountBalances } from './account-balances.js';
import { randomUUID } from 'node:crypto';
import { Repository, Conflict } from './repository.js';
import { ConnectorError, type BankConnector } from './connectors/types.js';
import { reidentifyTransfers } from './counterparty-identity.js';
import { isBankSlug } from './connectors/banks.js';
import { isMultiCurrency } from './connectors/enablebanking.js';
import { AttemptRecorder } from './import-runs.js';

/** Fetch outside transactions; commit a complete account window and its checkpoint together. */
export async function syncBank(
  repo: Repository,
  connector: BankConnector,
  from: Date,
  to: Date,
  /**
   * Records what this attempt did, for the screen that reads it back. The
   * caller creates it because it also owns the requester whose every call
   * lands in the same record. Absent in tests that do not care, and never
   * allowed to affect what this function returns or throws.
   */
  recorder?: AttemptRecorder,
) {
  if (
    !Number.isFinite(from.getTime()) ||
    !Number.isFinite(to.getTime()) ||
    from >= to ||
    to.getTime() > Date.now()
  )
    throw new Error('invalid_sync_window');
  if (connector.source === 'enablebanking' && !isBankSlug(connector.bank))
    throw new ConnectorError('schema');
  const key = `${connector.source}:${connector.owner}${connector.source === 'enablebanking' ? `:${connector.bank}` : ''}`;
  const token = randomUUID();
  const claim = await repo.db.query(
    `INSERT INTO bank_sync_runs(connection,state,lease_token,lease_until)
    VALUES($1,'running',$2,now()+interval '5 minutes')
    ON CONFLICT(connection) DO UPDATE SET state='running',lease_token=$2,lease_until=now()+interval '5 minutes',error_code=NULL
    WHERE bank_sync_runs.lease_until IS NULL OR bank_sync_runs.lease_until < now() RETURNING connection`,
    [key, token],
  );
  if (!claim.rows.length) {
    recorder?.step('claim', { code: 'sync_already_running' });
    await recorder?.finish('failed', {
      accounts: 0,
      changed: 0,
      errorCode: 'sync_already_running',
    });
    throw new Conflict('sync_already_running');
  }
  recorder?.step('claim');
  let leaseLost = false;
  let heartbeat: Promise<unknown> = Promise.resolve();
  const timer = setInterval(() => {
    heartbeat = heartbeat
      .then(async () => {
        const renewed = await repo.db.query(
          "UPDATE bank_sync_runs SET lease_until=now()+interval '5 minutes' WHERE connection=$1 AND lease_token=$2 AND lease_until>now() RETURNING connection",
          [key, token],
        );
        if (!renewed.rows.length) leaseLost = true;
      })
      .catch(() => {
        leaseLost = true;
      });
  }, 60000);
  let changed = 0;
  // Times a stage into the attempt record when one is being kept, and is the
  // bare call when it is not, so the import reads the same either way.
  const timed = <T>(
    stage: Parameters<AttemptRecorder['timed']>[0],
    detail: Parameters<AttemptRecorder['timed']>[1],
    run: () => Promise<T>,
  ): Promise<T> => (recorder ? recorder.timed(stage, detail, run) : run());
  try {
    const accounts = await timed('accounts', {}, () => connector.accounts());
    recorder?.step('accounts', { count: accounts.length, note: 'listed' });
    const seen = new Set<string>();
    const registry = new Accounts(repo.db);
    const balances = new AccountBalances(repo.db);
    for (const account of accounts) {
      if (
        account.owner !== connector.owner ||
        account.source !== connector.source ||
        seen.has(account.accountId)
      )
        throw new ConnectorError('schema');
      seen.add(account.accountId);
      await registry.discover(account);
      // What the account holds, recorded beside the payments that moved it.
      //
      // Deliberately best-effort and deliberately first: Monobank states the
      // balance in the listing already fetched, so it costs nothing, and
      // Enable Banking answers one extra request, which counts as a request but
      // not as another background fetch against the daily allowance banks
      // impose on unattended polling. Either way a balance is a nicety and the
      // payments are the point, so a bank that refuses one — a rate limit, a
      // resource it does not serve, a shape this code does not know — leaves
      // the previous figure in place to go visibly stale and the import carries
      // on. Nothing here may turn a successful import into a failed one.
      try {
        const stated = account.balance
          ? [account.balance]
          : ((await timed('balance', { account: account.accountId }, () =>
              connector.balances
                ? connector.balances(account)
                : Promise.resolve([]),
            )) ?? []);
        if (stated.length) await balances.record(account, stated);
      } catch {
        // Left for the next run; the page shows how old the last figure is.
        // `timed` has already noted why, which is the whole point of keeping a
        // stage that is allowed to fail: a balance quietly going stale for a
        // week used to leave nothing behind at all.
      }
      const batch = await timed(
        'transactions',
        { account: account.accountId },
        () => connector.transactions(account, from, to),
      );
      recorder?.step('transactions', {
        account: account.accountId,
        count: batch.length,
        note: 'fetched',
      });
      // An account holding several currencies reports none of its own, so only
      // a single-currency account can have its payments checked against it.
      const fixedCurrency = !isMultiCurrency(account.currency);
      if (
        batch.some(
          (t) =>
            t.owner !== account.owner ||
            t.source !== account.source ||
            t.accountId !== account.accountId ||
            (fixedCurrency && t.currency !== account.currency),
        )
      )
        throw new ConnectorError('schema');
      const imported = await timed(
        'commit',
        { account: account.accountId },
        () =>
          repo.db.transaction(async (tx) => {
            const lease = await tx.query(
              'SELECT connection FROM bank_sync_runs WHERE connection=$1 AND lease_token=$2 AND lease_until>now() FOR UPDATE',
              [key, token],
            );
            if (leaseLost || !lease.rows.length)
              throw new Conflict('sync_lease_lost');
            const written = await repo.importBatch(batch, tx);
            // Store coverage intervals explicitly: a later disjoint import must not imply a gap was imported.
            await tx.query(
              `INSERT INTO bank_import_windows(id,connection,account_id,owner,currency,from_at,to_at,changed)
          VALUES($1,$2,$3,$4,$5,$6,$7,$8)`,
              [
                randomUUID(),
                key,
                account.accountId,
                account.owner,
                account.currency,
                from.toISOString(),
                to.toISOString(),
                written,
              ],
            );
            // The import holds this row lock, so its heartbeat may have been blocked.
            // PostgreSQL now() is the transaction start; use wall time after the batch.
            await tx.query(
              "UPDATE bank_sync_runs SET lease_until=clock_timestamp()+interval '5 minutes' WHERE connection=$1 AND lease_token=$2",
              [key, token],
            );
            return written;
          }),
      );
      changed += imported;
      recorder?.step('commit', {
        account: account.accountId,
        count: imported,
        note: 'written',
      });
    }
    // Recognising household money has to happen after the import, not only in
    // the migration that introduced it: a transfer to a counterparty the owner
    // has already identified should be recognised on the sync that brings it in
    // rather than sitting in the totals as spending until someone notices.
    //
    // It is idempotent and costs milliseconds once the backlog is done, and a
    // failure here must not fail an import that has already committed — the next
    // sync runs it again.
    try {
      await timed('identify', {}, () =>
        repo.db.transaction((tx) => reidentifyTransfers(tx)),
      );
    } catch {
      // Left for the next sync; the imported money is already safely stored.
      // `timed` has recorded that it was attempted and why it did not finish —
      // a stage allowed to fail silently is exactly the kind that should not
      // also fail invisibly.
    }
    const finished = await repo.db.query(
      "UPDATE bank_sync_runs SET state='succeeded',last_success_at=now(),lease_token=NULL,lease_until=NULL WHERE connection=$1 AND lease_token=$2 AND lease_until>now() RETURNING connection",
      [key, token],
    );
    if (!finished.rows.length) throw new Conflict('sync_lease_lost');
    recorder?.step('finish', { count: changed });
    // A run that succeeded is a run that is no longer waiting for anything.
    await repo.db.query(
      'UPDATE bank_sync_runs SET retry_after=NULL,retry_reason=NULL WHERE connection=$1',
      [key],
    );
    await recorder?.finish('succeeded', {
      accounts: accounts.length,
      changed,
    });
    return { accounts: accounts.length, changed };
  } catch (error) {
    const code = error instanceof ConnectorError ? error.code : 'sync_failed';
    await repo.db.query(
      "UPDATE bank_sync_runs SET state='failed',error_code=$3,lease_token=NULL,lease_until=NULL WHERE connection=$1 AND lease_token=$2",
      [key, token, code],
    );
    recorder?.step('error', {
      code,
      ...(error instanceof ConnectorError && error.retryAfterMs !== undefined
        ? { retryAfterMs: error.retryAfterMs }
        : {}),
    });
    await recorder?.finish('failed', {
      accounts: 0,
      changed,
      errorCode: code,
    });
    throw error;
  } finally {
    clearInterval(timer);
    await heartbeat;
  }
}
