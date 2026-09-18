# How each member signs in

Each household member signs in with an email address and a password and keeps
a session for thirty days. Before this, the dashboard used HTTP Basic
authentication: the browser held the password and re-sent it on every request,
there was no way to sign out, and nothing could ever be added beside the
password. This replaces that.

## What exists

- `users` — one row per member, keyed by the owner name the rest of the
  application already uses (`rodion`, `katya`), holding an address and a
  password hash.
- `sessions` — one row per signed-in browser: the SHA-256 digest of the token,
  the member it belongs to, a CSRF token, and an expiry.
- `POST /api/login` — an address and a password in a form body. On success it
  sets `pf_session` and answers with the actor and their CSRF token.
- `POST /api/logout` — deletes the session row and clears the cookie. It needs
  the CSRF token, so a foreign page cannot sign the member out.
- `src/auth.ts` — everything above. Nothing else in the application reads the
  two tables.

Passwords are hashed with scrypt from Node's own `crypto`, N=2¹⁵, with the
cost parameters stored inside each hash so they can be raised later without
invalidating anything. There are no runtime dependencies.

## The cookie

`pf_session` is `HttpOnly`, `SameSite=Lax`, `Secure` outside demo mode, and
lives for thirty days. The token in it is random; the database stores only its
digest, so a copy of the table does not let anyone resume a session.

`Lax` and not `Strict` on purpose: the bank approval comes back here as a
redirect from the provider, and a `Strict` cookie is withheld on that first
cross-site navigation, which would drop the member on the sign-in screen in
the middle of giving consent.

The expiry slides. A session more than a day into its window is extended on
the next request, so an app opened regularly never asks again while one left
alone for a month does. Renewing on every request would mean a database write
per page view.

## Where the passwords come from

`RODION_EMAIL`, `KATYA_EMAIL`, `RODION_PASSWORD` and `KATYA_PASSWORD` in the
server's environment file. `seedOwners` applies all four to the `users` table
at every boot, and drops that member's sessions when their password changed.

The environment stays the source of truth deliberately. Rotating a password is
"edit `/etc/private-finances/app.env`, restart" — the same operation as before
— and it is the **only** way back in, because nothing resets a password by
email. A password of fewer than 20 characters or a malformed address stops the
boot rather than starting a server nobody can reach.

**A change-password screen has to take this over.** Until one exists, a value
changed in the database is overwritten at the next restart.

## What is reachable without a session

The application shell, `/assets/*`, the fonts, the icons, the manifest and the
service worker. They are the sign-in screen as much as they are the
application, they carry no household data, and this repository publishes the
same files. Everything else — every `/api/*` route, every server-rendered page
— answers 401.

`/health/live` and `/health/ready` also answer without a session. They are on
the loopback listener and say only whether the process and its database
respond and which release is live. `deploy/switch-release.py` polls readiness
during a deployment, when there is no session to present.

## Guessing

Failed attempts are counted per address and per caller, both decay, and after
three the next attempt is delayed — doubling to a minute. There is no lockout:
a lockout is a way for one member to be locked out deliberately by someone
guessing at their address.

An unknown address costs the same as a wrong password, because `signIn` hashes
against a decoy when it finds no row. Otherwise the form would answer "does
this person bank here" to anyone who can time it. Neither the address nor the
outcome's detail reaches a log line.

## Demo mode

Demo signs itself in as `rodion` and shows no sign-in screen. There is nothing
to authenticate and nothing real behind it, and the screenshot script depends
on reaching the screens directly. `POST /api/login` answers 404 there.

## What this was built to grow into

The tables are shaped the way a hosted authentication library shapes them, and
all of the logic is in one file, so the owner can move to
[Better Auth](https://www.better-auth.com) later — the library the ecosystem
settled on after Auth.js was handed to its team in 2025 — by migrating two
tables and signing in once more. That is the trade this took: a library gives
sign-up, change-password, reset-by-email, Google and a second factor as
configuration, and costs about fifteen dependencies in a server that has two.
Those features are not wanted yet, so they are not paid for yet.

Adding them here instead, when the time comes:

- **Google** — an `identities` table beside `users`, and one route pair for
  the redirect and the code exchange. [`arctic`](https://arctic.js.org) is the
  OAuth client; it has no other opinions.
- **A second factor** — a secret column on `users`, `@oslojs/otp` for the
  codes, and a step between a verified password and a written session row.
- **Change password** — a form, `hashPassword`, and dropping the member's
  other sessions. It has to take the seeding above with it.
