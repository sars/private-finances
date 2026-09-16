# Roadmap and remaining decisions

Updated September 12, 2026. See [STATUS](STATUS.md) for verified release details.

## Working

Private GitHub repository, pinned dependencies, reviewed PRs, PostgreSQL CI,
incremental commits, a private Tailscale HTTPS deployment and guarded rollback.
Branch protection is procedural under the current GitHub plan.

Frequent bank polling: direct Monobank for both owners about every 37–38 minutes
(30 minutes after completion), Enable Banking Wise/Revolut for Rodion and Wise for Katya every
30 minutes after completion in an owner-authorized trial, with automatic six-hour
fallback after API errors. Rolling imports include today. Own-account registry, conservative transfer suggestions, exact
per-currency accounting, classification audit, confirmed category rules, tags,
weekly/monthly Riga reports, prompt Telegram questions for new unclear payments
after triage, and bounded AI suggestions.
The complete responsive dashboard uses shadcn/ui, Tailwind, Recharts and Lucide with system theme.
OpenAI key expiry is tracked with requested 5/2/1-day Telegram reminders.
AI spending has a shared $10 monthly cap, conservative reservations and dashboard
usage visibility; model pricing and usage anomalies pause further calls.

Local backup and a restore comparison of all 36 tables verified the current release.
This is not off-server protection. Existing AWS S3 remains the preferred deferred
backup destination; its setup reminder is scheduled separately.

Clear transactions now receive category suggestions before Telegram question selection;
first-run owner catalogs are initialized. The owner authorized automatic classification of clear expenses on September 12;
the tested policy is deployed. Ambiguous cases remain for review.
Home and Analytics now separate confirmed spending from historical estimates.
Recent review, a 3,000 UAH priority filter and 2025 archive reduce the active queue.
Telegram JPEG/PNG receipts are live.

## Current implementation increment

See [settings, resolver and frontend proposal](settings-resolver-frontend-plan.md).
Current account defaults and the FX calendar-date correction are deployed and
verified. The owner selected TanStack Router + Query. URL navigation, cached
Transactions/Receipts, admin visibility defaults, spacing and query batching are
deployed and verified in PR60, including the 35-table restore check. Evidence-based rule
conditions and shadow evaluation remain the next separate resolver increment.

## Latest completed increment

Refunds now reduce what a purchase cost instead of erasing it, partial reductions
are supported, merchant reversals are matched automatically on the original amount
within one account, and only genuinely ambiguous money becomes a Telegram question.
Merged in PR 83 with green CI; not yet deployed. See
[refunds](refunds.md) and [ADR 0007](adr/0007-refunds-and-reimbursements.md).


Full-page explanation-first review, visible combined app/Telegram context and simple
cash purchases are deployed and verified, including the 36-table restore. See [review flow](explanation-first-review.md).
Cash withdrawal reconciliation remains deferred; it is distinct from entering purchases.

## Open work and deferred decisions

The consolidated [project to-do list](TODO.md) is the canonical checklist, with
separate backend refactoring, frontend caching, categorization, historical analysis,
receipt items, financial edge cases/settings and operations work. It includes
completion criteria and distinguishes deferred features from delivered ones.

Frontend systematization is researched and planned in
[the frontend design system](frontend-design-system.md): keep the current stack,
add the missing shadcn chart, sidebar, command and table layers, and put a
`components/finance/` vocabulary between the primitives and the screens. Its
stages are sequenced so the analytics screen designed in [analytics](analytics.md)
is built on that layer rather than beside it. Nothing of it is built yet.

Backend refactoring is an explicit remaining increment, not satisfied by the
already delivered review query batching. Start with measurements and a concrete
module-boundary proposal; preserve financial behavior through atomic changes.

Kate Wise low activity is confirmed expected and is not an active backlog item.
Historical queue counts must be refreshed before analysis. No missing FX or
unresolved transaction should be presented as complete personal spending.
Monobank jars remain excluded by the owner's choice.
