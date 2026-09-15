import { readFile, stat } from 'node:fs/promises';
import { resolve } from 'node:path';
import { postgresDatabase, migrate } from './database.js';
import { Repository } from './repository.js';
import { syncBank } from './bank-sync.js';
import { MonobankConnector } from './connectors/monobank.js';
import { EnableBankingConnector } from './connectors/enablebanking.js';
import { requester } from './connectors/http.js';
import { ConnectorError } from './connectors/types.js';
import { loadEnableBankingCredentials } from './enablebanking-credentials.js';

async function secret(path: string): Promise<string> {
  const info = await stat(path);
  if (!info.isFile() || (info.mode & 0o077) !== 0 || info.size > 65536)
    throw new Error('invalid_secret_file');
  return (await readFile(path, 'utf8')).trim();
}
async function main() {
  const [provider, owner, fromArg, toArg, bankArg] = process.argv.slice(2);
  if (
    !['monobank', 'enablebanking'].includes(provider ?? '') ||
    (owner !== 'rodion' && owner !== 'katya') ||
    !fromArg ||
    !toArg ||
    !process.env.DATABASE_URL ||
    !process.env.CREDENTIALS_DIRECTORY
  )
    throw new Error(
      'Usage: sync <monobank|enablebanking> <rodion|katya> <from ISO> <to ISO>; DATABASE_URL and CREDENTIALS_DIRECTORY required',
    );
  const from = new Date(fromArg),
    to = new Date(toArg);
  if (
    !Number.isFinite(from.getTime()) ||
    !Number.isFinite(to.getTime()) ||
    from >= to ||
    to.getTime() > Date.now()
  )
    throw new Error('invalid_sync_window');
  const directory = process.env.CREDENTIALS_DIRECTORY;
  const bank = bankArg ?? process.env.ENABLEBANKING_BANK;
  if (provider === 'enablebanking' && bank !== 'wise' && bank !== 'revolut')
    throw new Error('ENABLEBANKING_BANK must select wise or revolut');
  if (
    provider === 'enablebanking' &&
    !process.env.ENABLEBANKING_SESSION_DIRECTORY
  )
    throw new Error('ENABLEBANKING_SESSION_DIRECTORY required');
  const credentials =
    provider === 'enablebanking'
      ? await loadEnableBankingCredentials(process.env, owner)
      : undefined;
  if (provider === 'enablebanking' && !credentials)
    throw new Error('enablebanking_credentials');
  const connector =
    provider === 'monobank'
      ? new MonobankConnector(
          owner,
          await secret(
            resolve(
              directory,
              owner === 'rodion'
                ? 'monobank-rodion-token'
                : 'monobank-kate-token',
            ),
          ),
          requester('https://api.monobank.ua', 61000),
          process.env.MONOBANK_INCLUDE_JARS !== 'false',
        )
      : new EnableBankingConnector(
          {
            owner,
            bank: bank as 'wise' | 'revolut',
            applicationId: credentials!.applicationId,
            privateKey: credentials!.privateKey,
            sessionId: await secret(
              resolve(
                process.env.ENABLEBANKING_SESSION_DIRECTORY!,
                `enablebanking-${owner}-${bank}-session`,
              ),
            ),
          },
          requester('https://api.enablebanking.com'),
        );
  const db = postgresDatabase(process.env.DATABASE_URL);
  try {
    await migrate(db);
    const result = await syncBank(new Repository(db), connector, from, to);
    process.stdout.write(
      JSON.stringify({
        event: 'bank_sync_completed',
        provider,
        owner,
        ...(provider === 'enablebanking' ? { bank } : {}),
        ...result,
      }) + '\n',
    );
  } finally {
    await db.close();
  }
}
main().catch((error) => {
  process.stderr.write(
    JSON.stringify({
      event: 'bank_sync_failed',
      code:
        error instanceof ConnectorError
          ? error.code
          : 'configuration_or_sync_error',
    }) + '\n',
  );
  process.exitCode = 1;
});
