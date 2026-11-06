# Развёртывание и эксплуатация

[Документация](README.md) · [Конфигурация](configuration.md) · [Чек-лист](validation.md)

## Production-запуск

Нужны Docker Compose v2 и HTTPS reverse proxy. Репозиторий содержит переносимый
`docker-compose.prod.yml`; локальные `deploy.py` и `deploy_site_tracker.py`
игнорируются Git и для запуска не нужны. Команды ниже выполняйте из корня
репозитория. Compose использует PostgreSQL 18 и том в `/var/lib/postgresql`.

```bash
cp .env.example .env.production
chmod 600 .env.production
# Заполните секреты, имя/ключ проекта и точные HTTPS origins своего сайта.
# Генерация секретов описана в быстром запуске README.
# COOKIE_SECURE/TRUST_PROXY_HEADERS в production Compose принудительно true.
docker build -t clickshield:YOUR_RELEASE .
```

Укажите `CLICKSHIELD_IMAGE=clickshield:YOUR_RELEASE` в `.env.production` и задайте
`BOOTSTRAP_ALLOWED_ORIGINS=https://example.com,https://www.example.com`.
Интеграции задаются для своего счётчика/пикселя; в шаблоне нет рабочих ID.

```bash
docker compose --env-file .env.production -f docker-compose.prod.yml config --quiet
docker compose --env-file .env.production -f docker-compose.prod.yml up -d
curl --fail http://127.0.0.1:18088/healthz
```

PostgreSQL не публикует порт. Приложение доступно на `127.0.0.1:18088`;
proxy на том же хосте направляет HTTPS-запросы на этот адрес. Production Compose
доверяет proxy-заголовкам: обязательно очищайте входящие `X-Forwarded-For`,
`X-Real-IP`, `CF-Connecting-IP`, `CF-ASN`, `CF-IPCountry`, `X-GeoIP-*` и передавайте
только значения, установленные доверенной инфраструктурой. Если proxy в отдельном
контейнере, настройте приватную Docker-сеть и адрес upstream соответствующим образом.

Ограничьте административный доступ по VPN/IP или через отдельный шлюз. Публичные
`/tracker.js`, `/assets/`, `/v1/events`, `/v1/session/finish`, `/v1/tracker/config`,
`/v1/replay`, `/l/` и `/p/` должны оставаться доступны нужным клиентам;
API и MCP имеют собственную авторизацию. Настройте лимиты тела и частоты запросов
с учётом replay. [Требования безопасности](../SECURITY.md).

Проверьте внешний `/healthz`, вход, получение трекера и реальный визит с разрешённого
origin. Docker-сборка загружает IP→ASN-базу и GeoLite2 City MMDB в
`/app/ip2asn.tsv.gz` и `/app/GeoLite2-City.mmdb`; Compose использует эти пути
по умолчанию. Отдельное монтирование для обычного запуска не требуется.
При сборке нужен доступ к Go-модулям, iptoasn.com и GitHub. Для обновления
встроенных баз пересоберите образ без кэша загрузки:

```bash
docker build --no-cache -t clickshield:YOUR_RELEASE .
```

Либо подключите свои файлы read-only через Compose override и задайте
`ASN_DATABASE` / `GEOIP_CITY_DATABASE`.
После обновления бинарника tracker и assets должны обновиться на сайте;
долгий proxy/CDN-кэш может задержать новую версию.

## Доступ для коллег

Главный администратор (`ADMIN_USERNAME`) открывает вкладку «Доступ», нажимает
«Создать ссылку» и сам пересылает её коллеге. Ссылка одноразовая, действует 7 дней
и показывается только сразу после создания. Коллега задаёт email и пароль
(от 12 символов) и дальше входит с ними на `/login`. Неиспользованную ссылку можно
отозвать. Пользователя можно отключить: это сразу завершает все его сессии.

Токен в `/invite/<token>` даёт доступ к регистрации. Приложение маскирует его
в HTTP-логе. В reverse proxy также исключите эти URL из access log
(например, `access_log off` для `/invite/`) или используйте формат с маскированием;
не записывайте исходный `$request`/`$request_uri` для приглашений.

## Обновление и откат

1. Сохраните текущий тег образа и резервные копии PostgreSQL и bucket replay.
2. Выполните `make check` с тестовой БД и `make build`; для UI пройдите затронутые сценарии.
3. Соберите новый образ с отдельным тегом, смените `CLICKSHIELD_IMAGE` и выполните `up -d`.
4. Compose выполняет отдельные migrate/bootstrap, затем запускает serve/worker. Для перехода со старой схемы сначала остановите app/worker и выполните [порядок миграции](architecture-refactor.md), включая перенос replay и backfill features. Проверьте логи, `/healthz`, вход, визиты и очереди.
5. При ошибке остановите обновление и оцените совместимость схемы со старым бинарником. Автоматических down-миграций нет; возврат образа не отменяет SQL-миграции. Для восстановления БД используйте проверенную копию.

Не запускайте одновременно разные версии при изменении схемы без проверки
совместимости. Не меняйте Compose project name или имя тома базы между обновлениями:
это создаст другой том и внешне будет выглядеть как потеря данных.

```bash
docker compose --env-file .env.production -f docker-compose.prod.yml logs --tail=100 app
docker compose --env-file .env.production -f docker-compose.prod.yml ps
```

