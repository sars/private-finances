# Deployment та відновлення

Статус: контракт для реалізації; жодної команди deployment тут ще не активовано.

## GitHub та CI/CD

Створити приватний remote у вказаному власником GitHub account/repo.
PR CI без secrets. Required check спочатку Foundation checks, потім повний app gate.
Production CD запускається для конкретного перевіреного commit через workflow_dispatch;
автоматичний rollout після merge додати після першої успішної rollback/restore вправи.
Один deployment одночасно; не скасовувати запущену міграцію новим workflow.

CI збирає артефакт із commit SHA, checksum/digest і manifest залежностей.
CD отримує саме цей артефакт, перевіряє checksum і SHA. Якщо потрібна збірка на VPS,
вона відбувається в окремій release directory, з exact commit і повними gates.
Тестування не змінює active release. Не встановлювати runner для PR-коду на production VPS.

Доступ із GitHub до VPS — Tailscale ephemeral identity, по можливості workload
identity federation; grants лише до deployment endpoint цього сервісу.
SSH host key перевіряється; deployment user не має загального passwordless sudo.
Production secrets залишаються на сервері, не потрапляють в artifact.

## Залежності сервера

Системні залежності (Node, PostgreSQL, python3, poppler-utils для PDF-чеків,
Tailscale), шляхи конфігурації, файли credentials і systemd-юніти описані в
[what the production server needs](server-requirements.md) із версіями, які
справді спостерігалися на сервері. Додаючи залежність поза деревом npm, фіксуйте
її там у тій самій зміні: lockfile не покриває системні пакети, і невідома
залежність виявиться лише під час перебудови хоста або невдалого release.

## Команда релізу

`bash deploy/release.sh <SHA>` виконує всю послідовність нижче однією командою:
archive з перевіркою digest, збірка і тести на сервері, репетиція міграції на
відновленій копії бази, пауза таймерів і worker, атомарне перемикання через
`switch-release.py`, відновлення таймерів і перевірка release/schema/кількості.
Кожен крок — gate; перша помилка зупиняє реліз і лишає попередній реліз активним.
Запуск із GitHub Actions (OPS-2) ще не налаштований: потрібні secrets, які може
додати лише власник.

## Послідовність rollout

1. Read-only inventory: OS/architecture, runtime, systemd, disk/RAM, occupied ports,
   Tailscale, backup destination, існуючі сервіси. Зберегти без секретів.
2. Виділити service user, DB/role, releases/shared directories і приватний endpoint.
3. Перевірити artifact, конфігурацію, доступну пам'ять/диск і migration compatibility.
4. Перед міграцією — backup з перевіркою можливості restore; jobs graceful drain.
5. Expand-compatible migration, потім атомарне перемикання current на release SHA.
6. Restart лише цього застосунку; readiness, DB compatibility, worker heartbeat,
   synthetic/read-only smoke з очікуваною release version.
7. Записати deployId, commit, artifact digest, actor, час, результат checks.
8. При помилці повернути попередній сумісний release; schema автоматично не downgrade.
   Якщо сумісність втрачена — stop writes і керований recovery plan з власником.

## Приватний доступ

Dashboard доступний лише через Tailscale; перевірити binding і ACL з дозволеного
та недозволеного клієнта. Додати явну identity/allowlist Родіона і Каті;
наявність у tailnet сама по собі не є дозволом на фінансові дані.
DB і внутрішні endpoints не мають публічного listener. Telegram long polling
дає змогу почати без public webhook.

## Backups та інциденти

Encrypted off-server backup is live since 19 September 2026 — restic to a private
Amazon S3 bucket, daily at 03:30 UTC, details in [backups](backups.md). Restore
was proved into a separate disposable database, not assumed, and recorded with
`/etc/private-finances/off-server-restore-verified`. Backup age and failure are
visible on System health and on the Home problem list; the recovery password is
the owner's and is held outside this server.

Retention is the one part still outstanding: `restic forget --prune` is not
scheduled, because pruning deletes. Запропоновані цілі для погодження: RPO 24h,
RTO 4h; не обіцяні SLA.

Інцидент: припинити шкідливі повтори → зберегти redacted evidence → відновити сервіс
→ regression test → короткий postmortem за шаблоном. Не «лікувати» баг нескінченним restart.

## Відомі відхилення від контракту

Станом на 13 вересня 2026 знайдено два відхилення. Обидва зафіксовані, а не
змінені мовчки. Deployment user `radar` має необмежений passwordless sudo,
всупереч вимозі вище. Додатково `sshd_config` містить `PermitRootLogin yes`,
тобто root-логін через SSH дозволений. Разом це означає, що доступ до ключа
`radar` фактично рівнозначний root на сервері.

Звуження sudo може вплинути на sync-таймери, Telegram-юніт і `switch-release.py`,
а зміна SSH-автентифікації на живому хості ризикує заблокувати доступ. Тому обидва
потребують узгодження з власником та іншим агентом, і перевірки кожного сервісу
після зміни. Не вважайте обмеження вище діючим, плануючи роботу на сервері.
Відстежується як OPS-4; актуальний стан див. у docs/STATUS.md.
