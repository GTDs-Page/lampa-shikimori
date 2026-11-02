# Relay для QR-входа на Supabase (бесплатно, без карты)

Relay — это Supabase Edge Function + таблица сессий в Postgres. `client_secret` Shikimori хранится в Supabase Secrets; в плагине и GitHub его нет.

## 1. Проект Supabase

1. Зарегистрируйтесь на `https://supabase.com` (Free plan, карта не нужна).
2. Создайте проект, регион — ближайший к РФ из доступных (например, `eu-central-1`).
3. Запишите **Project Ref** — он в URL проекта: `https://supabase.com/dashboard/project/<ref>`.

Free-проект засыпает после 7 дней без запросов. Для relay это лечится бесплатным пингом `/health` раз в 5–10 минут (UptimeRobot, cron-job.org) — см. раздел 6.

## 2. Supabase CLI

```bash
npm install -g supabase
supabase login
```

В папке `lampa-shikimori/` (там, где лежит `supabase/`):

```bash
supabase link --project-ref <ref>
supabase db push
```

`db push` применит `supabase/migrations/20261102000000_shikimori_auth.sql`: таблицу `shikimori_sessions` и атомарную функцию выдачи токена.

## 3. Секреты

```bash
supabase secrets set \
  CLIENT_ID='p8XY...' \
  CLIENT_SECRET='...' \
  SHIKI_BASE='https://shikimori.io'
```

`CLIENT_ID`/`CLIENT_SECRET` — от OAuth-приложения Shikimori. `SUPABASE_URL` и `SUPABASE_SERVICE_ROLE_KEY` Edge Function получает автоматически.

Если страницы результата лежат не в этом репозитории GitHub Pages, укажите их базу:

```bash
supabase secrets set RESULT_BASE='https://<you>.github.io/lampa-shikimori'
```

`RESULT_BASE` — необязательный; по умолчанию `https://gtds-page.github.io/lampa-shikimori`. Телефон после входа редиректится на `success.html` / `error.html` из этой папки: Supabase отдаёт собственный HTML как `text/plain`, поэтому страницы результата должны быть статическими.

Если позже сделаете свой домен, добавьте:

```bash
supabase secrets set PUBLIC_BASE='https://auth.example.com'
```

## 4. Деплой функции

```bash
supabase functions deploy shikimori-auth --no-verify-jwt
```

`--no-verify-jwt` обязателен: функцию вызывают телефон и телевизор без Supabase-аккаунта. Доступ защищён `sid`/`key` сессии.

URL функции:

```
https://<ref>.supabase.co/functions/v1/shikimori-auth
```

Проверка:

```bash
curl 'https://<ref>.supabase.co/functions/v1/shikimori-auth?action=health'
# {"ok":true,"configured":true}
curl 'https://<ref>.supabase.co/functions/v1/shikimori-auth?action=new'
```

## 5. OAuth-приложение Shikimori

В настройках приложения (`https://shikimori.io/oauth/applications`) укажите **Redirect URI** ровно:

```
https://<ref>.supabase.co/functions/v1/shikimori-auth
```

Без слэша и без query-параметров. Телефон после подтверждения вернётся на эту же функцию с `?code=...&state=...`, и она обменяет код на токен.

## 6. Чтобы проект не засыпал

Бесплатный Supabase-проект паузится после 7 дней без запросов. Бесплатный внешний монитор:

- UptimeRobot / cron-job.org → HTTP(S) monitor:
  ```
  https://<ref>.supabase.co/functions/v1/shikimori-auth?action=health
  ```
- интервал 5–10 минут.

Пинг идёт с их серверов, к РФ это не относится; сам Supabase я проверил — `supabase.co` с российского провайдера открывается.

## 7. Лимиты Free

- Edge Functions: 500 000 вызовов/мес;
- Postgres: 500 МБ;
- 2 бесплатных проекта.

Один вход по QR — ~150 опросов `?action=status` + несколько вызовов, то есть free-плана хватает на тысячи входов в месяц. При превышении Supabase не выставляет счёт, а ограничивает/паузит проект; карты нет — списаний быть не может.

## 8. Безопасность

- RLS включён, политик нет: `anon`/`authenticated` не видят таблицу.
- Токен отдаётся один раз: `consume_shikimori_session` удаляет сессию при выдаче.
- `sid`/`key` — случайные 24 байта; `/status` — POST, чтобы не попадали в query-логи.
- `/new` ограничен 10 запросами в минуту с IP.
- `client_secret` — только в Supabase Secrets; не коммитить.
