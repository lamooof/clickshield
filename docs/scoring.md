# Режимы проекта и оценка риска

[Документация](README.md) · [Репозиторий](../README.md)

## Режимы проекта

| Режим | Отправка в Метрику/GA4/VK | Решение `BLOCK` |
|---|---|---|
| `MONITORING` (по умолчанию) | нет | нет |
| `NOTIFY` | да | нет |
| `BLOCKING` | да | `BOT` и `KNOWN_BOT` |
| `BLOCKING_BOTS` | да | только `BOT`; заявленные краулеры (`KNOWN_BOT`) пропускаются |

В блокирующих режимах API возвращает `BLOCK`, когда в том же проекте у того же visitor ID или непустого fingerprint уже была подтверждённая классификация из таблицы за последние 30 дней, иначе `ALLOW`. В `MONITORING` и `NOTIFY` решение всегда `MONITOR`. `KNOWN_BOT` определяется по User-Agent и опубликованным IP-диапазонам. Для краулеров из списка `verified` в `internal/bots/bots.go` проверяется соответствие IP оператору: чужой адрес получает отметку «Поддельный краулер» и проходит обычный scoring автоматизации. Для остальных заявленных краулеров проверка IP не выполняется; их имя по UA не доказывает подлинность.

Tracker ничего не ломает автоматически. Он публикует безопасное клиентское событие:

```js
window.addEventListener('antifraud:decision', (event) => {
  if (event.detail.decision === 'BLOCK') {
    // Не отправлять лид/конверсию, показать challenge либо вызвать ваш backend.
  }
});
```

Также доступно:

```js
window.ClickShield.getDecision();
document.documentElement.dataset.antifraudDecision;
```

Такой режим не заменяет серверную проверку критичных действий. Для формы заказа или лида рекомендуется передавать `ClickShield.sessionId` в собственный backend и проверять решение там после добавления отдельного first-party endpoint.

## Scoring

Настройки находятся в `projects.scoring_config` и редактируются в панели без изменения tracker.js.

Пример:

```json
{
  "thresholds": {
    "suspicious": 35,
    "bot": 70
  },
  "limits": {
    "sessions_per_ip": 20,
    "sessions_per_fingerprint": 8,
    "paid_visit_frequency": 4,
    "fast_first_click_ms": 180,
    "fast_click_interval_ms": 250,
    "high_interaction_density": 30,
    "high_mouse_velocity": 6000,
    "high_scroll_velocity": 5000
  },
  "weights": {
    "AUTOMATION_DETECTED": 70,
    "HEADLESS_SIGNALS": 30,
    "EXCESSIVE_IP_VELOCITY": 25,
    "EXCESSIVE_FINGERPRINT_VELOCITY": 32,
    "RAPID_UNENGAGED_PAGE_BURST": 75,
    "REPEATED_PAID_VISITS": 25,
    "FAST_FIRST_CLICK": 12,
    "ROBOTIC_CLICK_INTERVALS": 22,
    "HIGH_CLICK_RATE": 20,
    "NO_MOUSE_DESKTOP": 18,
    "ABNORMAL_MOUSE_PATTERN": 20,
    "EXTREME_MOUSE_VELOCITY": 15,
    "EXTREME_SCROLL_VELOCITY": 15,
    "LOW_ACTIVE_RATIO": 15,
    "HIGH_INTERACTION_DENSITY": 20,
    "MISSING_FINGERPRINT": 8,
    "DATACENTER_NETWORK": 18,
    "CLOUD_NO_INTERACTION": 55
  }
}
```

Гарантия первой версии: один слабый признак не переводит сессию в `BOT`, даже если администратор случайно задаст ему слишком большой вес. Отдельный путь — `KNOWN_BOT`: заявленный crawler с учётом доступной проверки IP получает оценку 100 и причину `KNOWN_CRAWLER`.

Каталог известных ботов (`internal/bots`) размечает каждую сессию именем бота, владельцем и категорией: поисковые системы, AI-краулеры, превью ссылок, SEO, реклама, мониторинг, RSS/архивы, сканеры. Незаявленные краулеры с `bot/`, `crawler`, `spider` или `+https://` в User-Agent получают имя из самого User-Agent. Headless-браузеры и HTTP-библиотеки размечаются категорией `automation`, но оцениваются правилами (`AUTOMATION_DETECTED`), а не как `KNOWN_BOT`. `GET /v1/bots` считает сессии по каждому боту, `bot` и `bot_category` фильтруют список сессий и CSV.

`RAPID_UNENGAGED_PAGE_BURST` применяется к сессии длительностью не более 5 секунд без кликов, прокрутки и движения мыши, если тот же visitor ID с того же IP открыл не менее 5 разных страниц в пределах 30 секунд до или после её начала. Это составной признак с оценкой 75, достаточной для `BOT` при стандартном пороге. `AUTOMATION_DETECTED` (webdriver/puppeteer в браузере или HeadlessChrome, python, curl и подобные клиенты в User-Agent) имеет вес 70 и тоже самостоятельно даёт `BOT`. `LOW_ACTIVE_RATIO` не применяется к сессиям длиннее 10 минут (фоновые вкладки), порог `high_mouse_velocity` по умолчанию 6000. Частота fingerprint даёт баллы только при совпадении у нескольких разных visitor ID, а высокая скорость мыши оценивается по 95-му процентилю при наличии не менее 40 движений.

`DATACENTER_NETWORK` (18) срабатывает для сетей облаков и хостингов (`internal/asn`). Только этот признак сессию в `BOT` не переводит: через VPN на арендованных серверах (Aeza, Timeweb, VDSina, Hostkey и т.п.) заходят и реальные посетители. `CLOUD_NO_INTERACTION` (55) срабатывает только для публичных облаков (AWS, Google Cloud, Azure, Alibaba, Tencent, Huawei, Oracle), если за сессию до 5 минут не было ни движения мыши, ни кликов, ни касаний. Вместе с `DATACENTER_NETWORK` это 73 балла, то есть `BOT`. Так выглядят скраперы, которые загружают страницу и ничего на ней не делают.

Desktop-специфичные правила мыши не применяются к mobile/tablet. Для мобильных учитываются touch/click cadence, scroll, active ratio, fingerprint и rate/velocity признаки.

## Ревизии и воспроизведение

Scoring захватывает сессию с lease на 2 минуты и читает согласованный снимок
контекста. Новый batch увеличивает ревизию данных; сохранение проверяет ревизию,
lease, ручную метку, режим и конфигурацию проекта. Устаревший результат не
попадает ни в классификации, ни в outbox. Ошибочная задача освобождает lease и
повторяется через 30 секунд; аварийный lease восстанавливается по истечении срока.

Автоматическая оценка сохраняет `algorithm_version`, `input_revision`,
`config_snapshot`, `context_snapshot`, `features_snapshot`. `rescore` применяет
текущие правила к текущему состоянию; `reproduce` использует сохранённые входы
конкретной оценки и требует совпадения версии алгоритма с бинарником. При
изменении правил нужно менять `AlgorithmVersion` и сохранять бинарник старой
версии для воспроизведения. Старые оценки без снимков восстановить точно нельзя.

Признаки строятся из `feature_state`, обновляемого batch-вставкой. Состояние
сохраняет счётчики и координаты mouse/click/scroll для точных percentiles и
поздних событий, поэтому размер растёт с количеством движений. Полный raw JSON,
DOM, URL и свойства бизнес-событий в нём не сохраняются. Состояние живёт до
удаления сессии и позволяет пересчитать её после истечения TTL raw events.
