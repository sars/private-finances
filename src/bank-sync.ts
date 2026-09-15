import { Accounts } from './accounts.js';
import { randomUUID } from 'node:crypto';
import { Repository, Conflict } from './repository.js';
import { ConnectorError, type BankConnector } from './connectors/types.js';
import { reidentifyTransfers } from './counterparty-identity.js';

/** Fetch outside transactions; commit a complete account window and its checkpoint together. */
export async function syncBank(
  repo: Repository,
  connector: BankConnector,
  from: Date,
  to: Date,
) {
  if (
    !Number.isFinite(from.getTime()) ||
    !Number.isFinite(to.getTime()) ||
    from >= to ||
    to.getTime() > Date.now()
  )
    throw new Error('invalid_sync_window');
  if (
    connector.source === 'enablebanking' &&
    connector.bank !== 'wise' &&
    connector.bank !== 'revolut'
  )
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
  if (!claim.rows.length) throw new Conflict('sync_already_running');
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
  try {
    const accounts = await connector.accounts();
    const seen = new Set<string>();
    const registry = new Accounts(repo.db);
    for (const account of accounts) {
      if (
        account.owner !== connector.owner ||
        account.source !== connector.source ||
        seen.has(account.accountId)
      )
        throw new ConnectorError('schema');
      seen.add(account.accountId);
      await registry.discover(account);
      const batch = await connector.transactions(account, from, to);
      if (
        batch.some(
          (t) =>
            t.owner !== account.owner ||
            t.source !== account.source ||
            t.accountId !== account.accountId ||
            t.currency !== account.currency,
        )
      )
        throw new ConnectorError('schema');
      changed += await repo.db.transaction(async (tx) => {
        const lease = await tx.query(
          'SELECT connection FROM bank_sync_runs WHERE connection=$1 AND lease_token=$2 AND lease_until>now() FOR UPDATE',
          [key, token],
        );
        if (leaseLost || !lease.rows.length)
          throw new Conflict('sync_lease_lost');
        const imported = await repo.importBatch(batch, tx);
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
            imported,
          ],
        );
        // The import holds this row lock, so its heartbeat may have been blocked.
        // PostgreSQL now() is the transaction start; use wall time after the batch.
        await tx.query(
          "UPDATE bank_sync_runs SET lease_until=clock_timestamp()+interval '5 minutes' WHERE connection=$1 AND lease_token=$2",
          [key, token],
        );
        return imported;
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
      await repo.db.transaction((tx) => reidentifyTransfers(tx));
    } catch {
      // Left for the next sync; the imported money is already safely stored.
    }
    const finished = await repo.db.query(
      "UPDATE bank_sync_runs SET state='succeeded',last_success_at=now(),lease_token=NULL,lease_until=NULL WHERE connection=$1 AND lease_token=$2 AND lease_until>now() RETURNING connection",
      [key, token],
    );
    if (!finished.rows.length) throw new Conflict('sync_lease_lost');
    return { accounts: accounts.length, changed };
  } catch (error) {
    await repo.db.query(
      "UPDATE bank_sync_runs SET state='failed',error_code=$3,lease_token=NULL,lease_until=NULL WHERE connection=$1 AND lease_token=$2",
      [
        key,
        token,
        error instanceof ConnectorError ? error.code : 'sync_failed',
      ],
    );
    throw error;
  } finally {
    clearInterval(timer);
    await heartbeat;
  }
}