Приложение пишет JSON-логи. Панель показывает задержавшиеся расчёты и ошибки
outbox; `/v1/operations` также показывает очередь аналитики, задержку самой
старой проекции в секундах, повторы проекций и ошибки удаления объектов.
`ALERT_WEBHOOK_URL` включает JSON-уведомления о проблемах. `SENT` в очереди
подтверждает HTTP-доставку, а не появление события в рекламном отчёте.

## Резервные копии

`scripts/backup.sh` использует custom-format `pg_dump`, проверяет каталог через
`pg_restore -l`, защищает файлы правами 600, исключает параллельный запуск и удаляет
копии старше 14 дней. Это проверка читаемости архива, а не пробное восстановление.
По умолчанию скрипт ожидает `/opt/clickshield/compose.yml` и `/opt/clickshield/.env`.
Для запуска из checkout укажите реальные пути:

```bash
CLICKSHIELD_APP_DIR="$PWD" \
CLICKSHIELD_COMPOSE_FILE=docker-compose.prod.yml \
CLICKSHIELD_ENV_FILE=.env.production \
  bash scripts/backup.sh
```

Шаблон systemd timer запускает backup ежедневно в 02:30 UTC. Для установки в
`/opt/clickshield` скопируйте туда `backup.sh`; в service задайте
`CLICKSHIELD_COMPOSE_FILE` и `CLICKSHIELD_ENV_FILE`, если файлы называются иначе.
Установите `scripts/clickshield-backup.service` и `.timer` в `/etc/systemd/system/`,
затем выполните `systemctl daemon-reload` и
`systemctl enable --now clickshield-backup.timer`.

`scripts/pull_backup.sh` копирует последнюю копию с `/opt/clickshield/backups` по SSH,
сверяет SHA-256 и хранит локальные копии 30 дней. Требуются SSH, rsync и sha256sum:

```bash
CLICKSHIELD_BACKUP_HOST=backup-user@example.com bash scripts/pull_backup.sh
```

Для пользовательского timer установите скрипт в
`~/.local/lib/clickshield/pull_backup.sh`, создайте закрытый
`~/.config/clickshield/backup.env` с `CLICKSHIELD_BACKUP_HOST` и при необходимости
`CLICKSHIELD_BACKUP_DIR`, скопируйте `clickshield-backup-pull.service`/`.timer` в
`~/.config/systemd/user/`. Включите через `systemctl --user daemon-reload` и
`systemctl --user enable --now clickshield-backup-pull.timer` (06:00 по местному времени).
Пользователь SSH должен иметь право читать архивы; настройте это отдельно.

Копии содержат пользовательские данные и зашифрованные секреты интеграций.
Шифруйте хранилище копий, ограничивайте доступ и храните `ENCRYPTION_KEY` отдельно.
Политика удаления данных из рабочей БД не удаляет их из старых архивов.

Replay хранится в отдельном bucket: `pg_dump` сохраняет только его метаданные.
Делайте согласованные копии БД и объектов, включите подходящую вашему S3 политику
резервного копирования. Не задавайте lifecycle короче срока replay: это создаёт
метаданные, указывающие на отсутствующие объекты. После восстановления не запускайте
worker с рабочим bucket: его GC удаляет объекты из сохранённой очереди. Сначала
восстановите bucket в отдельное хранилище и проверьте записи.

Для собственного MinIO добавьте `-f docker-compose.replay.yml` после production
Compose. Хранилище доступно только внутри Docker-сети, без опубликованных портов.
Задайте `REPLAY_S3_ENDPOINT=http://replay-storage:9000`, закрытый bucket и отдельные
случайные ключи `REPLAY_S3_ACCESS_KEY` / `REPLAY_S3_SECRET_KEY` в env-файле.
Сначала запустите `replay-storage`, затем выполните bootstrap для создания bucket.

Для MinIO в отдельном Docker volume `backup.sh` также сохраняет архив объектов,
если задан `CLICKSHIELD_REPLAY_VOLUME` с точным именем тома. Скрипт временно
останавливает работающий worker, делает dump, затем копирует том read-only через
`alpine:3.22` и запускает worker обратно, включая выход при ошибке. App продолжает
принимать визиты; GC в это время остановлен. Другие процессы не должны удалять
объекты. Пара `.dump` и `.replay.tar.gz` имеет одинаковую метку времени и права 600.
Для systemd задайте эту переменную через `Environment=` в override backup service.

## Пробное восстановление

Используйте отдельный PostgreSQL с пустой БД `clickshield_restore` и ролью
`clickshield`; никогда не направляйте этот пример в рабочую базу:

```bash
pg_restore --exit-on-error --no-owner --no-privileges \
  --dbname="$CLICKSHIELD_RESTORE_DATABASE_URL" /path/to/clickshield.dump
```

Проверьте таблицы, `schema_migrations`, количество данных и старт соответствующей
версии приложения с тем же `ENCRYPTION_KEY`. Изолируйте восстановленный сервис от
сайтов и исходящих интеграций: сохранённый outbox может повторно отправить события.

## Проверка установленного сервиса

```bash
python3 scripts/check_deployment.py \
  --base https://clickshield.example.com --env-file .env.production
```

Скрипт входит в панель, читает отчёты и проверяет запреты доступа. `--enable-replay`
меняет настройки проекта (включает запись 100% на 7 дней); применяйте этот флаг
только намеренно. Скрипт не устанавливает TLS, proxy или интеграции.
