# Bank consent

Application authentication and bank consent are separate. The production PEM
works on the server. In restricted mode, link each desired account in the Enable
Banking control panel first; the application flow then creates its own bank
session. Each owner approves their own connection while signed into our dashboard.

Set the application's allowed redirect URL to:
`https://<private host>:8443/connections/enablebanking/callback`, substituting
the private Tailscale hostname recorded in
`~/.config/private-finances/server-access.md`, which is kept outside Git.
The original example.com callback must be replaced. Keep Tailscale connected on
the device completing bank approval. No public endpoint is required for this
browser redirect. The Bank connections page offers the banks listed in
`src/connectors/banks.ts` — Wise, Revolut, Swedbank and LHV — with the country
the provider lists each under filled in when the bank is chosen (LHV is `EE`,
the others `LV`), then links to the provider's approval page. The country stays
editable; left blank on the plain form it means the bank's own. The page shows
each bank by the name the owner uses; the form sends the provider's registered
name, and that is what `bank_consents.bank` stores.

Starting an approval for a bank that already has a live one — by mistake, or to
renew — records only the attempt (its state, country and requested bound in
`requested_expires_at`). The row stays `authorized` with its real expiry until
the callback succeeds, and a refused or failed attempt puts it back exactly as
it was, so the expiry reminders keep watching the approval that is actually in
force. Only a bank with nothing to fall back on reads `failed`.

A sync timer may be enabled before its bank has been approved. Until the
approval writes the session file, each run ends as `consent_pending`: no
latch, no cooldown, and the first import follows the approval on its own.

An approval that _lapses_ is different, because by then a session file exists and
the provider refuses it: the run fails, and the scheduler latches the connection
for a person to look at. Renewing the approval is that person answering, so the
next run lifts the latch on its own and imports — nothing has to be cleared on
the server. See "Failures and disablement" in [scheduling](scheduling.md) for how
the two files are compared and why one approval permits only one attempt.

An approval lasts days rather than months, and when it lapses the imports stop
without any other sign. The Telegram loop therefore checks every authorised
approval on each pass and sends a notice five, two and one day before it ends,
and again on the day itself — worded to say which bank, whose approval, and that
nothing is importing until it is renewed. Renewing an approval retires any
notice that has not yet been sent. See `enqueueBankConsents` in
`src/credential-health.ts`.

The server signs AIS requests, stores only a hash of the 15-minute state token,
checks the authenticated callback owner, and claims each state once before
exchanging the code. The initial access request is bounded to ten days; the bank
may shorten it. Session IDs are written atomically to mode-600 files under
/var/lib/private-finances-consent, separately for each owner and bank. Neither
codes nor session IDs are logged or returned on the connections page. Referrer
headers are disabled. Only /auth and /sessions POSTs are supported; no payments.

Configuration: ENABLEBANKING_APPLICATION_ID, ENABLEBANKING_PRIVATE_KEY_FILE,
ENABLEBANKING_SESSION_DIRECTORY and PUBLIC_ORIGIN in the restricted app.env.
The service uses StateDirectory=private-finances-consent. A manual Enable Banking
import additionally selects ENABLEBANKING_BANK=wise or revolut and uses the same
session directory. The existing daily Enable Banking timer must not be enabled
without selecting and reviewing its bank; multi-bank daily orchestration is still
pending. Consent alone does not start imports.

An interrupted callback can leave status=processing. Investigate first, then mark
that owner's bank state failed before initiating a new consent; do not retry an
uncertain code exchange. Expired/revoked sessions require owner reauthorization.
Session IDs must be backed up securely or recreated through new consent.

Sources reviewed 2026-09-11:
https://enablebanking.com/docs/api/linked-accounts
https://enablebanking.com/docs/api/reference/
