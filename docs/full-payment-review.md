# Full-page payment review and saved explanations

Candidate, not a deployment claim. `/review?id=...` is a dedicated full-page view,
using the same owner-scoped detail endpoint. The transaction list's filters remain
in the URL when returning. On mobile the content flows vertically; wide screens
place evidence beside the decision editor. Saved explanations appear before the
bank field list, labeled by Telegram/app source. Bank details are collapsible;
linked receipt metadata/items have direct photo links. Historical explanations
are never filtered away because the question used an older payment revision.

Opening a payment retrieves fresh detail context while retaining its cached view;
there is no polling or focus-driven update. Explicit Refresh payment remains.
A new explanation is sent with a stable request ID for retry of the same payload,
then saved server-side before the AI suggestion step. The response pre-fills only
type, category and the user's explanation as the editable reason. A suggestion
never submits `/classify`: the owner must explicitly Confirm decision. The
decision fields are always visible rather than hidden behind a disclosure, and
one confirmation saves type, category, tags and spending pattern together; see
[the transaction review page](transaction-review-page.md) for its layout. If AI
is unavailable or fails, the UI distinguishes the saved explanation from the
missing suggestion.

Contract: POST `/api/payment-explanations`, URLencoded `id`, `revision`, `text`,
`csrf`, `requestId`; response `{explanation, proposal?, suggestionStatus}`. The
proposal wrapper contains `id` and an inner classification proposal. Unified
review replies include `source: telegram|app`, optional proposal and proposal_id.
Confirmation forwards `explanationId` for the saved app explanation associated
with the draft; existing revision and permission checks remain authoritative.

Cash creation can supply an already saved app explanation and current-revision
proposal. The review page reuses that suggestion without making another AI call;
the description pre-fills the explanation field and unchanged saved text is not
submitted again. This does not imply the decision has been confirmed.

Cash entry is available from Transactions → Add cash expense (`/cash`). It records
an amount, currency, purchase day and explanation for the signed-in person. The
initial currency follows the reporting preference; the purchase day follows
Europe/Riga and remains editable. This is a day, not a claimed purchase time.
Creation saves an unresolved payment and its explanation, then attempts a bounded
suggestion. It opens the payment page even when AI is unavailable. Suggested
fields still require **Confirm decision**; creation does not pretend the category
has already been confirmed. Identical retries retain their request ID to prevent
duplicate cash payments. Full explanations are limited to 2,000 characters; the
editable decision reason uses up to 500 characters.
