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

The receipt pictures are already committed under `showcase/receipts/`. They
are till slips from shops nobody visited, rendered from the list in
`src/showcase-receipts.ts` so that the total printed on a slip is the amount
on the payment it belongs to — the one disagreement a reader would notice.
`pnpm demo:receipts` redraws them with Playwright if that list changes.

They are committed rather than drawn at seeding time because the server has no
Playwright. A workspace seeded without them skips the receipts and says so, so
the seeder never depends on a browser being present.

The workspace can also be refilled from the running application, at
`/showcase/reseed`. It is a page of its own rather than a button in the
interface, because a Refill button would appear in the article.

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

## Bringing the demo instance up on the server

These are yours to run: they need the server, the tailnet and root. The unit
file is `deploy/private-finances-showcase.service`.

1. **Check the port is free.** The real application holds 3300; the showcase
   wants 3301.

   ```sh
   ssh radar "sudo ss -lntp | grep -E ':(3300|3301)'"
   ```

   Only 3300 should answer. If something else already holds 3301, pick another
   port and change `PORT` in the unit before installing it.

2. **Write the origin file.** It carries the tailnet hostname the showcase will
   be served on, and nothing else — no database URL, no credential.

   Read the hostname rather than typing it, and keep it in a variable so the
   placeholder cannot survive into the file:

   ```sh
   ssh radar "sudo install -m 0640 -o root -g private-finances /dev/null /etc/private-finances/showcase.env"
   host=$(ssh radar "sudo tailscale status --json" | sed -n 's/.*"DNSName": "\([^"]*\)\.".*/\1/p' | head -1)
   echo "$host"   # sanity: a *.ts.net name, not empty and not a placeholder
   ssh radar "echo 'PUBLIC_ORIGIN=https://$host:10000' | sudo tee /etc/private-finances/showcase.env"
   ```

   Then assert the file says what it must. A wrong origin starts the service
   and refuses every request with `invalid_host`, which is a confusing way to
   find out.

   ```sh
   ssh radar "sudo grep -cE '^PUBLIC_ORIGIN=https://[a-z0-9.-]+\.ts\.net:10000\$' /etc/private-finances/showcase.env"
   ```

   It must print `1`. The check is written as a positive assertion, and with
   `sudo`, for a reason worth keeping: the file is `0640 root:private-finances`,
   so a plain `grep` cannot read it, and a check phrased as "no placeholder
   found" would take the failure branch and report success precisely when it
   could not see the file at all. Assert what must be true, never the absence
   of what must not.

3. **Install and start the unit.**

   ```sh
   scp deploy/private-finances-showcase.service radar:/tmp/
   ssh radar "sudo mv /tmp/private-finances-showcase.service /etc/systemd/system/ && sudo systemctl daemon-reload && sudo systemctl enable --now private-finances-showcase"
   ```

4. **Point Tailscale at it.** The application listens on loopback only, exactly
   as the real one does, so Tailscale terminates HTTPS in front of it. HTTPS is
   what makes the installable app possible, which is the whole reason the
   showcase runs on the server rather than on the laptop.

   ```sh
   ssh radar "sudo tailscale serve status"
   ssh radar "sudo tailscale serve --bg --https 10000 http://127.0.0.1:3301"
   ```

   **Read the status first, and give the showcase a port nothing else holds.**
   The real application is already served on **8443**, and pointing a second
   backend at a port already in the serve configuration would send the
   household's own URL to the demo. A path prefix is not an option either: the application serves
   absolute routes (`/api/…`, `/assets/…`), so it has to own the root of
   whatever origin it is on. `https://<host>:10000` is still a secure origin, so
   the installable app works.

   **Never `tailscale funnel`.** Funnel puts it on the public internet, and the
   showcase has no login.

   The origin file in step 2 must match this exactly, port included:
   `PUBLIC_ORIGIN=https://<showcase-hostname>:10000`. The application compares
   the `Host` header against it and refuses anything else.

5. **Fill it.**

   **Stop the service first.** PGlite allows one process per data directory,
   and the running service is holding it: seeding underneath it would write
   into a database somebody else has open. The seeder takes a few minutes, and
   it runs outside the service's cgroup so `MemoryMax` does not apply to it.

   ```sh
   ssh radar "sudo systemctl stop private-finances-showcase"
   ssh radar "cd /opt/private-finances/current && sudo -u private-finances env DEMO_DATA_DIR=/var/lib/private-finances-showcase/demo /usr/bin/node scripts/seed-showcase.mjs"
   ssh radar "sudo systemctl start private-finances-showcase"
   ```

   `env` is not decoration: `sudo` clears the environment, so
   `sudo -u private-finances DEMO_DATA_DIR=… node …` would seed the default
   directory inside the release instead of the one the service reads.

   Re-run both before a session of screenshots: the dates are generated
   relative to the day it is seeded.

6. **Check it.** Open the hostname on your phone, install it, and confirm the
   header says **Demo mode** and the people are Alex and Sam. If it says
   anything else, stop and do not photograph it.
