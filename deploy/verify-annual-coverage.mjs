import { readFile } from 'node:fs/promises';
if (!/^[a-f0-9]{40}$/.test(process.env.RELEASE_SHA ?? ''))
  throw Error('release_required');
const base = `/opt/private-finances/releases/${process.env.RELEASE_SHA}/dist/src/`;
const { postgresDatabase } = await import(base + 'database.js');
const { MonobankConnector } = await import(base + 'connectors/monobank.js');
const { requester } = await import(base + 'connectors/http.js');
const db = postgresDatabase(process.env.DATABASE_URL);
try {
  let total = 0;
  for (const owner of ['rodion', 'katya']) {
    const token = (
      await readFile(
        `${process.env.CREDENTIALS_DIRECTORY}/monobank-${owner === 'katya' ? 'kate' : 'rodion'}-token`,
        'utf8',
      )
    ).trim();
    const connector = new MonobankConnector(
      owner,
      token,
      requester('https://api.monobank.ua', 61000),
      false,
    );
    const accounts = await connector.accounts();
    if (!accounts.length) throw Error('empty');
    for (const account of accounts) {
      const covered = await db.query(
        "SELECT 1 FROM bank_import_windows WHERE connection=$1 AND owner=$2 AND account_id=$3 AND currency=$4 AND from_at<='2025-09-11T00:00:00Z' AND to_at>='2026-09-11T21:00:00Z' LIMIT 1",
        [`monobank:${owner}`, owner, account.accountId, account.currency],
      );
      if (!covered.rows.length) throw Error('incomplete');
    }
    total += accounts.length;
  }
  console.log(JSON.stringify({ verified: true, accounts: total }));
} catch {
  console.error('{"verified":false}');
  process.exitCode = 1;
} finally {
  await db.close();
}
