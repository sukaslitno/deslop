# Deslop landing

Статический лендинг Astro + TypeScript. Русская страница — `/`, английская — `/en/`. Исходные макеты, ограничения и архитектура описаны в [ТЗ](../docs/landing/README.md); экспортированные материалы лежат в `../docs/landing/references/`.

Опубликовано 19 сентября 2026: **https://deslop-landing.vercel.app**. Vercel team — `eugenes-projects-01ff4fd9` (Eugene’s projects), project — `deslop-landing`; последний проверенный deployment — `dpl_48V697JWeViDU2GgU6EcccE8xAtS`, Production / Ready. В production environment задан `SITE_URL=https://deslop-landing.vercel.app`: подключённые в Vercel алиасы `deslop.ru` / `www.deslop.ru` пока не прошли DNS-проверку. После отдельной настройки и проверки домена обновить `SITE_URL` и пересобрать сайт; DNS в рамках этой задачи не менялся.

## Локальная работа

Использовать pnpm из `packageManager` и совместимый Node из `engines`.

```sh
pnpm install --frozen-lockfile
pnpm dev
```

Dev: `http://127.0.0.1:4321`. Это отдельный сайт, не Tauri-приложение. Не запускать второй процесс на занятом порту; desktop-app на 1420 не останавливать.

## Проверки

```sh
pnpm test:content
pnpm typecheck
pnpm build
```

Браузерные тесты подключаются к уже работающему серверу. Для стабильного прогона собранной версии:

```sh
pnpm exec astro preview --host 127.0.0.1 --port 4322
```

В другом терминале:

```sh
LANDING_URL=http://127.0.0.1:4322 pnpm test:ui
```

Playwright Chromium должен быть установлен (`pnpm exec playwright install chromium`). Тесты проверяют RU/EN, 23 ширины, клавиатуру, отсутствие JS/IntersectionObserver, reduced motion, ресурсы и сохраняют снимки в `../docs/landing/qa/`. Команды не открывают внешние ссылки и не скачивают установщики. Прогон Chromium сам по себе не подтверждает Safari/Firefox или полевой INP.

## Контент и дизайн

- Тексты: `src/content/ru.ts`, `src/content/en.ts`.
- Подтверждённые внешние ссылки: `src/config/site.ts`.
- Резерв модели будущих установщиков: `src/config/releases.ts`; сейчас список пуст, `LandingPage.astro` показывает сообщение о недоступных сборках. После получения URL добавить реальные сборки и их ссылки в download-панель, проверить платформу и архитектуру.
- Пользователь разрешил выпустить страницу без донат-ссылки, ссылки автора и установщиков. Состояния недоступности намеренные, не ошибки.
- Стили: `src/styles/base.css`, затем `responsive.css`. Палитра и шрифты связаны с дизайн-системой приложения; описание происхождения — `src/design-system/README.md`.
- Свечение использует три исходных SVG и keyframes приложения. Не заменять их новым эффектом.
- `prebuild` синхронизирует токены из `../app/src/design-system/tokens.css`. При автономном deploy без `app/` используется сохранённый снимок с проверкой SHA-256. Не редактировать generated-файлы вручную.

## Vercel

До привязки проекта и любой публикации пользователь должен подтвердить account/team и целевой проект — это его прямое требование. После подтверждения публиковать только эту папку: Astro, install `pnpm install --frozen-lockfile`, build `pnpm build`, output `dist`. При CLI deploy из `landing/` Root Directory не должен повторно добавлять `landing/`.

`SITE_URL` задаёт production origin; в Vercel используется также `VERCEL_PROJECT_PRODUCTION_URL`. Preview и локальная сборка без origin получают noindex. После production проверить canonical, hreflang, robots, sitemap, обе локали и фактический публичный URL. `.vercelignore` исключает локальные зависимости, test artifacts и `.env`. `.vercel/` не коммитить. DNS и домены без отдельного запроса не менять.

Production URL и итоговые проверки фиксируются в `../docs/landing/qa/FINAL_REPORT.md` после фактической публикации; локальный build не является успешным деплоем.
