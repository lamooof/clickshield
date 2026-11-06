# ClickShield

Сервис анализа рекламного трафика, выявления ботов и продуктовой аналитики.
Go API принимает события браузерного трекера, хранит данные в PostgreSQL,
рассчитывает риск с объяснением причин и показывает визиты в защищённой панели.

[Документация](docs/README.md) · [Разработка](docs/development.md) ·
[HTTP API](docs/openapi.yaml) · [Безопасность](SECURITY.md) · [MIT](LICENSE)

## Возможности

- Отдельные проекты с публичными ключами, списками разрешённых origins и настройками scoring.
- Классификации `HUMAN`, `SUSPICIOUS`, `BOT`, `KNOWN_BOT`, ручная разметка и контроль качества заявок.
- Каталог краулеров, проверка опубликованных IP-диапазонов, определение ASN и сетей хостинга.
- Источники, кампании, UTM, страницы, устройства, география, отчёты и CSV.
- Бизнес-события, цели, воронки, маршруты, карты кликов/прокрутки и удержание.
- Запись сессий на rrweb с маскированием полей и исключением приватных блоков; по умолчанию выключена.
- Отправка `antifraud_bot` / `antifraud_human` в Яндекс Метрику, GA4 и VK Рекламу через очередь доставки.
- Чтение отчётов Метрики, короткие ссылки, пиксели, отметки на графике.
- API-токены с правами на проект или все проекты, [JS/TypeScript SDK](sdk/README.md) и [MCP-сервер](docs/mcp.md) для ИИ-агентов.

Новый проект работает в `MONITORING`. Перед включением других режимов проверьте
ложные срабатывания на размеченной выборке. Прямое управление ставками и
блокировками в Яндекс Директе/Google Ads не реализовано; запрет заявок требует
собственного серверного шлюза. [Режимы и правила](docs/scoring.md).

## Быстрый запуск

Нужны Docker Engine с Compose v2 и OpenSSL. Docker собирает Go-бинарник со
встроенным frontend; Node.js для этого запуска не требуется. Команды выполняйте
из корня репозитория. При сборке нужен доступ к Go-модулям, iptoasn.com и GitHub:
образ загружает базы IP→ASN и GeoLite2 City.

```bash
cp .env.example .env
openssl rand -hex 32     # отдельное значение для каждого пароля/токена
openssl rand -base64 32  # ENCRYPTION_KEY
```

В `.env` замените `POSTGRES_PASSWORD`, `ADMIN_PASSWORD`, `SESSION_SECRET`,
`BOOTSTRAP_PROJECT_KEY` и `OUTCOME_API_TOKEN`; заполните `ENCRYPTION_KEY`.
Пароль администратора — минимум 12 символов, `SESSION_SECRET` — минимум 32 байта.
Для пароля PostgreSQL используйте hex: Compose подставляет его в DSN без URL-кодирования.
Публичный ключ проекта можно создать как `pk_` + результат `openssl rand -hex 16`.
Пример уже разрешает `http://localhost:8081` для демонстрационного сайта.

```bash
docker compose config --quiet
docker compose up -d --build
curl --fail http://localhost:8080/healthz
```

Откройте `http://localhost:8080` и войдите с `ADMIN_USERNAME` / `ADMIN_PASSWORD`.
Сниппет для своего сайта скопируйте из раздела **Проекты**; задайте точные origins
сайта, включая протокол и порт.

Проверить трекер можно на примере (требуется Python 3):

```bash
python3 -m http.server 8081 --directory examples/demo-site
```

Откройте `http://localhost:8081/?key=ВАШ_BOOTSTRAP_PROJECT_KEY`, выполните несколько
действий и закройте вкладку. После `FINISH_GRACE` и затишья в панели появится
классификация. `make docker-down` останавливает сервисы и сохраняет том базы.

Для публичного запуска используйте HTTPS reverse proxy и отдельный production
файл окружения. [Развёртывание, обновление и резервные копии](docs/operations.md).

## Разработка и проверка

Нужны Go 1.26+ (версия модуля — в `go.mod`), Node.js 22+ для инструментов frontend
и PostgreSQL 18 для полного набора проверок, как в Compose и CI.
Dockerfile использует Go 1.27.

```bash
npm ci --ignore-scripts
make check
make build
```

Без `CLICKSHIELD_TEST_DATABASE_URL` тесты PostgreSQL пропускаются. Для полного
прогона задайте URL отдельной тестовой БД и выполните `make test-integration`.
[Пошаговые инструкции](docs/development.md). GitHub Actions выполняет проверки
с отдельными PostgreSQL и MinIO, сборку и проверку встроенных rrweb-бандлов.

## Устройство репозитория

```text
cmd/server/               CLI: serve, worker, migrate, bootstrap и backfill
internal/httpapi/         маршруты, авторизация и встроенный frontend
internal/feature/         агрегирование поведенческих признаков
internal/scoring/         правила и объяснения оценки риска
internal/bots/, asn/      каталоги ботов, IP-диапазоны и сети
internal/geo/, traffic/   геолокация и атрибуция трафика
internal/store/           PostgreSQL и SQL-миграции
internal/integration/     Метрика, GA4, VK Реклама
internal/antifraud/       сценарии ingest, scoring и ручной разметки
internal/analytics/       отчёты, проекции и собственная схема analytics
internal/replay/          метаданные replay, S3 и очередь удаления
internal/service/         фоновые задачи, доставка и мониторинг
sdk/                      клиент чтения аналитики
scripts/                  проверки, vendoring и резервные копии
docs/                     руководства и OpenAPI
examples/demo-site/       сайт для проверки трекера
```

Compose запускает отдельные migrate и bootstrap перед serve/worker. При прямом
запуске выполните их явно: `clickshield migrate`, `clickshield bootstrap`; затем
запустите `clickshield serve` и `clickshield worker` отдельными процессами.
HTTP не выполняет backfill и не запускает фоновые задачи. Отчёты читают проекции
в схеме `analytics` той же БД с небольшой задержкой. Replay требует отдельного
S3-совместимого хранилища и переменных `REPLAY_S3_*`.
[Порядок обновления старой установки](docs/architecture-refactor.md).

Очередь доставки использует PostgreSQL
transactional outbox; Redis не требуется. Бинарник содержит UI и rrweb,
загрузка библиотек с CDN при работе не нужна. Docker-сборка загружает базы
IP→ASN и GeoLite2 City в `/app/ip2asn.tsv.gz` и `/app/GeoLite2-City.mmdb`.
Compose уже задаёт эти пути; отдельное монтирование баз для обычного запуска
не требуется. Содержимое баз зависит от даты их загрузки при сборке.

Правила внесения изменений — в [CONTRIBUTING.md](CONTRIBUTING.md).
Об ограничениях записи и хранении данных — в [руководстве по приватности](docs/privacy.md).
