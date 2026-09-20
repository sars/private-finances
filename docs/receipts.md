# Receipt evidence in Telegram

The paired household bot accepts JPEG/PNG photos, image documents and PDF
documents from its two configured owners only. An update is acknowledged only after its receipt job is
persisted; repeated updates cannot enqueue a second request. Files over 5 MB,
other file types and foreign chats/users are ignored. Downloads use only fixed
Telegram origins and validated paths, bounded bodies, no redirects and timeouts.
The declared type never decides what a file is: the downloader accepts only bytes
that begin with the JPEG, PNG or `%PDF-` signature, whatever the file name says.
Image and document bytes live privately in PostgreSQL, not the release tree or
public assets.

The configured, already-priced OpenAI model extracts receipt/non-receipt status,
merchant, date, positive total in integer minor units, currency and item names.
Images and text are untrusted evidence; no tools or classification actions are
available to the model. `store:false` is sent to the Responses API. Image request
format follows the [official image input documentation](https://developers.openai.com/api/docs/guides/images-vision).
Verified September 12, 2026: the [GPT-5.4 Mini model page](https://developers.openai.com/api/docs/models/gpt-5.4-mini)
lists image input, Responses, structured outputs, a 400,000-token context, and
the configured `gpt-5.4-mini-2026-03-17` snapshot. The reservation covers the full
400,000 input tokens plus the bounded output, rather than guessing image tokens.

Costs reserve the full model context under the same advisory lock, monthly $10
limit, safety margin and daily count as categorization. Actual usage settles that
reservation. Failed/uncertain paid attempts keep their hold and are not retried
blindly. A worker crash marks stale work failed. Budget-blocked work stays queued.
No separate unmetered OCR service is used.

Receipts are shared family evidence: either configured member may upload in the
paired family chat, and either authenticated member can list/view all family
receipts and privately stored images. The original uploader remains `owner` for
provenance. Manual attachment can select either member's transaction, including
pending payments; audit events record the acting member and previous attachment.
The receipt-specific candidate endpoint exposes only payment ID, owner,
description, amount, currency, booking time and status, with bounded search.
Generic transaction APIs and payment editing retain their owner boundaries.

The token-based merchant rule and the Enable Banking booking window described next
are implemented and covered by synthetic tests, but not deployed.

Automatic attachment requires one unique debit across both family members
with amount/currency and a matching merchant inside the allowed date window.
The window depends on what the provider's date means: Monobank supplies the real
transaction instant, so its Riga calendar day must equal the receipt date exactly;
Enable Banking (Wise, Revolut) supplies a booking calendar day that typically falls
one to three days after the purchase, so its Riga day is accepted from the receipt
date up to three days later. Uniqueness is evaluated across the whole window and
both owners together: two same-amount debits anywhere in it leave the receipt
pending. A bank sometimes prints a brand abbreviation where the receipt prints the
registered name it stands for, such as `H&M` against `H&M Hennes & Mauritz`; those
letters survive tokenization only as fragments too short to identify anything, so
one normalized name being a prefix of the other also counts as a match. A prefix
and never a substring, so names that merely share a beginning, such as `Rimi` and
`RIMAC`, stay apart. Merchant comparison is token based. Both names are lowercased and reduced
to letters and digits; a terminal `.lv`/`.com`/`.eu` suffix and quotes are removed
from the merchant, which is then split into tokens. Legal forms and geography
(`sia`, `as`, `ooo`, `ltd`, `gmbh`, `uab`, `latvia`, `riga`, `store`, `market`, and
similar) and tokens shorter than three characters are dropped, because they are
exactly what makes a registered name differ from a card description. At least one
remaining token must appear in the description: a token of four characters or more
anywhere inside it, a three-character token only as a whole word. A name that is
nothing but stop-words falls back to the previous whole-name containment rule. This
links `SIA RIMI LATVIA` to `RIMI MR Marijas (Riga)` without inferring aliases
between unrelated names. Monetary candidates remain ambiguous even when only one
merchant matches. A Monobank debit
may also match the exact original purchase in `source_details.operationAmount`
and `currencyCode`: both must be safe integers, the operation amount must be
negative, and the currency must be explicitly supported. This can link an EUR
receipt to a UAH debit without any estimated exchange rate. Missing, malformed or
non-Monobank original data cannot enable this path. Matching revalidates both
members' candidates under the bank-import lock, so corrections and new cross-owner
or cross-currency collisions leave evidence pending. Categories and money are
never rewritten. Non-receipt images are discarded after detection.

## Pending payments, settlement differences and re-attachment

Implemented and covered by synthetic tests; not deployed. See
[ADR 0005](adr/0005-matching-pending-payments.md).

A payment that is still `pending` is a matching candidate exactly like a booked
one, for every bank. The evidence is already complete when the photo arrives —
merchant, date, total and currency all match — so waiting only delayed the owner's
confirmation, and the rest of the system already accepted the pending case
(manual attachment and receipt-informed categorization both work on pending
debits). The rule is uniform rather than per-source: a per-source exception would
express trust in one bank's settlement behaviour instead of the fact that a
receipt belongs to a purchase. Production evidence supports this. Monobank shows a
hold within seconds and settles it as a new revision of the same row, with the
identical amount in every recorded case, while Enable Banking has never produced a
pending row at all (all 42 Wise and Revolut transactions arrived booked), so
booked-only protected nothing there. Uniqueness is unchanged and still decides
first: a pending and a booked row for the same purchase present two candidates and
correctly refuse to link. The Enable Banking three-day booking window and
Monobank's exact-day rule are unchanged.

A settled amount or currency that no longer equals the receipt total is recorded
in `receipt_jobs.settlement_difference` (a JSON object with the receipt total,
the payment amount, both currencies as exact integer minor units and strings, and
the payment revision it was detected at). It is never a reason to detach: amounts
legitimately move between authorization and settlement through tips, fuel
pre-authorizations and foreign-currency re-rating, and discarding correct evidence
automatically and invisibly would contradict the rule that uncertain information
is displayed separately rather than disappearing. The link, the state `matched`
and the payment itself are untouched; the difference is shown on the receipt card
and the owner decides. When the bank corrects the amount back, the record is
cleared. A Monobank debit matching the original purchase in another currency is
compared by that same original-purchase rule, so it is not mistaken for a
difference.

If a bank ever reports the settled purchase as a separate row instead of revising
the hold — Enable Banking keys rows on `entry_reference`, which a bank could change
between PDNG and BOOK — the receipt would be stranded on a row that never settles.
The attachment therefore follows the evidence: a receipt attached to a payment
that is still pending moves to a booked payment matching the same receipt.
Four limits keep the move safe. It only moves away from a payment that is still
pending, so a settled attachment is never second-guessed. It only moves when
exactly one booked candidate matches date window, amount, currency and merchant.
That candidate must carry no receipt of its own, so the already-attached guard
still holds. And it never moves an attachment a person made by hand: the latest
`receipt_attachment_events` row must have `actor='automatic'`. The move is
recorded as an ordinary attachment event with `actor='automatic'` and the previous
payment, the receipt reason becomes `settled_row_replaced_pending`, and both
payments' receipt-derived automatic categories are invalidated.

Both checks run in one bounded sweep, `reviewSettledMatches()`, called once per
worker loop next to the pending sweep: at most 20 receipts per call, oldest
attachment first, no image download and no model call. Candidates are receipts
still attached to a pending payment, plus payments revised since the attachment
whose recorded difference disagrees with what the payment now says, so a
settlement that matches the receipt is not re-examined forever. The sweep runs
under the bank-import advisory lock. It never clears `transaction_id`, never
leaves state `matched` and never writes to `transactions`.

The owner is told once. A newly detected difference is answered on the owner's own
photo message with one fixed reply: "This payment settled at a different amount
than the receipt total. The receipt is still linked; please check it in the app."
No merchant, amount, item or reason code appears in it. It reuses the durable
bounded feedback mechanism, so the attempt counter, the doubling backoff and the
five-attempt limit are unchanged. Because the receipt stays in state `matched`,
the delivered key is not the state alone: it is `matched_difference:` plus the
settled amount and currency. The same difference is therefore announced exactly
once, a later settlement at another amount is announced again, and a correction
back to the receipt total returns the key to plain `matched`.

Migration: schema version 20 adds `receipt_jobs.settlement_difference jsonb`
through the exported idempotent `upgradeSettlementDifference`, called from both
`initializeReceipts` and its own version block, so already-deployed databases get
it too. There is no backfill, because no existing row can carry a difference that
was never detected.

Migration `initializeReceipts` adds `receipt_jobs` and an optional receipt foreign
key to the shared cost ledger. The legacy `proposal_id` field continues as request
UUID; its classifier-only FK is removed because receipts can precede transactions.
Existing cost records and classifiers retain their identifiers. Older application
code can read the expanded schema, but receipt requests must be stopped before
rolling back to an old worker. Do not roll back/drop the new evidence or budget
rows. Root integration registers the migration and authenticated receipt web endpoints.
The photo queue and Telegram polling cursor commit in the same transaction; a
failed cursor update rolls both back. Malformed file IDs are ignored before SQL.

Current boundaries: pages are never stitched into one image; pending matches are
rechecked without model calls after later bank imports (up to 20 every minute,
oldest checked first). Token-based merchant comparison does not infer aliases
between different names, score similarity or use cross-currency approximations, and
a single shared token is never enough on its own: exactly one amount/date candidate
must exist first. Extracted item names are evidence, not an automatically
calculated item-level budget. Real receipt quality requires an owner-submitted receipt after deployment;
tests use synthetic content only.

## PDF receipts

Implemented and covered by synthetic tests; not deployed. A shop that emails a PDF
receipt should not force the owner to photograph a screen, so a PDF document from
the paired family chat is read like a photo.

The model accepts images only, so the pages are rendered first. Rendering sits
behind a one-function `PdfRasterizer` interface, injected into `processOne`
exactly like the downloader and the model requester, so the implementation can be
replaced and no test or CI job depends on a rendering tool being installed. The
shipped implementation, `popplerRasterizer`, drives poppler's `pdfinfo` and
`pdftoppm`, already present on the server, so no package is added and no PDF
parser runs inside the worker. The document is written into a fresh private
temporary directory and both tools are invoked with an argument array, never a
shell string, so nothing from the file can reach a command line; the directory is
always removed, including on failure. Every step is bounded: the subprocess is
killed after 30 seconds with a small stdout allowance, the rendered pages
together may not exceed 4 MB, and zero produced pages is a failure. `pdfinfo`
decides the page count before anything is rendered, and an unavailable or
unparseable `pdfinfo` is a render failure rather than a guess. Failures are plain
errors with fixed code-like messages; no file path and no text from the PDF
appears in them or in any log.

The page cap is 8. A longer document is refused rather than silently truncated,
because a receipt is one or a few pages and a bank statement is not receipt
evidence. All pages travel to the model as separate images in ONE request, in
order, with the same instructions, `detail: 'high'`, `store: false` and JSON
schema as a photo — a single photo is simply an array of one. One request means
one budget reservation, unchanged by the page count, because the reservation
covers the full model context and prices a body whose input has already been
replaced by a short string. Pages are never stitched into one tall image, which
would need an image encoder the project does not have.

Order of work protects the money. The existing SHA-256 duplicate check runs on
the downloaded original bytes, so a resent PDF is caught before any spend.
Rendering then happens before the budget reservation, so a PDF that is too long
or cannot be read is marked `failed` with reason `receipt_pdf_too_many_pages` or
`receipt_pdf_render_failed` and never costs anything. Both get one fixed Telegram
reply on the owner's own message — "This PDF has too many pages to read. Please
send the receipt page only." and "I could not read this PDF. Please send a photo
of the receipt instead." — carrying no file name, page count, merchant or amount.
Everything after extraction (duplicate detection, matching, feedback) is
identical to the photo path.

The original PDF is the stored evidence, in `image`/`mime`, and the rendered
first page is stored beside it in `preview_image`/`preview_mime` as the
thumbnail. The Receipts page shows that thumbnail through the existing image
endpoint and adds an "Open PDF" link to `/api/receipt-file`, which serves the
original bytes to either authenticated family member under the same owner checks
as the image route, with `Content-Disposition: inline`,
`Cache-Control: private, no-store`, `X-Content-Type-Options: nosniff` and
`Content-Security-Policy: sandbox`, because a PDF is active content in a browser.
Deleting a receipt removes the preview along with the original.

Migration: schema version 21 adds `receipt_jobs.preview_image` and
`preview_mime` through the exported idempotent `upgradeReceiptPreview`, called
from both `initializeReceipts` and its own version block, so already-deployed
databases get them too. There is no backfill: every existing row is a photo,
whose stored image is already its own preview, and the viewer falls back to it.

## Duplicate receipts

A payment that already carries a matched receipt never gains a second automatic
link, whether it is pending or booked, and whether the link would come from the
pending sweep or from re-attachment to a settled row. If a later photo would resolve to that same payment, it is marked
`duplicate_payment` instead and the earlier evidence is left untouched. This
protects receipts that were already pending before duplicate detection existed,
which the intake checks cannot see. Manual attachment is unaffected for ordinary
receipts; a receipt already marked duplicate is outside the attach contract, so
neither the sweep nor the API can produce a second link.

Implemented and covered by synthetic tests; not deployed. The same purchase can
reach the bot twice — two photos, two messages, or both owners sending it — and
`UNIQUE(chat_id,message_id)` cannot see that. Two checks mark the later job
`duplicate` with `duplicate_of` pointing at the earlier receipt it repeats.

The first check runs on the downloaded bytes, before any reservation or model call:
if a live job (any state except `deleted`, `failed` and `not_receipt`) already has
the same SHA-256 image digest, the new job becomes `duplicate` with reason
`duplicate_image`, its image is dropped and no AI budget is spent at all. The second
check runs after extraction, before matching: if another `pending` or `matched`
receipt has the identical purchase date, total and currency and an overlapping
merchant token in either direction, the new job becomes `duplicate` with reason
`duplicate_receipt`. That image is kept so the owner can compare the two photos.

A duplicate is never linked to a payment automatically and never serves as
categorization evidence, which requires `state='matched'`. The pending sweep only
revisits `pending` rows, so a duplicate is never re-matched later. The bot answers
the owner's photo with one fixed reply saying it looks like a receipt already sent;
no merchant, amount, item or reason code appears in that message. The Receipts page
shows a `Duplicate` badge, hides linking and re-matching for it, and keeps Delete
available, so an owner who disagrees can remove the row. No existing receipt can be
in this state, so the migration adds `image_sha256`, `duplicate_of` and the widened
state constraint without any backfill.

## Deleting a receipt

Implemented and tested, not yet deployed. Either family member can delete a
receipt from the Receipts page after confirming an inline warning. Deletion is a
soft delete: the job row stays as a tombstone in state `deleted`, because the
shared AI cost ledger references it and the monthly budget accounting must stay
intact. The stored image and the extracted content are removed and the reason
becomes `owner_deleted`. A linked payment is detached, its receipt-derived
automatic category is invalidated, and a `receipt_detached` audit event records
the acting member on that payment. Existing attachment history is left
untouched. Deletion is refused with a clear message while the photo is being
read, because a paid model request may be in flight. Deleted receipts no longer
appear in the receipt list or API, their photo is no longer retrievable, and
they can never be selected as categorization evidence again.

## Telegram feedback on receipt photos

Implemented and covered by synthetic tests; not deployed. The worker answers on the
owner's own photo message: 👍 as a reaction once the photo is linked to a payment,
automatically or by a manual link in the app; 👀 while the receipt was read but no
unique payment exists yet. The 👀 reaction is replaced by 👍 when the match
later arrives. A photo that is not a receipt, or whose reading failed, gets a short
plain reply to that message instead — no keyboard and no reply prompt.

Messages are fixed constants. Merchant, amount, items, extraction output and internal
reason codes never appear in a chat message. Every action is addressed to the stored
`chat_id` and `message_id` of that job's own photo.

Feedback is durable and bounded. The acknowledged state is stored per job, so each
state change is delivered once and a restart does not repeat it. Each attempt is
counted and delayed before the network call, with the delay doubling from one minute;
after five failed attempts the job is abandoned rather than retried forever. Telegram
is never called inside a database transaction, so an outage delays feedback only and
never blocks receipt intake, extraction or matching.

Existing receipts are backfilled as already acknowledged when the columns are first
created, so enabling this feature sends no retroactive reactions or replies. A job
re-queued by the monthly budget guard (`budget_wait`) stays `queued` and produces no
feedback in this version.

## Receipt-informed transaction categories

The Telegram worker checks attached evidence once per minute while automatic
categorization is enabled. A new receipt fingerprint or bank revision triggers a
receipt-specific proposal, including both family's attached merchant/item evidence.
This can improve an unresolved or automatic personal-expense category, including
pending debit payments. Only one complete receipt and a supported category at
the existing corroborated-confidence policy can be applied automatically
(>=0.95 generally; lower confidence only with supported consumer MCC evidence,
including >=0.70 for matching broad restaurant/grocery/pet categories); transfer MCC, conflicting rules,
manual decisions, excluded accounts, mixed/missing evidence and low confidence
remain protected or reviewable. Exact item purchases are never invented from
generic labels. No per-item accounting is implemented.

Requests reuse the existing atomic $10 budget and idempotent classifier ledger.
No photograph is re-extracted just to update a category. Receipt-derived categories
are not reusable merchant-cache examples. Receipt/transaction/account/rule state is
rechecked at application time; moving a receipt invalidates its prior automatic
receipt category. Audit history records the proposal, receipt fingerprint, policy
and before/after category. The Receipts page shows current category and outcome.
See [the future item analytics architecture](receipt-item-analytics.md).

Receipt-bearing payments bypass merchant-only triage except explicit saved rules.
Inconclusive receipt assessments enter the existing review/Telegram clarification
queue when eligible; they cannot be silently replaced by a merchant-only guess.

## Answering a question with the receipt

A photo sent as a reply to one of the bot's payment questions is an answer about
that payment. The reply names it, so the link is taken from the reply rather
than searched for: `receipt_jobs.answers_transaction_id` (schema 64) records the
payment the question was about, resolved from `telegram_outbox` by the chat and
the message replied to, and the matcher attaches to it instead of running the
date, amount, currency and merchant search.

This is the case the search is least able to help with. It refuses to guess
between two candidates on purpose, so two payments of the same amount on the
same day leave a receipt unmatched however clear it is to the person who sent
it — and that person had already said which one they meant. The attachment is
recorded as theirs, with actor set to the member and reason
`owner_answered_question`, not as an automatic match.

Only the member's own open question counts. A photo replying to the question
addressed to the other member carries no statement about what this member meant,
so it is stored and matched the ordinary way. A photo that is not a reply at all
is unchanged in every respect.

Once attached, the receipt reaches the payment's category through the existing
receipt-informed categorization above: the attachment invalidates any automatic
receipt category on that payment and the next pass proposes one from the items.
Nothing here classifies the payment by itself, and no receipt evidence is sent
to the chat.
