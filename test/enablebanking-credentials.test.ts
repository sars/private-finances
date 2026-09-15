import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, chmod, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadEnableBankingCredentials } from '../src/enablebanking-credentials.js';

test('owner credentials never fall back to another owner; explicit pairs are atomic', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'pf-credentials-'));
  const legacy = join(directory, 'enablebanking.pem');
  const kate = join(directory, 'kate.pem');
  try {
    await writeFile(legacy, 'synthetic-rodion', { mode: 0o600 });
    await writeFile(kate, 'synthetic-katya', { mode: 0o600 });
    const env = {
      ENABLEBANKING_APPLICATION_ID: 'synthetic-r',
      CREDENTIALS_DIRECTORY: directory,
    };
    assert.deepEqual(await loadEnableBankingCredentials(env, 'rodion'), {
      applicationId: 'synthetic-r',
      privateKey: 'synthetic-rodion',
    });
    assert.equal(await loadEnableBankingCredentials(env, 'katya'), undefined);
    assert.deepEqual(
      await loadEnableBankingCredentials(
        {
          ...env,
          ENABLEBANKING_KATYA_APPLICATION_ID: 'synthetic-k',
          ENABLEBANKING_KATYA_PRIVATE_KEY_FILE: kate,
        },
        'katya',
      ),
      { applicationId: 'synthetic-k', privateKey: 'synthetic-katya' },
    );
    await assert.rejects(
      loadEnableBankingCredentials(
        { ...env, ENABLEBANKING_KATYA_APPLICATION_ID: 'synthetic-k' },
        'katya',
      ),
      /enablebanking_credentials/,
    );
    await assert.rejects(
      loadEnableBankingCredentials(
        { ...env, ENABLEBANKING_RODION_PRIVATE_KEY_FILE: kate },
        'rodion',
      ),
      /enablebanking_credentials/,
    );
    await chmod(kate, 0o644);
    await assert.rejects(
      loadEnableBankingCredentials(
        {
          ENABLEBANKING_KATYA_APPLICATION_ID: 'synthetic-k',
          ENABLEBANKING_KATYA_PRIVATE_KEY_FILE: kate,
        },
        'katya',
      ),
      /enablebanking_credentials/,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
