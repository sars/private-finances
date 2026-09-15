# Моніторинг, аудит і помилки

Статус: специфікація для реалізації, не працюючий dashboard.

## Логи та provenance

JSON logs: timestamp UTC, level, service, environment, releaseSha, event,
requestId/jobId/runId, internal transactionId за потреби, error.code,
durationMs, attempt. Створювати ID на вході й передавати через jobs і adapters.
Не логувати tokens, authorization headers, PEM, account numbers, повні descriptions,
Telegram replies чи raw bank responses. Error messages сторонніх API очищати.

Audit decisions окремо від технічних логів: transactionId, actor, час,
old/new classification, reason, ruleVersion, promptVersion/model (якщо LLM),
джерело підтвердження. Записи append-only; доступ обмежений. Банківські payloads
і повідомлення зберігаються лише у захищеному data store з погодженою retention.
Report snapshot має version, period, cutoff, FX source, unresolved count,
source watermarks: звіт можна пояснити після подальших виправлень даних.

## Екран /ops

| Показник | Що означає |
| --- | --- |
| Останній успішний sync по owner/account/provider | Повнота; «не підключено» відрізняється від «застаріло» |
| Queue depth / oldest job / heartbeat | Прогрес та зависання; запланована пауза окремо |
| Imported / corrected / duplicate / failed | Якість імпорту |
| Unresolved count та суми по валюті | Наскільки неповна аналітика |
| Consent expiry / auth errors / rate limits | Потрібна дія власника або пауза connector |
| LLM requests / cost / budget left | Вартість, поточний cap, невдалі виклики |
| Last report / delivery state | Створення звіту окремо від доставки |
| Release / last deploy / backup age / restore date | Стан експлуатації |
| DB / disk / memory | Стан інфраструктури |

Liveness відповідає лише чи живий процес; readiness — чи може виконувати роботу;
freshness — чи дані актуальні. Зелений HTTP status не доказ свіжих даних.

## Сповіщення та recovery

Dedup за incident key; cooldown і повідомлення recovery. Notify на auth failure,
пропущений sync SLA, stuck job, backup failure, low disk, перевищення error/budget threshold.
Пороги визначити з baseline до live launch; не розсилати кожну log line.
Технічні alerts пропонується надсилати Родіону окремо від сімейних уточнень.
Без Telegram помилки залишаються в DB/dashboard; відсутній bot token не блокує dev.
Notification outbox має durable delivery state; невизначений результат send
позначається для reconciliation, не обіцяємо exactly-once зовнішньої доставки.
