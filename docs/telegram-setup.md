# Telegram clarification runtime

This worker sends only explicitly queued clarification questions. It does not
queue transactions automatically, interpret replies, apply classifications or
retry uncertain sends. Replies remain pending proposal inputs for owner review.
A shared chat is visible to its participants; configure the intended private
family chat and both owners' exact numeric Telegram user IDs.

The runtime is disabled until all configuration is present and the service marker
exists. Do not enable it before authorizing actual Telegram sends. Deployment of
these files alone does not enable the worker.

## Server-only configuration

Create a bot with [BotFather](https://t.me/BotFather). Keep its token out of chat,
Git, screenshots and local files. **Run the connection step separately** in your
Mac terminal:

```sh
ssh radar
```

You are now in the server shell. Run this command there; paste the token only
when the hidden `Bot token:` prompt appears, then press Enter:

```sh
sudo bash -c 'read -rsp "Bot token: " pf_bot_token; echo; [ -n "$pf_bot_token" ] || exit 1; umask 077; printf "%s\n" "$pf_bot_token" > /etc/private-finances/credentials/telegram-bot-token; chmod 600 /etc/private-finances/credentials/telegram-bot-token; chown private-finances:private-finances /etc/private-finances/credentials/telegram-bot-token; unset pf_bot_token'
```

Type `exit` to return to the Mac. Do not run this in a shell with tracing enabled.
Add the bot to the private family group. Each owner sends `/start@YourBotUsername`
in that group; read setup update metadata with the server-stored token and confirm
the owner mapping before enabling outgoing messages. For ordinary receipt photos in the family group, use BotFather `/setprivacy` →
select this bot → Disable. Telegram may require removing and re-adding the bot for
the new setting to take effect. Admin privileges are unnecessary. With privacy
mode enabled, only explicitly addressed messages/replies reach the bot, so a plain
receipt photo can silently be invisible. The operator then configures `telegram.env`.

Save only paths and the verified identifiers in `telegram.env`:

```text
TELEGRAM_BOT_TOKEN_FILE=/etc/private-finances/credentials/telegram-bot-token
TELEGRAM_CHAT_ID=<numeric-private-or-group-chat-id>
TELEGRAM_RODION_USER_ID=<Rodion-numeric-user-id>
TELEGRAM_KATYA_USER_ID=<Katya-numeric-user-id>
```

`DATABASE_URL` is read from the existing protected `app.env`. Protect
`telegram.env` with root ownership and mode 600. Owner IDs must differ. The bot
must be present in the selected chat. Obtain chat/user IDs through a trusted
Telegram identity flow; do not paste the bot token into an identity website.
Use one bot token for this application only. Long polling requires no webhook;
if the bot already has one, stop here and resolve that configuration explicitly.
The worker does not remove webhooks automatically.

## Start only after send authorization

Deploy and build the reviewed application release, then install the provided
`private-finances-telegram.service` in `/etc/systemd/system/`. The worker runs
schema migrations at startup, including its durable polling cursor.

```bash
sudo systemctl daemon-reload
sudo touch /etc/private-finances/telegram.enabled
sudo systemctl start private-finances-telegram.service
sudo systemctl status private-finances-telegram.service --no-pager
```

After a verified pilot, enable startup explicitly if desired:
`sudo systemctl enable private-finances-telegram.service`.
To stop, run `sudo systemctl stop private-finances-telegram.service` and remove
`/etc/private-finances/telegram.enabled`. No automatic restart is configured.

Each poll accepts at most 50 updates and a 1 MiB response. Poll requests time out
at 20 seconds; failures stop the worker with a generic diagnostic. No update text,
chat/user IDs, URLs or tokens are logged. Cursor advancement and reply persistence
commit atomically. Wrong-chat, wrong-owner, unmatched and stale replies produce no
proposal input. Malformed update IDs stop the poll without advancing the cursor.

A failed send or expired sending lease becomes `uncertain`. Inspect that state
and reconcile delivery manually; do not requeue or clear it blindly. Run only one
worker per bot/application database. The database serializes polling workers,
but another application consuming the same bot's updates can still steal them.
No real Telegram delivery has been tested by the synthetic test suite.


## Optional automatic delivery

`TELEGRAM_AUTO_QUESTIONS=true` queues at most five new questions per owner per UTC
day by default, only for booked unresolved outflows without an existing human decision.
Leave it unset to use manual dashboard questions only. Questions remain separate
from classification: replies become review inputs, never an automatic decision.

`TELEGRAM_REPORTS_AFTER=<ISO timestamp>` enables delivery of household report
snapshots created after that explicit cutoff. This avoids sending an old backlog
when first connecting the bot. Each snapshot is queued once; uncertain sends
require operator review and are not blindly retried. Keep this unset until the
private group and both owner identities are verified.


### Prompt questions for new payments

With `TELEGRAM_AUTO_QUESTIONS=true`, set
`TELEGRAM_LIVE_QUESTIONS_FROM=2026-09-12T12:00:00Z` to the explicitly chosen rollout
instant (example only; UTC timestamp required). The worker queues questions after
its normal rules/model triage on each loop, without waiting for day end. This
replaces the legacy five-per-owner daily allowance and current-month backlog
selection: booked or pending outgoing payments at or after the cutoff qualify. Older unresolved
payments remain available for manual review in the app. Late imports after a month
boundary still qualify by booking time, not import time; payments booked before
rollout never enter this lane.

Completed deferred/uncertain triage can ask a truthful fallback purpose question
when automatic review could not determine a classification. Uninspected and active
triage do not qualify, and clear quiet suggestions do not become generic questions.
Incoming, zero, business/investment accounts and human decisions stay out.
Existing outbox entries, including uncertain sends, prevent duplicate questions for
the same transaction revision. Exact pending-to-booked settlement can reuse the
existing question; changed evidence stays stale. See [pending payment triage](pending-payment-triage.md).
Each loop queues at most 50 per owner; further
eligible payments drain on subsequent loops. Delivery remains serialized through
the ordinary worker. This makes no additional AI calls and changes neither request
limits nor the shared $10 monthly budget.

Invalid cutoff configuration stops startup. Unsetting the cutoff restores legacy
current-month daily selection; do not use that as a silent rollback if older
questions should remain in the app. Disable automatic questions to pause instead.


Receipt setup verification: call getMe privately using the server-held token and
check can_read_all_group_messages=true. Then send one receipt photo from each
configured owner and verify a receipt_jobs row appears. Do not log token URLs or
raw photos/messages. The bot still rejects other chats and unconfigured senders.
Confirmed September 12: privacy disabled and two Kate receipt jobs received.
Photos sent before the setting changed must be resent; the bot cannot fetch old
group history. See [Telegram privacy mode](https://core.telegram.org/bots/features#privacy-mode).
