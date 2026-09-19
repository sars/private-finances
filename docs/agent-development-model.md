# How agents work on this project

This describes how automated coding agents are organized here: which model does
what, how work is isolated, and what must be true regardless of which model runs.
It is written so another team or another model family can adopt it — the roles are
defined by capability tier and responsibility, with our concrete assignment given
as one instance of the pattern.

## Roles, not model names

**Orchestrator.** One long-lived session that holds the requirements, decides what
to build, routes work, reviews every diff, integrates, runs the checks, and opens
and merges pull requests. It is the only role that carries the full context of the
task, and the only one that decides something is finished. It should run on a
strong general model: it reads code it did not write and must catch mistakes in it.

**Implementer.** Short-lived subagents that each receive one bounded task and
return a diff. They start with no context, so a brief must supply everything. They
are split across two capability tiers:

- _Routine tier_ — a cheaper, fast model for work whose shape is already known and
  whose correctness is already fenced by tests: user-interface screens,
  documentation, mechanical refactors, updating test doubles after an interface
  change.
- _Deep tier_ — the same class of model as the orchestrator, for work that needs
  real debugging, touches invariants, or is large enough that a wrong turn is
  expensive.

**Escalation.** A frontier or reasoning-heavy model, used rarely and deliberately:
architectural decisions that will be written down as a decision record,
root-cause investigations, changes that cut across the whole codebase, creative
design work, and the case where the orchestrator is genuinely stuck.

## The routing rule

Route by **which invariants the task touches, not by how large it looks**. On a
financial application the expensive mistakes are small: a lock taken in the wrong
order, a rounding path, a migration that is not idempotent, a matching rule that
silently links the wrong record.

Anything touching money arithmetic, authorization, schema migrations, lock
ordering, audit history, or external financial input goes to the deep tier even
when the change is a few lines. Everything fenced by existing tests and free of
those concerns can go to the routine tier.

A worked example from this repository: a task described as "let the owner delete a
receipt" looked like a small screen-and-endpoint change. It turned out to require a
soft delete, because a cost-ledger foreign key made a hard delete corrupt the
monthly budget accounting, and it had to take an advisory lock in the same order as
the existing attachment path. Apparent size was a poor predictor; invariant
surface was the right one.

## Concrete assignment here

At the time of writing this project uses Anthropic's Claude models:

| Role                | Model            |
| ------------------- | ---------------- |
| Orchestrator        | Claude Opus 5    |
| Routine implementer | Claude Sonnet 5  |
| Deep implementer    | Claude Opus 5    |
| Escalation          | Claude Fable 5.1 |

Substitute equivalents from any provider: the pattern needs a capable orchestrator,
two implementer tiers separated by cost, and one escalation tier above both. The
orchestrator model is selected by the owner in the client; a session cannot change
its own model, which is why escalation has to be _requested out loud_ (below).

## Isolation

Concurrent implementers must never share a mutable checkout. Each gets its own
Git worktree on its own branch, with its own installed dependencies. Sharing a
working tree or a dependency directory between agents produces failures that look
like flaky tests and waste far more than the isolation costs.

Implementers do not commit, push, switch branches, or open pull requests. They
leave a diff; the orchestrator reviews it, integrates it and records it. Two
concurrent implementers is a practical ceiling on a single developer machine.

Implementers never receive credentials, production data, or real financial
records. Test fixtures use invented names.

## The brief contract

A subagent starts empty, so a brief must contain: the exact working directory and
branch; how to set up the toolchain; which files to read first and in what order;
the specification in enough detail that the acceptance criteria are unambiguous;
the invariants that apply; the tests to add; the exact verification commands; and
an instruction to report what it could not do. Briefs are long on purpose. A brief
that omits the invariants produces a diff that violates them.

Ask explicitly for what was _not_ done. A subagent that reports only successes is
the main source of silent defects.

## The verification contract

The orchestrator never accepts a subagent's report as evidence. It reads the diff.
The report says where to look; the diff says what happened.

Watch specifically for a changed or deleted existing test. That is the highest-risk
edit an implementer can make, and it is sometimes correct — a test can encode a
defect. Verify the claim against the original before accepting it. This happened
here: a test asserted that two receipts for one payment should both attach, which
was the very double-linking defect being fixed. The rewrite was right, and it was
only trustworthy because the original was checked.

Reading code is not verification. A claim is verified when a command was run and
its output supports the claim.

## Escalation triggers

The orchestrator says, in plain words and early, that escalation is needed when:

- two attempts fail with the same error — stop and re-diagnose instead of retrying;
- a decision needs an architectural record;
- a change spans more than about three modules;
- an ambiguity would change financial semantics;
- it is simply stuck.

Because a session cannot raise its own capability tier, this has to be surfaced to
the human rather than handled silently. Name the trigger and say what the
escalation model would be asked to do.

## What never varies by tier

Every diff is reviewed by the orchestrator. Every change runs the full repository
check. Every pull request needs green continuous integration before merge.
Documentation, the open-work list and the status record are updated in the same
change, distinguishing implemented, tested and deployed. Deployment and any
production data change require explicit human approval regardless of how confident
any model is.

Using cheaper models for routine work raises the value of these gates. It does not
lower the standard they enforce.

## Token economy

Context spent is context unavailable for judgment later. Two rules follow.

Keep always-loaded documents bounded. An agent instruction file that every session
and every subagent reads should stay small and dense; append-only records belong in
an archive, so this project keeps `docs/STATUS.md` to a current-state section plus
recent entries via `scripts/archive_status.py`.

Prefer deterministic tools over repeated reasoning. Anything a script, a test, a
type checker or a checked-in query can decide should not be re-derived by a model
each session. A diagnostic query belongs in the repository; an invariant belongs in
a test; a repeated comparison belongs in a script. Deterministic checks are
cheaper, repeatable, and they do not drift between sessions.
