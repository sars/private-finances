# Private Finances

Family expense analytics for Rodion and Katya. Private repository:
https://github.com/sars/private-finances

## Working now

A private server application with a synthetic local demo: persistent imports, transaction list, owner
filter, exact per-currency expense totals, manual classification with audit history,
and a health/freshness page. No bank credentials are needed for this flow.

```sh
pnpm install --frozen-lockfile
pnpm check
pnpm demo
```

Open http://127.0.0.1:3300. Import the examples, refresh, and classify an outflow.

## Documentation

- [Spending, review and evidence workflows](docs/spending-workflows.md)
- [Receipt photos](docs/receipts.md)
- [Credential sources, storage and renewal](docs/credentials.md)
- [Telegram setup](docs/telegram-setup.md)
- [Development and tests](docs/development.md)
- [Application architecture and limitations](docs/adr/0002-synthetic-application.md)
- [Agent working agreement](AGENTS.md)
- [How agents work on this project](docs/agent-development-model.md)
- [Requirements](docs/requirements.md)
- [Bank integration decisions](docs/integrations.md)
- [Deployment contract](docs/operations.md)
- [What the production server needs](docs/server-requirements.md)
- [Monitoring contract](docs/observability.md)
- [Roadmap](docs/roadmap.md)

The original Ukrainian specification remains unchanged in the repository root.
New documentation and communication use English.

## Production status

Private Tailscale HTTPS deployment and live Wise/Revolut and Monobank pilots
are working. See docs/STATUS.md for account coverage and remaining issues.
Daily bank polling, Telegram workflows and bounded AI suggestions are enabled. Home and Analytics use daily commercial FX, explicit periods and separately marked historical estimates. Telegram receipt photos provide payment evidence. Correspondence exports are reserved for a separate one-time historical analysis. Unknown transfers and incomplete bank coverage remain visible. GitHub CI runs repository checks and application tests; its real
PostgreSQL service contains disposable synthetic data.

GitHub access uses HTTPS with the authenticated GitHub CLI. Branch protection is
not enforced for this private repository under the current plan. Use reviewed PRs
and successful CI before merge; this procedural rule is not server enforcement.
