# Как формализовать git-сабмодули (одноразово)

Сейчас `shared/`, `server/`, `client/` — **самостоятельные локальные git-репозитории**
внутри суперпроекта `asoptimus/`. `.gitmodules` уже описывает целевые remote-URL. Чтобы
превратить их в настоящие git-сабмодули против GitHub, нужны remotes (у меня нет `gh` и права
создавать репозитории от твоего имени — это делаешь ты).

## Шаг 1 — создать 3 репозитория на GitHub

Под аккаунтом `enkunove` (в браузере или `gh repo create`):
- `asoptimus-shared`  (можно public — это только контракт)
- `asoptimus-server`  (**PRIVATE** — здесь весь moat: формулы, expander, промпты, биллинг)
- `asoptimus-client`  (можно позже сделать public/аудируемым — тонкий клиент)
- `asoptimus-landing` — уже есть локально в `/Users/enkunove/asoptimus-landing`, создай для него remote.

## Шаг 2 — запушить каждый модуль в свой remote

```sh
for m in shared server client; do
  cd /Users/enkunove/asoptimus/$m
  git remote add origin https://github.com/enkunove/asoptimus-$m.git
  git push -u origin main
done
cd /Users/enkunove/asoptimus-landing
git remote add origin https://github.com/enkunove/asoptimus-landing.git && git push -u origin main
```

## Шаг 3 — превратить суперпроект в реальные сабмодули

Из чистого клона суперпроекта (проще всего пере-собрать связи заново):
```sh
cd /Users/enkunove/asoptimus
git init && git add BUILD-PLAN.md ARCHITECTURE.md PRODUCT.md LANDING-ADDITIONS.md SETUP-SUBMODULES.md .gitmodules infra
# зарегистрировать директории как сабмодули (каждая уже запушена в свой origin):
git submodule add https://github.com/enkunove/asoptimus-shared.git  shared
git submodule add https://github.com/enkunove/asoptimus-server.git  server
git submodule add https://github.com/enkunove/asoptimus-client.git  client
git submodule add https://github.com/enkunove/asoptimus-landing.git landing
git commit -m "asoptimus superproject + 4 submodules"
```
Клонирование целиком: `git clone --recurse-submodules <super-url>`.

## Шаг 4 — `shared` как вложенный сабмодуль в server и client (для независимого клона)

Пока разработка идёт из суперпроекта, `server` и `client` тянут контракт через tsconfig-alias
`@aso/shared → ../shared/src` (уже настроено, работает без remotes). Чтобы `server`/`client`
клонировались и собирались **самостоятельно** (вне суперпроекта), добавь `shared` вложенным
сабмодулем в каждый и переключи alias на `./shared/src`:
```sh
cd /Users/enkunove/asoptimus/server
git submodule add https://github.com/enkunove/asoptimus-shared.git shared
# tsconfig.json: "@aso/shared" → "./shared/src/index.ts"
git commit -am "nest shared submodule"
# то же для client/
```
Бамп контракта после этого: `git -C shared pull` в каждом + коммит гитлинка. Держи `shared`
тонким — тогда бампы редки.

## Пока remotes нет
Всё собирается и разрабатывается из суперпроекта как есть (alias `@aso/shared → ../shared/src`).
Формализация выше нужна для CI/деплоя и раздельного клонирования, не для локальной работы.
