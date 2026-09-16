# Банківські інтеграції

Рішення власника, 2026-09-11. Репозиторій: https://github.com/sars/private-finances.

| Власник | Джерело | Інтеграція |
| --- | --- | --- |
| Rodion | Wise, Revolut, Swedbank | Enable Banking |
| Katya | Wise | Enable Banking |
| Rodion | Monobank | Прямий Monobank personal API, окремий token |
| Katya | Monobank | Прямий Monobank personal API, окремий token |

## Enable Banking

Backend підписує JWT приватним RSA-ключем застосунку. Потрібні application ID,
PEM і підтвердження середовища SANDBOX/PRODUCTION. Це авторизація застосунку;
доступ до рахунків окремо залежить від consent/session користувача.
Flow: /aspsps → POST /auth → callback code → POST /sessions → accounts/transactions.
Отримані session/account identifiers треба зберегти; частина account information
повертається тільки при створенні сесії. Реалізувати перевірку state і прив'язку owner.
Пройти всі сторінки continuation_key; не обмежуватися першим рахунком.

Наявний PEM не перевіряли. Не відомі environment, application status, bank countries,
whitelisted redirect URI, чинні sessions та coverage рахунків обох власників.
Попередня авторизація в кабінеті не є доказом робочої session для нашого застосунку.
До live pilot потрібна перевірка цих даних. Private callback через Tailscale перевірити
на фактичному redirect flow; не відкривати весь dashboard у public network.

Джерела (перевірено 2026-09-11):

- https://enablebanking.com/docs/api/quick-start/
- https://enablebanking.com/docs/api/reference/
- https://github.com/enablebanking/enablebanking-api-samples/blob/master/python_example/account_information.py

## Monobank напряму

Використовуємо X-Token власника. GET /personal/client-info повертає рахунки;
імпортуємо кожний потрібний account ID, а не тільки default account 0.
GET /personal/statement/{account}/{from}/{to}: Unix seconds, вікно не більше
2682000 секунд. Документований ліміт client-info і statement — раз на 60 секунд.
Початковий scheduler консервативно серіалізує запити кожного token; точний scope
ліміту уточнити перед оптимізацією. 429 не перетворювати на retry loop.
Для першої версії daily polling; webhook не потрібний для приватного deployment.
Зберігати source id, hold, amount, operationAmount і currency context для reconciliation.

Джерело (перевірено 2026-09-11): https://api.monobank.ua/docs/index.html

## Межі adapter contract

Обидва adapters повертають normalized transactions з provider/account/owner provenance,
точною сумою, currency, source ID, status і timestamps. Provider-specific відмінності
не приховуються вигаданими значеннями. Checkpoint лише після durable збереження batch.
Повторне завантаження і виправлення тестуються synthetic fixtures.

Секрети — лише server secret files; PEM через шлях поза Git. Жодних payment endpoints.
Поки credentials відсутні, продукт розробляється із synthetic adapter.
