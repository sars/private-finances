# Credential expiry monitoring

Two credentials are watched: the **OpenAI API key** and the **IBKR Flex Web
Service token**. Both use the same ladder — reminders **5, 2 and 1 days
before**, counted in Europe/Riga calendar dates — and both appear on `/ops` and
in `/api/ops` under `credentials`, each with its state and expiry. A credential
with no expiry setting is still listed, as `unknown_expiry`; it is not omitted,
because a silent row would read as a healthy one.

## The OpenAI API key

The owner supplied **December 10, 2026**, with reminders **5, 2 and 1 days before**.
Use Europe/Riga calendar dates. The exact expiry time was not supplied.
The OpenAI key is installed in a restricted server file. The runtime is enabled
with gpt-5.4-mini-2026-03-17 after a successful synthetic classification probe.
Expiry monitoring itself does not activate AI.

Configure this non-secret metadata in `/etc/private-finances/app.env`:

```dotenv
OPENAI_API_KEY_EXPIRES_ON=2026-12-10
```

The warning dates are December 5, 8 and 9 in Europe/Riga. Date-only metadata shows
`expires_today` throughout December 10, then `expired` on December 11. It never
claims the provider will revoke the key at a specific midnight. These are reminders
based on the owner's supplied date, not an API check of actual key validity.
Missing metadata is `unknown_expiry`; impossible or malformed dates are
`invalid_expiry`. Neither state invents an expiry date or sends reminders.

If an exact provider-confirmed timestamp becomes available, use
`OPENAI_API_KEY_EXPIRES_AT` with an ISO timestamp including an explicit timezone,
and remove `OPENAI_API_KEY_EXPIRES_ON`. The date-only setting takes precedence
when both exist. Timestamp metadata reports `expired` at that exact instant;
advance thresholds still use Europe/Riga calendar dates. Never put the key value
in either expiry setting.

## The IBKR Flex Web Service token

Interactive Brokers issues the Flex Web Service token for a year, and Client
Portal prints the exact instant it dies. Record that instant:

```dotenv
IBKR_FLEX_TOKEN_EXPIRES_AT=2027-08-19T18:14:23Z
```

`IBKR_FLEX_TOKEN_EXPIRES_ON` takes a bare date for a token whose exact time was
never written down. The instant takes precedence when both exist — the opposite
of the OpenAI key, where no confirmed instant exists and the date is the better
of the two. An ISO timestamp must carry an explicit timezone.

The reminder names the token and the way back to a new one: generate it in
Client Portal → Performance & Reports → Flex Queries → Flex Web Service
Configuration, save it to the server's credentials directory as
`ibkr-flex-token`, and update `IBKR_FLEX_TOKEN_EXPIRES_AT`. An expired token
stops the weekly holdings snapshot from reading the broker
([assets.md](assets.md)) and nothing else says so, which is why it is watched
here. Never put the token value in either expiry setting.

## The shared machinery

`credentialsHealthFromEnv(env, now)` returns one entry per tracked credential;
`credentialHealthFromEnv(env, now)` still returns the OpenAI key alone. Each
entry carries only the credential name, its human label, state, `expiresOn` or
`expiresAt`, calendar days remaining and the active warning threshold. It can
safely populate authenticated operations UI without reading or returning any
credential. `credentialExpiryHealth(credential, value, now, timeZone)` exposes
the underlying parser, and `openAiCredentialHealth(value, now, timeZone)` is the
OpenAI key's name for it. Day calculations cover both Riga daylight-saving
transitions.

The Telegram worker checks this metadata after its normal authenticated
configuration. `initializeCredentialHealth` creates `credential_reminders`, and
`CredentialReminders` queues and sends notices only to the existing verified group.
The worker initializes this table idempotently alongside its polling cursor;
schema migration 8 also includes the table in the application schema and restore inventory.
The `credential` column is constrained to the names the application knows —
`openai_api_key`, `bank_consent` and `ibkr_flex_token`; migration 56 replaced the
constraint to admit the last of them, touching no rows.

Reminders are unique per credential, expiry value, warning threshold and group,
and each credential's series is retired on its own: replacing the Flex token
cancels nothing queued for the OpenAI key. There are only
5-, 2- and 1-day notices; `expires_today` and `expired` are UI states, not extra
Telegram messages. If the worker recovers within a warning interval, it sends the
current interval once rather than replaying all earlier thresholds. A newer
threshold or changed/removed expiry cancels stale queued notices. Repeated daily
checks do not resend a notice. A failed or interrupted send becomes `uncertain`;
it is not retried automatically because Telegram may already have delivered it.
`CredentialReminders.status()` returns safe delivery-state counts for review.

After rotating the key, update the metadata to the new confirmed date/time and
restart only the affected application/Telegram services so they reload configuration.
Old reminder records remain as delivery history. Changes cannot recall a message
already in flight or delivered. The server expiry setting and running Telegram worker were verified on September 11.
No real reminder is due until December; the date boundaries and deduplication were
verified with synthetic tests. See
[credentials.md](credentials.md) for official credential sources and rotation.
