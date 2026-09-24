import assert from 'node:assert/strict';
import test from 'node:test';
import { ConnectorError } from '../src/connectors/types.js';
import {
  databaseUnavailable,
  failureCode,
  reportedFailure,
} from '../src/sync-failure.js';

const withCode = (message: string, code: string, extra = {}) =>
  Object.assign(new Error(message), { code, ...extra });

test('a database that went away is a transient failure, not one for review', () => {
  // What PostgreSQL sends a connection when it is restarted underneath it.
  assert.equal(
    failureCode(
      withCode('terminating connection due to administrator command', '57P01'),
    ),
    'transient',
  );
  assert.equal(
    failureCode(withCode('connect ECONNREFUSED', 'ECONNREFUSED')),
    'transient',
  );
  assert.equal(
    failureCode(
      withCode('connect ENOENT /var/run/postgresql/.s.PGSQL.5432', 'ENOENT', {
        syscall: 'connect',
      }),
    ),
    'transient',
  );
  assert.equal(
    failureCode(new Error('Connection terminated unexpectedly')),
    'transient',
  );
  // A file that is missing is configuration, not a restart.
  assert.equal(
    databaseUnavailable(
      withCode('no such file', 'ENOENT', { syscall: 'open' }),
    ),
    false,
  );
});

test('everything else keeps the code it had', () => {
  assert.equal(failureCode(new ConnectorError('consent')), 'consent');
  assert.equal(failureCode(new ConnectorError('rate_limit')), 'rate_limit');
  assert.equal(failureCode(new Error('consent_pending')), 'consent_pending');
  assert.equal(
    failureCode(withCode('duplicate key', '23505')),
    'configuration_or_sync_error',
  );
  assert.equal(failureCode('not an error'), 'configuration_or_sync_error');
});

test('the failure is read from its own line, whatever came before it', () => {
  assert.equal(
    reportedFailure(
      '{"event":"database_connection_lost","code":"57P01"}\n{"event":"bank_sync_failed","code":"transient"}\n',
    ),
    'transient',
  );
  assert.equal(
    reportedFailure('{"event":"bank_sync_failed","code":"rate_limit"}'),
    'rate_limit',
  );
  assert.equal(reportedFailure('node:events:487\n  throw er;\n'), null);
  assert.equal(reportedFailure(''), null);
});
