import type { Executor } from '../src/database.js';
import type { Owner } from '../src/domain.js';
import { seedOwners } from '../src/auth.js';

/**
 * The two household members as the HTTP tests know them. The passwords are the
 * ones the tests used under Basic authentication, so a diff shows the change
 * of mechanism and not a change of fixture.
 */
export const TEST_OWNERS = [
  {
    owner: 'rodion' as Owner,
    email: 'rodion@example.test',
    password: 'synthetic-rodion-password',
  },
  {
    owner: 'katya' as Owner,
    email: 'katya@example.test',
    password: 'synthetic-katya-password',
  },
];

export const seedTestOwners = (db: Executor) => seedOwners(db, TEST_OWNERS);

/**
 * Sign in over HTTP and return the Cookie header that keeps the session, so a
 * test says `headers: { cookie }` where it used to say `authorization`.
 */
export async function signInAs(base: string, owner: Owner): Promise<string> {
  const who = TEST_OWNERS.find((candidate) => candidate.owner === owner);
  if (!who) throw new Error(`no test owner ${owner}`);
  const response = await fetch(base + '/api/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      email: who.email,
      password: who.password,
    }).toString(),
  });
  if (!response.ok) throw new Error(`sign-in failed with ${response.status}`);
  const header = response.headers.get('set-cookie');
  if (!header) throw new Error('sign-in returned no cookie');
  return header.split(';')[0]!;
}
