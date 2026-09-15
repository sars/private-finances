# ADR 0001: Основа розробки перед продуктом

Дата: 2026-09-11. Статус: прийнято для foundation; runtime нижче — пропозиція.

## Рішення

Один приватний Git-репозиторій, main і короткі feature branches. PR містить
вимогу, diff і докази перевірок. Після створення GitHub remote налаштувати required
checks, заборону force-push/delete main та PR merge. Доступність rulesets для
приватного repo перевірити на фактичному GitHub плані; не заявляти захист активним
до перевірки. Для solo workflow не вимагати недоступного другого human reviewer.

Foundation CI не має production secrets, мережі банку чи доступу до VPS.
Залежності Actions закріплені SHA, оновлення — через Dependabot і review.
Checkout v4.2.2 — явно закріплена стартова версія, не твердження про найновішу.

## Пропонований runtime

TypeScript strict, Node LTS з точно зафіксованою версією, pnpm з lockfile;
web dashboard і worker в одному monorepo, PostgreSQL як джерело істини.
Модулі: domain, bank adapters, classification, Telegram, reporting, operations.
На першому етапі достатньо таблиці jobs з atomic claim / lease / heartbeat;
окремий Redis або Kubernetes не потрібний без виміряної потреби.
Python у foundation використовується лише для dependency-free repo check.

Точні runtime версії, ORM, UI бібліотеки та спосіб пакування зафіксувати окремим
ADR перед scaffold продукту після перевірки середовища VPS та API провайдера.
Shared VPS залишається цільовим, але з окремими DB role, service user,
directories, ports, secrets і resource limits.

## Чого не копіюємо з референсів

Reviews Analytics має корисні ADR, incident reports, run events і тести.
Його deploy.sh --check виконує rsync у runtime directory перед перевірками;
SN Researcher також збирається у робочій директорії сервера.
У новому застосунку збірка/тести ізольовані від активного релізу.
Огляд був локальним: стан і ресурси live VPS ще не перевірялися.

## Джерела

- https://docs.github.com/en/actions/reference/security/secure-use
- https://docs.github.com/en/actions/reference/workflows-and-actions/deployments-and-environments
- https://tailscale.com/docs/integrations/github/github-action
- https://github.com/actions/checkout/releases/tag/v4.2.2
