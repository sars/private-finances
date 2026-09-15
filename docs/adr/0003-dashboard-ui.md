# Dashboard interface

Status: deployed in release 035edf0.

Use React with official shadcn/ui components (Radix primitives), Tailwind CSS,
Recharts and Lucide, as selected by the owner. Component source is committed
for review and customization; runtime/build dependencies are pinned. Vite builds
static assets served by the existing authenticated Node application. No extra
frontend server, CDN, external fonts or new public endpoint is required.

Move routes into the React shell only as their replacements become functional.
Overview and all secondary screens now use the React shell. Server-rendered
fallbacks remain available when the frontend build is absent. All write actions still
use existing owner authorization, revision checks and CSRF protection.

Overview reads transactions and exact per-currency totals from a single response.
No currencies are silently added together. Chart values may be floating point for
plotting only; money labels and category aggregation use integer minor units.
Pending and unresolved items remain distinct from confirmed personal spending.
Date filters retain the existing explicit UTC contract; report calendars are Riga.

System color mode is the default and follows changes; local preference can choose
light/dark. Mobile filters collapse to keep the overview readable. Navigation uses
real links so the existing pages and browser history remain usable.

No Tremor or TanStack Table: neither adds necessary capability to this increment.
