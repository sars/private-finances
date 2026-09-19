# Карта вимог → доказ результату

Джерело: ТЗ у корені. Implementation status and evidence are recorded below; acceptance criteria remain the target.
ID використовується в задачі, тесті/fixture і PR. Оновлювати статус лише з доказом.

| ID     | Вимога / секції ТЗ                                      | Критерій приймання та потрібний тест                                                                                                                                        |
| ------ | ------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| PF-001 | Власники, всі рахунки, 2–4                              | Два owners, кілька рахунків кожного; жодний не пропускається й не змішується                                                                                                |
| PF-002 | Щоденний імпорт, 3,5,21                                 | Повторне вікно та retry дають той самий набір; pagination, pending→booked і corrections не дублюють                                                                         |
| PF-003 | Реєстр власних рахунків, 4,6                            | Односторонній/двосторонній і валютний transfer не подвоює витрати; неоднозначний match unresolved                                                                           |
| PF-004 | Типи руху грошей, 6,20                                  | Personal expense включається; transfer/investment/non-personal/unresolved — окремо                                                                                          |
| PF-005 | Категорії та неоднозначність, 7–10                      | Однаковий merchant з різним контекстом не змушує однакову категорію; human override зберігається                                                                            |
| PF-006 | Telegram, 11                                            | Правильний owner + chat + user; reply зв'язаний з транзакцією; повторний update і чужа відповідь безпечні                                                                   |
| PF-007 | Навчання, 9,11.2                                        | Рішення має provenance/version; минула відповідь не створює глобального правила без підстав                                                                                 |
| PF-008 | Weekly/monthly, 12,13                                   | Попередній календарний період; неповнота видима; rerun не дублює доставку; correction версіонує звіт                                                                        |
| PF-009 | Валюти, 14                                              | Точні суми й historical FX з джерелом/датою; UAH default; без FX немає тихої підстановки                                                                                    |
| PF-010 | Dashboard, 15,16                                        | Фільтри owner/date/category/currency; сума drill-down дорівнює підсумку; доступ приватний                                                                                   |
| PF-011 | LLM, 18                                                 | Схема відповіді, невизначеність, budget, timeout; arithmetic поза LLM; деградація без API                                                                                   |
| PF-012 | Надійність, запит власника                              | Crash/resume без втрат; correlation IDs; fresh/stale відрізняються; restore у порожнє середовище                                                                            |
| PF-020 | Активи домогосподарства, запит власника (вересень 2026) | Snapshot на дату з точною оцінкою в одній валюті; carry-forward позначений; без ціни — окремо, не нуль; повторний імпорт історії нічого не змінює. Див. [assets](assets.md) |

## Запропоновані уточнення, не затверджені вимоги

До першого коректного розрахунку визначити income, refunds/chargebacks, fees,
split transactions (personal + studio), готівку, timezone і FX policy.
Нерозв'язані суми не можна показувати як нуль або як повністю завершену аналітику.
Реєстр рахунків потребує identifier, owner, provider, currency, account purpose;
не достатньо лише суми і дати для впевненого transfer matching.

## Implementation evidence (reviewed September 12, 2026)

[TODO](TODO.md) is the canonical remaining-work checklist. STATUS retains exact
release/test evidence; these summaries do not claim complete historical coverage.

| Requirement     | Current evidence                                                                                                                                                                     | Remaining acceptance gaps                                                                                                      |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------ |
| PF-001          | Both owners' direct Monobank, Rodion Wise/Revolut and Katya Wise connected; current account purposes configured                                                                      | Automatic defaults for newly discovered accounts; investigate specific coverage discrepancies                                  |
| PF-002          | Idempotence, settlement, pagination/replay tests; five bank timers with frequent polling and Enable Banking fallback                                                                 | Verify trial follow-up and provider failure/staleness behavior                                                                 |
| PF-003          | Own-account registry and conservative transfer matching                                                                                                                              | Stronger corroborated cross-account matching; fee/refund edge cases                                                            |
| PF-004          | Deterministic exclusions, audited manual decisions, full-refund hiding, basic cash purchases                                                                                         | Partial refunds, fees, mixed splits and cash-withdrawal reconciliation                                                         |
| PF-005 / PF-007 | Categories, confirmed rules, evidence-based suggestions/clear-expense automation; human overrides protected                                                                          | Scoped rule conditions/conflicts, shadow evaluation and historical reconciliation                                              |
| PF-006          | Paired owner/group checks, durable input history, verified live reply/proposal/confirmation; shared family receipts                                                                  | Observe retries/failures; receipt quality extensions                                                                           |
| PF-008          | Riga week/month boundaries, immutable reports and deduplicated delivery                                                                                                              | Resolve historical uncertainty and improve routine/exceptional annotations                                                     |
| PF-009          | Exact arithmetic; approved PrivatBank commercial historical midpoint; FX date correction and ingestion                                                                               | Actionable missing-date/currency coverage UI and ongoing coverage checks                                                       |
| PF-010          | Private responsive dashboard, Analytics, Router/Query foundation, Transactions/Receipts caches, full-page review and cash entry                                                      | Remaining screen cache migration, navigation/accessibility audit and settings follow-ups                                       |
| PF-011          | Validated proposals, reservations, shared $10 cap and visible usage; saved explanations before AI                                                                                    | Expanded quality evaluation within existing cap                                                                                |
| PF-012          | Guarded release/rollback, request IDs, bank isolation, credential reminders and full 36-table local restore comparison                                                               | Backend refactoring/measurement, encrypted S3 recovery, broader alerts and release failure drill                               |
| PF-021          | Each member signs in with an address and a password; thirty-day sessions in the database, sign-out, per-address and per-caller guessing delays ([authentication](authentication.md)) | Change password, sign-up, reset by email, Google sign-in and a second factor; the environment still sets each password at boot |

Passing synthetic tests does not prove live provider completeness. See
[STATUS](STATUS.md) for exact commits, CI and deployment evidence. Missing FX,
unresolved classifications and deferred off-server backup remain visible limitations.

## September 12 extension evidence (PR39)

- PF-004/005/007: historical estimates are separate deterministic projections; manual, refund, owner and source-revision isolation have regression tests. No global rules inferred from estimates.
- PF-006/011: authorized receipt photos share the existing AI budget; polling atomicity, conservative matching, source races and owner access tested. Real image quality remains to observe.
- PF-009/010: daily commercial conversion, global currency, selected periods, exact tentative breakdown sums, mobile layout and archived 2025 access verified.
- PF-012: schema 15, guarded release and 33-table recovery comparison verified.
- New receipt/evidence workflow is documented in [spending workflows](spending-workflows.md); remaining gaps stay in [roadmap](roadmap.md).
