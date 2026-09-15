import assert from 'node:assert/strict';
import { generateKeyPairSync, verify } from 'node:crypto';
import test from 'node:test';
import {
  EnableBankingConnector,
  signJwt,
} from '../src/connectors/enablebanking.js';
import type { Requester } from '../src/connectors/types.js';
const keys = generateKeyPairSync('rsa', { modulusLength: 2048 });
const config = {
  owner: 'rodion' as const,
  bank: 'wise' as const,
  applicationId: 'test-app',
  privateKey: keys.privateKey
    .export({ type: 'pkcs8', format: 'pem' })
    .toString(),
  sessionId: 'test-session',
};
const session = (uid = 'test-uid') => ({
  status: 'AUTHORIZED',
  access: { valid_until: new Date(Date.now() + 3600000).toISOString() },
  accounts_data: [{ uid, identification_hash: 'synthetic-hash' }],
});
const transaction = (entry_reference = 'entry-1') => ({
  entry_reference,
  transaction_id: 'unstable-id',
  transaction_amount: { currency: 'EUR', amount: '90071992547409.93' },
  credit_debit_indicator: 'DBIT',
  status: 'BOOK',
  booking_date: '2026-09-01',
  remittance_information: ['Synthetic test'],
});
const from = new Date('2026-09-01T00:00:00Z'),
  to = new Date('2026-09-10T00:00:00Z');
function mocked(
  pages: unknown[],
  sessionData: unknown = session(),
): { connector: EnableBankingConnector; paths: string[] } {
  const paths: string[] = [];
  const requester: Requester = async (path, headers) => {
    paths.push(path);
    assert.match(headers.Authorization!, /^Bearer [\w-]+\.[\w-]+\.[\w-]+$/);
    if (path.startsWith('/sessions/')) return sessionData;
    if (path.endsWith('/details'))
      return { currency: 'EUR', details: 'Synthetic account' };
    assert.ok(pages.length);
    return pages.shift();
  };
  return { connector: new EnableBankingConnector(config, requester), paths };
}
test('Enable Banking JWT has documented claims and valid RS256 signature', () => {
  const jwt = signJwt(config.applicationId, config.privateKey, 12345);
  const [header, body, signature] = jwt.split('.') as [string, string, string];
  assert.deepEqual(JSON.parse(Buffer.from(header, 'base64url').toString()), {
    typ: 'JWT',
    alg: 'RS256',
    kid: 'test-app',
  });
  assert.deepEqual(JSON.parse(Buffer.from(body, 'base64url').toString()), {
    iss: 'enablebanking.com',
    aud: 'api.enablebanking.com',
    iat: 12345,
    exp: 15945,
  });
  assert.ok(
    verify(
      'RSA-SHA256',
      Buffer.from(`${header}.${body}`),
      keys.publicKey,
      Buffer.from(signature, 'base64url'),
    ),
  );
  assert.throws(() => signJwt('test', 'invalid'), /connector_auth/);
});
test('Enable Banking keeps exact cents, pending status, raw details and paginates', async () => {
  const pending = {
    ...transaction('entry-2'),
    status: 'PDNG',
    credit_debit_indicator: 'CRDT',
    booking_date: undefined,
    value_date: '2026-09-02',
  };
  const { connector, paths } = mocked([
    { transactions: [transaction()], continuation_key: 'next+/?' },
    { transactions: [pending], continuation_key: null },
  ]);
  const [account] = await connector.accounts();
  const rows = await connector.transactions(account!, from, to);
  assert.equal(rows[0]!.amountMinor, '-9007199254740993');
  assert.equal(rows[1]!.amountMinor, '9007199254740993');
  assert.equal(rows[1]!.status, 'pending');
  assert.equal(rows[0]!.sourceId, 'entry-1');
  assert.equal(rows[0]!.bookedAt, '2026-09-01T00:00:00.000Z');
  assert.equal(rows[0]!.sourceDetails.transaction_id, 'unstable-id');
  assert.deepEqual(rows[1]!.sourceDetails._import, {
    datePrecision: 'day',
    dateField: 'value_date',
    timezoneConvention: 'UTC midnight',
  });
  assert.ok(
    paths.some((path) =>
      path.endsWith(
        'date_from=2026-09-01&date_to=2026-09-10&continuation_key=next%2B%2F%3F',
      ),
    ),
  );
});
test('Enable Banking identity survives renewed session UIDs', async () => {
  const a = await mocked([], session('old')).connector.accounts();
  const b = await mocked([], session('new')).connector.accounts();
  assert.equal(a[0]!.accountId, b[0]!.accountId);
  assert.notEqual(a[0]!.providerAccountId, b[0]!.providerAccountId);
});
test('Enable Banking fails closed for expired or revoked consent', async () => {
  for (const data of [
    { ...session(), status: 'REVOKED' },
    { ...session(), access: { valid_until: '2000-01-01T00:00:00Z' } },
  ]) {
    const { connector, paths } = mocked([], data);
    await assert.rejects(connector.accounts(), /connector_consent/);
    assert.equal(paths.length, 1);
  }
});
test('Enable Banking rejects unstable transaction_id fallback and cursor loops', async () => {
  for (const pages of [
    [{ transactions: [{ ...transaction(), entry_reference: undefined }] }],
    [
      { transactions: [], continuation_key: 'same' },
      { transactions: [], continuation_key: 'same' },
    ],
  ]) {
    const { connector } = mocked(pages);
    const [account] = await connector.accounts();
    await assert.rejects(
      connector.transactions(account!, from, to),
      /connector_incomplete/,
    );
  }
});
test('Enable Banking rejects missing account hash, invalid days and numeric amounts', async () => {
  await assert.rejects(
    mocked([], {
      ...session(),
      accounts_data: [{ uid: 'test' }],
    }).connector.accounts(),
    /connector_schema/,
  );
  for (const row of [
    { ...transaction(), booking_date: '2026-02-30' },
    { ...transaction(), transaction_amount: { currency: 'EUR', amount: 1.23 } },
  ]) {
    const { connector } = mocked([{ transactions: [row] }]);
    const [account] = await connector.accounts();
    await assert.rejects(
      connector.transactions(account!, from, to),
      /connector_schema/,
    );
  }
});
