---
name: frontend-screen
description: Build or change a screen in the Private Finances frontend — read the design system and component inventory, compose from them, then verify with screenshots and the frontend check.
---

# Building a screen

1. Read `frontend/DESIGN.md` (rules) and `frontend/src/components/finance/index.ts`
   (the vocabulary). Compose from those first, `components/ui/` second. Do not
   invent a component when one exists or takes a prop.
2. Need a primitive we lack? Discover it with the shadcn CLI, never by hand:
   `pnpm dlx shadcn@latest search @shadcn @reui @diceui -q "<term>"`, then
   `view` it, then `add` it. Never edit files under `components/ui/`.
3. Charts only through `components/charts/`; money only through `lib/format.ts`;
   dates only through `PeriodPicker`.
4. Design at 390 px first, then 1280 px. Tables are card rows under 640 px;
   detail views are a drawer on the phone.
5. When the screen is done — not after every edit — run `pnpm demo` in one shell
   and `pnpm shots /route` in another, then look at the phone and desktop PNGs
   in `.shots/`. Add `SHOTS_DARK=1` only when tokens changed.
6. `pnpm check` must pass; it runs `scripts/check_frontend.py`, which enforces
   the design rules and the entry-chunk budget.
