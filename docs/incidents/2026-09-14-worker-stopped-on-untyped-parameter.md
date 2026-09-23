# 2026-09-14: the worker stopped on an untyped parameter

Статус / severity / affected release: closed / medium / cd79b73.
Вплив на дані та користувачів: дані не змінені й не втрачені. Worker
(`private-finances-telegram.service`) впав через ~8 хвилин після релізу і не
перезапускався ~45 хвилин: не працювали автоматичне зіставлення refund-ів,
обробка чеків, Telegram-питання і triage. Dashboard лишався активним.
Початок, detection, recovery (UTC): падіння 13:00:17; виявлено під час перевірки,
чому зупинився перегляд рішень (лічильник завмер на 241); виправлено релізом із
явним приведенням типу та захистом циклу.
Докази: `{"event":"telegram_runtime_stopped","code":"configuration_or_poll_error"}`,
`systemctl` показав `failed`, `refund_match_reviews` перестала оновлюватись.

Причина і чинники: `reviewSettledLinks()` виконував
`CASE WHEN $5 THEN ...` з булевим параметром без приведення. PGlite, на якому
працюють тести, приводить такий параметр сам; PostgreSQL відхиляє його як text.
Шлях спрацьовував лише тоді, коли існував provisional-зв'язок, тобто після того,
як з'явилися перші зв'язки з hold — уже на сервері. Помилка піднімалась із циклу
worker-а і завершувала весь процес, а не лише цей прохід.

Відновлення та перевірка цілісності: `$5::boolean`; прохід refund-ів обгорнуто
try/catch, який пише `refund_pass_failed` і продовжує цикл, щоб зіставлення не
зупиняло Telegram, чеки і triage. Після релізу — сервіс active, лічильник рішень
знову рухається.

Regression test / PF-ID / PR: тест у `test/refund-automation.test.ts`, що виконує
прохід на справжньому PostgreSQL (`TEST_DATABASE_URL`, у CI — postgres:16).
Локально він пропускається; саме цього покриття бракувало.

Що змінити, відповідальний, статус: виконано. Ширший висновок — код, що
виконується лише на сервері, має мати PostgreSQL-тест: PGlite не є доказом
сумісності. Перезапуск worker-а після падіння: з 23 вересня 2026 `Restart=on-failure`
(див. `2026-09-23-worker-stopped-on-database-restart.md`).
