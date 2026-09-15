# Where credentials come from

Reviewed against official provider documentation on 2026-09-11. This guide contains
no secret values. Current rollout and consent status belong in [STATUS.md](STATUS.md).

Runtime credentials live only on the server, outside Git and release archives.
Use an authenticated administrative session to install them; never paste tokens,
PEM contents, bank session IDs or passwords into chat, issues, screenshots or logs.
The operator should record each credential's purpose, source account and renewal
procedure without recording its value in the repository.

## Enable Banking: application key and separate bank consent

1. Sign into the [Enable Banking control panel](https://enablebanking.com/sign-in/)
   and open **API applications**. For real bank data, register a **Production**
   application; Sandbox credentials cannot be converted into production credentials.
2. Generate the key in the browser or provide your own public certificate. Save the
   downloaded private PEM securely. The assigned application UUID is the application
   ID; the generated download is named after it. Use the existing production
   application for this installation instead of creating duplicates.
3. Set the allowed redirect to the exact `PUBLIC_ORIGIN` from server configuration
   followed by `/connections/enablebanking/callback`. The configured private Tailscale
   address is documented in [bank-consent.md](bank-consent.md). Keep Tailscale connected
   on the device completing consent; do not use the old example.com URL.

These steps and the production activation options are described in the official
[control panel guide](https://enablebanking.com/docs/api/control-panel/) and
[authentication reference](https://enablebanking.com/docs/api/reference/).

In restricted production mode, link every intended bank account in the control
panel. Linking makes those accounts eligible; it does **not** authorize the app's
bank session. Each owner must then sign into our dashboard as themselves and approve
Wise and Revolut separately through **Bank connections**. One person's consent does
not cover the other person's accounts. This distinction is explicit in the
[linked-account instructions](https://enablebanking.com/docs/api/linked-accounts).

Server configuration:

| Item | Location / setting |
| --- | --- |
| Application ID | `ENABLEBANKING_APPLICATION_ID` in restricted app/sync configuration |
| Private PEM | `/etc/private-finances/credentials/enablebanking.pem` |
| Dashboard key path | `ENABLEBANKING_PRIVATE_KEY_FILE` points to that PEM |
| Kate application ID | `ENABLEBANKING_KATYA_APPLICATION_ID` in restricted app/sync configuration |
| Kate private PEM | `/etc/private-finances/credentials/enablebanking-katya.pem` |
| Kate key path | `ENABLEBANKING_KATYA_PRIVATE_KEY_FILE` points to that PEM |
| Secret directory for imports | `CREDENTIALS_DIRECTORY=/etc/private-finances/credentials` |
| Consent sessions | `ENABLEBANKING_SESSION_DIRECTORY=/var/lib/private-finances-consent` |
| Per-owner, per-bank session file | `enablebanking-<owner>-<wise\|revolut>-session` within that directory |

Owner-specific settings `ENABLEBANKING_<RODION|KATYA>_APPLICATION_ID` and
`ENABLEBANKING_<RODION|KATYA>_PRIVATE_KEY_FILE` must be configured as a complete
pair. Legacy unprefixed settings belong only to Rodion; Kate must never fall back
to his application. Dashboard consent and scheduled imports use the same selector.
Kate generated her PEM through her own Enable Banking application registration;
the provided download was a PEM with a `.pem.txt` filename, installed as a private
server-only credential. No private-key content belongs in Git or logs.

The application keys are configured. Bank access remains separately dependent on
account linking and each owner's current consent. Renew expired/revoked consent
through Bank connections; never copy another owner's session. To stop access, disable
that bank's schedule and revoke its consent through the bank/provider. If a private
key is exposed, disable the affected application access and replace its credentials
through Enable Banking's application management/support process before resuming.

## Monobank: one personal token per owner

Each owner opens the official [personal API portal](https://api.monobank.ua/),
authenticates with their own Monobank account, and obtains their own personal API
token. The [Monobank API documentation](https://api.monobank.ua/docs/index.html)
describes this token-based access. Both owners' tokens are configured on the server:

- Rodion: `/etc/private-finances/credentials/monobank-rodion-token`
- Katya: `/etc/private-finances/credentials/monobank-kate-token`

The filename uses **kate**, while the application owner name is **katya**. Preserve
that filename because the importer expects it. A token belongs to one bank customer,
not one individual account. To replace or revoke access, use the owner's official
personal API portal (or bank support if needed), replace the server file, and verify
a bounded read-only import before resuming that owner's schedule.

## Telegram: bot token plus verified group and user IDs

The bot token is installed on the server and both owners have paired with the group. The worker is active and the first ten owner-scoped questions were delivered.
Create the bot through Telegram's official **@BotFather**, using `/newbot`, and keep
the returned token private. Create a private group containing Rodion, Katya and this
bot. See Telegram's [bot setup tutorial](https://core.telegram.org/bots/tutorial).

Have each owner send a command addressed to this bot in that group. An operator can
inspect the bot's own [getUpdates](https://core.telegram.org/bots/api#getupdates)
responses on the server and bind `message.chat.id` to the group and `message.from.id`
to the verified sender. Keep the IDs as exact strings. Do not use third-party
“find my ID” bots, guess identities from usernames, or publish raw update payloads.
An existing webhook must be accounted for before using polling; `getUpdates` does
not work while a webhook is configured.

Store the token in the server's restricted credentials directory and bindings in
restricted server configuration when the worker is configured. The module requires
`chatId` and separate `userIds.rodion` / `userIds.katya`; these are authorization
inputs, not placeholders to bypass. A token alone does not enable delivery. If exposed,
replace it through [BotFather](https://core.telegram.org/bots/features#botfather).

## OpenAI: an API project key for classification suggestions

The API key is installed on the server with mode 600. The runtime is active with gpt-5.4-mini-2026-03-17 after a synthetic app-level verification. The configured expiry is December 10, 2026; see [expiry monitoring](credential-health.md) for the requested 5/2/1-day reminders.
Create/select a dedicated project on the [OpenAI API platform](https://platform.openai.com/)
and create a project API key. The [official quickstart](https://developers.openai.com/api/docs/quickstart)
explains key creation. This is an API credential, not a ChatGPT login, session cookie
or Codex GitHub credential.

Store the key server-side and configure the classifier's `apiKey`, approved `model`,
`maxRequestsPerDay`, `maxInputChars`, `maxOutputTokens` and `timeoutMs`. Choose a model
available to that project; do not assume a particular subscription supplies API
access. Review the platform's current model access, billing and
[rate limits](https://developers.openai.com/api/docs/guides/rate-limits).
Request/token limits are not a fixed monetary price guarantee. Keep the application
request cap and timeout even when platform limits are configured.

The classifier proposes reviewable classifications; it receives no banking keys,
SQL access, payment tools or authority to overwrite human decisions. Revoke an
exposed API key in project settings, install its replacement, and verify only a
bounded test before enabling live requests.

## GitHub: development access, not runtime access

Repository access is already configured through `~/.local/bin/pf-gh` on the operator's
computer. In GitHub **Settings → Developer settings → Personal access tokens →
Fine-grained tokens**, select only the intended repository, an expiry, and the
permissions required for repository/PR/CI work. Follow GitHub's
[fine-grained token guide](https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/managing-your-personal-access-tokens).

Keep using `pf-gh`; do not restore the revoked broad OAuth authorization. This PAT
is an operator development credential, so it is not copied into the application's
runtime environment. Replace it before expiry and revoke old/exposed tokens in
GitHub settings.

## Amazon S3 and restic: deferred, not configured

S3 setup is deferred by the owner. Local verified recovery does not establish
an off-server encrypted backup. When resumed, use the owner's AWS account to create
or select a private backup bucket and a workload identity restricted to that
bucket/prefix. Prefer an IAM role with temporary credentials where the VPS can
support it; otherwise use a dedicated least-privilege IAM identity, never root
access keys. See [AWS IAM recommendations](https://docs.aws.amazon.com/IAM/latest/UserGuide/best-practices.html).

The policy must support the intended restic backup/restore/locking operations;
review deletion permissions separately against the retention plan. Configure
`RESTIC_REPOSITORY`, `RESTIC_PASSWORD_FILE` and the selected AWS credential mechanism
in `/etc/private-finances/backup.env`. Long-lived credentials, if used, are
`AWS_ACCESS_KEY_ID` and `AWS_SECRET_ACCESS_KEY`; temporary credentials also require
their session token and a working renewal mechanism.

Generate a separate restic encryption/recovery password. Keep its runtime copy in
a restricted server secret file and a recoverable copy in the owner's password
manager; losing it can make the repository unrecoverable. Follow the
[restic S3 setup guide](https://restic.readthedocs.io/en/stable/030_preparing_a_new_repo.html#amazon-s3)
and [project backup procedure](backups.md). Test restore into a disposable database
before marking off-server recovery verified. Rotate AWS credentials without deleting
the encrypted repository or losing the restic recovery password.

## Installation, renewal and cleanup

`/etc/private-finances/app.env` and `sync.env` are restricted environment files read
by the service manager. Secret files must be readable by their intended service
user and inaccessible to unrelated users; mode 0600 and private directories with
mode 0700 require correct ownership. Never make secret files world-readable to
solve a permissions error. Restore-verification markers are not secrets and have
a separate policy in [scheduling.md](scheduling.md).

After a replacement is verified, revoke the superseded credential and remove
unneeded copies from Downloads, temporary transfer locations and clipboard/history
where applicable. Deleting a local file does not revoke a provider credential or
remove copies from backups; exposure calls for revocation/rotation. Canonical bank
credentials and sessions stay on the server. Keep only the intentionally separate,
protected recovery material needed to recover that server.

### Current AI runtime

The server uses `gpt-5.4-mini-2026-03-17`, with a 50-request daily application cap,
4,000-character inputs, 512 output tokens and a 20-second timeout. The pinned
snapshot supports Responses structured outputs; its default reasoning setting is
none ([official model documentation](https://developers.openai.com/api/docs/models/gpt-5.4-mini)).
A synthetic classification through the actual application code passed before
activation. Suggestions still require owner review. These application limits bound
request/token usage; they are not an account-wide dollar spending cap.
