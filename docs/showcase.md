# The showcase workspace

The application is going into a public article, with screenshots and short
screencasts. The screens have to be shown without the household's own money in
them, and the pictures are permanent: a screenshot can be zoomed and kept, a
screencast is not reviewed frame by frame, and neither can be taken back.

So the demo workspace holds a household that does not exist. Nothing in it is
derived from the real one, which means no screenshot can leak a figure — there
is no real figure anywhere in it to leak.

## Why not hide the real figures instead

Masking amounts behind stars, or scaling them by a constant, was the cheaper
idea and was rejected:

- **An article of blanked-out numbers shows nothing worth looking at.** A bar
  chart with dotted axes and a category breakdown of `•••` do not demonstrate
  an application; they demonstrate that it has something to hide.
- **Masking fails silently.** A figure that escaped the formatter looks exactly
  like one that did not.
- **Removing things breaks the sums.** Several holdings are not wanted in the
  article at all. Delete them from real data and the parts no longer add up to
  the whole, which is precisely what a careful reader notices. Generated data
  has no such problem: what is not created was never in the total.

## What is real and what is invented

| | |
| --- | --- |
| **Real** — discloses nothing, tedious to fake | the category tree, the bank names, currencies, dates, counts, exchange rates, the interface |
| **Invented** — every one | amounts, merchants, descriptions, both members, holdings and their contents |

The banks stay real deliberately. This repository is public and already names
every integration it has, so "Monobank", "Wise", "Revolut", "Swedbank", "LHV",
"Binance" and "Interactive Brokers" appearing in a screenshot disclose nothing
that is not already published. What those accounts *hold* is invented.

The two members are **Alex** and **Sam**. Only the label changes: every payment
is still owned by `rodion` or `katya` underneath, because that identity is what
the ledger, the audit history and the bank connections are keyed by. The names
come from one map on each side — `OWNER_NAMES` in `src/account-names.ts` and
`owners` in `frontend/src/lib/account-visuals.ts` — and the server states them
in the bootstrap payload so both sides agree.

## Using it

```sh
pnpm demo:seed     # wipe and refill the demo workspace
pnpm demo          # the application, on http://127.0.0.1:3300
pnpm shots         # screenshots, desktop and phone, light and dark
```

The household is generated from a fixed seed, so reseeding produces the same
people with the same spending: a figure quoted in the article's text still
matches the picture beside it, and screenshots taken a month apart agree.

Dates are generated relative to the day it is seeded, so "this month" on the
Home screen is always the current one. **Reseed before taking screenshots** —
that is the only thing that keeps the workspace from slowly emptying out as
time passes. There is no timer, because it is only wanted before a photograph.

## It cannot reach the household's own data

Four independent things have to be true at once, and each is enough on its own:

1. **Demo mode never opens `DATABASE_URL`.** One branch in `src/main.ts`
   chooses the database, and demo mode takes the PGlite side of it.
2. **The seeder refuses any database that is not a local PGlite one.** It
   empties the ledger before it writes, so it asks `isMemoryDatabase` — which
   answers from how the database was constructed, not from an environment
   variable that could be wrong.
3. **The script refuses to start** if `DATABASE_URL` is present in the
   environment at all, or if `APP_MODE` is anything but `demo`.
4. **Demo mode runs with no credentials.** Bank connections, Enable Banking
   consent, Telegram and the AI classifier are all gated on `APP_MODE=postgres`
   in `src/main.ts`, so a demo instance cannot call a bank, message anyone or
   spend AI budget. `test/demo.test.ts` holds that line.

## The rule for a demo instance on the server

A demo instance may be run on the server so that the installed app, the phone
layouts and the pull-to-refresh gesture can be photographed — a laptop cannot
show those, because a phone cannot reach `localhost` and a LAN address is not a
secure origin, so there is no service worker and no install.

**Its hostname must never be exposed beyond the tailnet.** Demo mode has no
login: it signs itself in, because there is nobody to authenticate and nothing
real behind it. On the tailnet that is only the household. Put it behind a
Tailscale funnel or any other public route and it is an open workspace that
anybody can browse and write to. Nothing in the application prevents this; the
rule is the whole protection.

It must also set `DEMO_DATA_DIR` to a directory of its own. The default is
`data/demo` under the working directory, which on the server is inside the
release — the database would be written into a release and lost at the next
switch.

## What the demo looks like

It looks like the application, deliberately: an article needs to show the thing
itself, not a sample of it. One quiet **Demo mode** label sits at the left of
the header. That is enough to keep a reader honest, and enough to stop the
owner mistaking it for the real workspace now that the two look alike.
