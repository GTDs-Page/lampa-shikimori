# GitHub Pages

Здесь лежит статическая часть для GitHub Pages: плагин, иконка и страница установки. Relay — отдельно, на Supabase.

## Сборка

Из корня `lampa-shikimori/`:

```bash
PAGES_BASE='https://<username>.github.io/lampa-shikimori' \
RELAY_BASE='https://<ref>.supabase.co/functions/v1/shikimori-auth' \
node build-pages.js
```

Windows PowerShell:

```powershell
$env:PAGES_BASE='https://<username>.github.io/lampa-shikimori'
$env:RELAY_BASE='https://<ref>.supabase.co/functions/v1/shikimori-auth'
node build-pages.js
```

Скрипт создаст `shikimori.js`, `plugin.json`, `icon.png`, `index.html`, `.nojekyll`.

## Публикация

1. Создайте публичный репозиторий, например `lampa-shikimori`.
2. Загрузите **содержимое папки `pages/`** в корень репозитория (ветка `main`).
3. Settings → Pages → Build and deployment → **Deploy from a branch** → `main` / `/ (root)`.
4. Через минуту плагин будет доступен:

```
https://<username>.github.io/lampa-shikimori/shikimori.js
```

5. В Lampa: Настройки → Расширения → Добавить плагин → этот URL.

## Обновление

После изменений в плагине:

```bash
node build.js
node build-pages.js   # с теми же PAGES_BASE/RELAY_BASE
```

и закоммитить обновлённые файлы в репозиторий. Lampa скачивает плагин при запуске; кэш обновится сам.

## Важно

- В репозитории **нет** `client_secret` и других секретов.
- Supabase-ключи и OAuth-секрет живут только в Supabase Secrets.
- GitHub Pages — только статика; OAuth callback принимает Supabase Edge Function.
