---
id: monitoring
title: Мониторинг и логи
icon: 📈
order: 130
group: Эксплуатация
color: #e6522c
summary: Observability, Prometheus и PromQL, Alertmanager, Grafana, экспортеры, логи (Loki, ELK, Fluent Bit), трейсинг и OpenTelemetry, алертинг без шума.
---

# @theory

## Observability: три столпа

| Сигнал | Отвечает на вопрос | Инструменты |
|---|---|---|
| **Метрики** | *что* и *насколько* происходит (числа во времени) | Prometheus, VictoriaMetrics, Thanos, Mimir, Datadog |
| **Логи** | *почему* — детальные события | Loki, Elasticsearch/OpenSearch, ClickHouse |
| **Трейсы** | *где* в распределённой системе теряется время | Jaeger, Tempo, Zipkin |
| (+ профили) | какой код тратит CPU/память | Pyroscope, Parca |

**Мониторинг** — заранее известные вопросы (дашборды, алерты на известные отказы). **Observability** — возможность ответить на **новые** вопросы о системе по её выходным данным, не выкатывая новый код.

### Методологии
- **USE** (для ресурсов: CPU, диск, сеть): Utilization, Saturation, Errors.
- **RED** (для сервисов): **R**ate (запросов/с), **E**rrors (доля ошибок), **D**uration (латентность, перцентили).
- **Четыре золотых сигнала** (Google SRE): latency, traffic, errors, saturation.

## Prometheus: архитектура

- **Pull-модель**: Prometheus сам опрашивает (scrape) HTTP-эндпоинты `/metrics` целей с интервалом (обычно 15–30 с).
- **Service discovery**: kubernetes_sd, ec2_sd, consul_sd, file_sd — цели находятся автоматически.
- **TSDB**: локальное хранилище временных рядов (блоки по 2 ч, WAL), ретенция обычно 15–30 дней.
- **PromQL** — язык запросов.
- **Правила**: recording rules (предвычисление тяжёлых запросов) и alerting rules.
- **Alertmanager** — отдельный компонент: группировка, дедупликация, подавление, тишина, маршрутизация уведомлений.
- **Pushgateway** — для короткоживущих batch-задач, которые не успевают быть опрошены (не для обычных сервисов!).
- Долговременное хранение и HA: **Thanos**, **Grafana Mimir**, **VictoriaMetrics**, Cortex через `remote_write`.

```yaml prometheus.yml
global:
  scrape_interval: 15s
  evaluation_interval: 15s

rule_files: ["rules/*.yml"]

alerting:
  alertmanagers:
    - static_configs: [{ targets: ["alertmanager:9093"] }]

scrape_configs:
  - job_name: node
    static_configs:
      - targets: ["10.0.1.10:9100", "10.0.1.11:9100"]
        labels: { env: prod }

  - job_name: kubernetes-pods
    kubernetes_sd_configs: [{ role: pod }]
    relabel_configs:
      - source_labels: [__meta_kubernetes_pod_annotation_prometheus_io_scrape]
        action: keep
        regex: "true"
      - source_labels: [__meta_kubernetes_namespace]
        target_label: namespace
```

В Kubernetes обычно ставят **kube-prometheus-stack** (Prometheus Operator): цели описываются CRD `ServiceMonitor`/`PodMonitor`, правила — `PrometheusRule`.

### Модель данных
Временной ряд = имя метрики + набор **labels**: `http_requests_total{method="GET", status="200", service="api"}`.

> [!danger] Кардинальность
> Каждая уникальная комбинация labels — отдельный ряд. Label с user_id, email, полным URL с ID, request_id → миллионы рядов → Prometheus съедает всю память и падает. Labels — только для ограниченных множеств (метод, код, эндпоинт-шаблон, сервис).

### Типы метрик
| Тип | Что это | Пример | Как использовать |
|---|---|---|---|
| **Counter** | только растёт (сбрасывается при рестарте) | `http_requests_total` | всегда через `rate()`/`increase()` |
| **Gauge** | может расти и падать | `node_memory_MemAvailable_bytes`, температура, очередь | как есть, `avg_over_time` |
| **Histogram** | распределение по бакетам `_bucket{le="..."}` + `_sum` + `_count` | `http_request_duration_seconds` | `histogram_quantile()`, агрегируемы между инстансами |
| **Summary** | готовые квантили на стороне клиента | `go_gc_duration_seconds` | нельзя корректно агрегировать между инстансами |

## PromQL

```promql
# Скорость запросов в секунду за 5 минут по сервисам
sum by (service) (rate(http_requests_total[5m]))

# Доля 5xx ошибок
sum(rate(http_requests_total{status=~"5.."}[5m]))
  / sum(rate(http_requests_total[5m]))

# p99 латентности (histogram)
histogram_quantile(0.99, sum by (le, service) (rate(http_request_duration_seconds_bucket[5m])))

# Загрузка CPU ноды в %
100 - avg by (instance) (rate(node_cpu_seconds_total{mode="idle"}[5m])) * 100

# Свободная память в %
node_memory_MemAvailable_bytes / node_memory_MemTotal_bytes * 100

# Диск заполнится в течение 4 часов (прогноз по тренду за 6 ч)
predict_linear(node_filesystem_avail_bytes{fstype!~"tmpfs|overlay"}[6h], 4 * 3600) < 0

# Цель пропала / не скрейпится
up == 0
absent(up{job="api"})

# Топ-5 подов по памяти
topk(5, sum by (pod) (container_memory_working_set_bytes{container!=""}))

# Рестарты контейнеров за час
increase(kube_pod_container_status_restarts_total[1h]) > 3

# CPU throttling
sum by (pod) (rate(container_cpu_cfs_throttled_periods_total[5m]))
  / sum by (pod) (rate(container_cpu_cfs_periods_total[5m]))

# Соединение двух метрик по label
kube_pod_info * on (pod) group_left(node) kube_pod_container_resource_requests
```

| Понятие | Объяснение |
|---|---|
| instant vector | значения рядов в один момент: `up` |
| range vector | значения за интервал: `http_requests_total[5m]` (только как аргумент функций) |
| `rate()` | средняя скорость роста counter за окно, учитывает сбросы; для алертов и графиков |
| `irate()` | мгновенная скорость по двум последним точкам; для «дёрганых» графиков, не для алертов |
| `increase()` | прирост за окно (= rate × секунды) |
| `sum by (x)` / `without (x)` | агрегация с сохранением / удалением labels |
| `offset 1d` | значение сутки назад (сравнение с вчера) |
| Окно `rate` | минимум в 4 раза больше scrape_interval |

> [!warn] rate, потом sum
> Сначала `rate()`, потом `sum()` — никогда наоборот (`rate(sum(...))` недопустимо): сумма counter'ов теряет информацию о сбросах отдельных рядов.

## Алертинг и Alertmanager

```yaml rules/api.yml
groups:
  - name: api
    rules:
      - record: job:http_requests:rate5m
        expr: sum by (job) (rate(http_requests_total[5m]))

      - alert: APIHighErrorRate
        expr: |
          sum(rate(http_requests_total{job="api",status=~"5.."}[5m]))
            / sum(rate(http_requests_total{job="api"}[5m])) > 0.05
        for: 10m
        labels:
          severity: critical
          team: backend
        annotations:
          summary: "API: {{ $value | humanizePercentage }} ошибок 5xx"
          runbook_url: https://wiki.example.com/runbooks/api-5xx
          dashboard: https://grafana.example.com/d/api

      - alert: DiskWillFillIn4h
        expr: predict_linear(node_filesystem_avail_bytes{fstype!~"tmpfs|overlay"}[6h], 4*3600) < 0
        for: 30m
        labels: { severity: warning }
```

- `for` — условие должно держаться N минут (фильтр всплесков). Состояния: inactive → **pending** → **firing**.
- **Alertmanager**:
  - **grouping** — объединить 50 алертов «нода недоступна» в одно уведомление;
  - **inhibition** — подавить зависимые (если упал весь кластер — не слать алерт на каждый под);
  - **silences** — тишина на время работ;
  - **routing** — по labels: critical → PagerDuty/звонок, warning → Slack/Telegram, по командам.

```yaml alertmanager.yml
route:
  receiver: slack-default
  group_by: [alertname, cluster, service]
  group_wait: 30s
  group_interval: 5m
  repeat_interval: 4h
  routes:
    - matchers: [severity="critical"]
      receiver: pagerduty
inhibit_rules:
  - source_matchers: [alertname="NodeDown"]
    target_matchers: [severity="warning"]
    equal: [instance]
receivers:
  - name: slack-default
    slack_configs: [{ channel: "#alerts", send_resolved: true }]
  - name: pagerduty
    pagerduty_configs: [{ routing_key: "<secret>" }]
```

### Принципы хорошего алертинга
1. Алертить на **симптомы, видимые пользователю** (ошибки, латентность, SLO burn rate), а не на каждую причину (CPU 90% — само по себе не проблема).
2. Каждый пейджинг-алерт должен быть **actionable** — требовать действия человека сейчас. Иначе — тикет/дашборд.
3. У каждого алерта — **runbook** (что проверить, как починить) и ссылка на дашборд.
4. Бороться с **alert fatigue**: регулярно пересматривать шумные алерты; ложные срабатывания учат игнорировать.
5. **Мониторить сам мониторинг** (dead man's switch: алерт `Watchdog`, который всегда firing; его отсутствие = мониторинг сломан).
6. SLO-based алертинг по **burn rate** (многооконный): быстрое выгорание бюджета → page, медленное → тикет.

## Экспортеры и инструментирование

| Экспортер | Что отдаёт |
|---|---|
| **node_exporter** | метрики хоста: CPU, память, диски, сеть, файловые системы |
| **cAdvisor** (в kubelet) | метрики контейнеров |
| **kube-state-metrics** | состояние объектов K8s: реплики, статусы подов, рестарты, requests |
| **blackbox_exporter** | внешние проверки: HTTP, TCP, ICMP, DNS, срок TLS-сертификатов |
| postgres_exporter, mysqld_exporter, redis_exporter, kafka_exporter | метрики БД и брокеров |
| nginx-prometheus-exporter, ingress-nginx metrics | веб-серверы |
| process-exporter, textfile collector | процессы, собственные метрики из скриптов |

Приложение экспортирует свои метрики через клиентскую библиотеку (prometheus client для Go/Python/Java) или через **OpenTelemetry SDK**: RED-метрики эндпоинтов, бизнес-метрики (заказы/мин), размеры очередей, пулы соединений.

## Grafana

- Источники данных: Prometheus, Loki, Tempo, Elasticsearch, PostgreSQL, CloudWatch…
- **Переменные** дашборда (`$namespace`, `$pod`) — один дашборд для всех сервисов.
- Дашборды как код: JSON в Git + provisioning, Grafonnet/Jsonnet, Terraform-провайдер Grafana.
- Unified alerting Grafana — альтернатива Alertmanager-правилам.
- Хороший дашборд сервиса: сверху — RED/SLO (запросы, ошибки, p50/p95/p99), ниже — saturation (CPU, память, пулы, очереди), ещё ниже — зависимости (БД, кэш, внешние API), версии/деплои как аннотации.

## Логирование

### Принципы
- **Структурированные логи** (JSON): `{"ts":"…","level":"error","msg":"payment failed","order_id":42,"trace_id":"…"}` — легко фильтровать и агрегировать.
- Уровни: DEBUG, INFO, WARN, ERROR, FATAL. В проде — INFO и выше, DEBUG динамически.
- В контейнерах — писать в **stdout/stderr**, сбор — агентом на ноде.
- **Correlation/trace ID** во всех логах запроса для связи между сервисами.
- Не логировать секреты, токены, персональные данные (маскирование).
- Ретенция и стоимость: горячее хранение дни/недели, холодное — в S3.

### Стек
| Компонент | Варианты |
|---|---|
| Сбор (агент на ноде) | **Fluent Bit**, Vector, Promtail/Grafana Alloy, Filebeat, OpenTelemetry Collector |
| Агрегация/обработка | Fluentd, Logstash, Vector |
| Хранение и поиск | **Loki** (индексирует только labels, дешёвый, LogQL), **Elasticsearch/OpenSearch** (полнотекстовый индекс, мощный поиск, дорогой), ClickHouse |
| UI | Grafana, Kibana/OpenSearch Dashboards |

**ELK/EFK** = Elasticsearch + Logstash/Fluentd + Kibana. **PLG** = Promtail + Loki + Grafana.

```text LogQL
{namespace="prod", app="api"} |= "error" | json | status >= 500 | line_format "{{.method}} {{.path}} {{.status}}"
sum by (status) (rate({app="nginx"} | json | __error__="" [5m]))
topk(10, sum by (path) (count_over_time({app="api"} | json | duration > 1s [1h])))
```

## Трейсинг и OpenTelemetry

**Распределённый трейс** — дерево **спанов** (span): каждый — операция с началом, длительностью, атрибутами и родителем. Контекст (`trace_id`, `span_id`) передаётся между сервисами в заголовке **`traceparent`** (W3C Trace Context).

Показывает, в каком сервисе/запросе к БД теряется время, где возникла ошибка, какие зависимости вызываются.

**OpenTelemetry (OTel)** — вендор-нейтральный стандарт и набор SDK/агентов для метрик, логов и трейсов:
- SDK и **автоинструментирование** (Java agent, Python, Node.js, eBPF-инструменты);
- **OTel Collector**: receivers (OTLP, Prometheus, Jaeger) → processors (batch, фильтрация, sampling, атрибуты) → exporters (Tempo, Jaeger, Prometheus, Datadog, Loki);
- протокол **OTLP**.

**Сэмплирование**: head-based (решение в начале — например, 10% трейсов) и tail-based (в Collector после завершения — сохранять все трейсы с ошибками и медленные).

Связка сигналов: **exemplars** (из точки на графике латентности перейти к конкретному трейсу), trace_id в логах → переход из лога в трейс.

# @interview

## [junior] Какие типы метрик есть в Prometheus?
Counter (монотонно растёт, используется с rate/increase), Gauge (текущее значение, может уменьшаться), Histogram (распределение по бакетам, позволяет считать квантили и агрегировать между инстансами), Summary (квантили считаются на клиенте, не агрегируются).

## [junior] Pull или push: как работает Prometheus и почему?
Pull: Prometheus сам опрашивает `/metrics` целей. Плюсы: централизованный контроль частоты, легко понять, что цель недоступна (`up == 0`), цели не знают о мониторинге, удобно отлаживать (открыть /metrics в браузере). Для короткоживущих задач — Pushgateway; для сред, куда нельзя достучаться, — агент с remote_write.

## [middle] Чем rate() отличается от irate() и increase()?
`rate` — средняя скорость роста counter в секунду за всё окно, сглажена, корректно обрабатывает сбросы — для алертов и графиков. `irate` — по двум последним точкам окна, показывает резкие всплески, не для алертов. `increase` — прирост за окно (rate × длительность окна).

## [middle] Как посчитать 99-й перцентиль латентности?
Метрика должна быть histogram: `histogram_quantile(0.99, sum by (le) (rate(http_request_duration_seconds_bucket[5m])))`. Важно агрегировать по `le` и правильно подобрать границы бакетов — точность квантиля ограничена бакетами.

## [middle] Почему среднее время ответа — плохая метрика?
Среднее скрывает хвосты распределения: 99% запросов за 50 мс и 1% за 10 с дают «приличное» среднее, хотя каждый сотый пользователь страдает (а в запросе, затрагивающем много сервисов, вероятность попасть в хвост высока). Смотреть перцентили p50/p95/p99 и максимумы.

## [middle] Что такое кардинальность и почему она опасна?
Количество уникальных временных рядов (комбинаций метрика + labels). Высокая кардинальность (labels с user_id, IP, полным URL) взрывает потребление памяти и диска Prometheus, замедляет запросы, может положить мониторинг. Контроль: только ограниченные значения labels, relabeling для удаления лишнего, лимиты (`sample_limit`), анализ `topk(10, count by (__name__)({__name__=~".+"}))`.

## [middle] Что такое методы USE и RED?
USE — для ресурсов: Utilization (загрузка), Saturation (очередь/насыщение), Errors. RED — для сервисов: Rate (запросы/с), Errors (ошибки), Duration (латентность). Вместе дают быстрый план диагностики и структуру дашбордов.

## [middle] Как сделать алертинг без шума?
Алертить по симптомам, влияющим на пользователей (SLO, ошибки, латентность), а не по каждой метрике ресурсов; `for` для фильтрации всплесков; группировка и inhibition в Alertmanager; разделение severity (page vs ticket); runbook у каждого алерта; регулярный разбор шумных алертов; burn-rate алерты по SLO.

## [middle] Как мониторить сам мониторинг?
Dead man's switch: постоянно firing алерт (`Watchdog`/`vector(1)`), который получает внешний сервис (Healthchecks.io, PagerDuty heartbeat, DeadMansSnitch); если он перестал приходить — мониторинг сломан. Плюс мониторинг Prometheus извне (второй Prometheus, мета-мониторинг), алерты на `up`, ошибки правил, переполнение TSDB.

## [senior] Как масштабировать Prometheus и хранить метрики долго?
Шардирование по функциональности/командам, федерация (устаревший подход), `remote_write` в масштабируемые хранилища (Thanos, Mimir, VictoriaMetrics, Cortex) с глобальным запросом, дедупликацией HA-пар и долгим хранением в объектном хранилище с даунсемплингом. Recording rules для тяжёлых запросов, контроль кардинальности.

## [middle] Чем Loki отличается от Elasticsearch?
Loki индексирует только labels (метаданные потоков), а сами строки хранит сжатыми чанками в объектном хранилище — дёшево и просто, поиск по содержимому — брутфорсом по выбранным потокам. Elasticsearch строит полнотекстовый инвертированный индекс по всему содержимому — мощный быстрый поиск и аналитика, но дорого по ресурсам и в эксплуатации.

## [middle] Что такое distributed tracing и OpenTelemetry?
Трейсинг отслеживает путь запроса через множество сервисов как дерево спанов с таймингами, контекст передаётся через заголовки (W3C traceparent). OpenTelemetry — открытый стандарт и набор SDK/Collector для генерации и передачи метрик, логов и трейсов в любой бэкенд без привязки к вендору.

## [middle] Что такое blackbox-мониторинг и whitebox-мониторинг?
Whitebox — метрики изнутри системы (экспортеры, метрики приложения). Blackbox — проверки снаружи глазами пользователя (HTTP-пробы, синтетические транзакции, проверка сертификатов, DNS) — ловит то, что внутренние метрики не видят (DNS, CDN, сеть, сертификат).

## [junior] Какие метрики вы бы собирали для веб-сервиса?
RED: RPS, долю ошибок (4xx/5xx отдельно), латентность p50/p95/p99 по эндпоинтам. Saturation: CPU, память, пулы соединений, очереди, GC. Зависимости: латентность и ошибки БД/кэша/внешних API. Бизнес-метрики (регистрации, заказы). Blackbox-проверки доступности и сроки сертификатов.

# @troubleshooting

## [high] Prometheus потребляет всю память / OOM
**Диагностика:**
```promql
prometheus_tsdb_head_series                              # общее число рядов
topk(20, count by (__name__) ({__name__=~".+"}))         # метрики с наибольшим числом рядов
topk(20, count by (job) ({__name__=~".+"}))
```
Также страница **Status → TSDB Status** в UI.

**Причина:** взрыв кардинальности (новый деплой добавил label с ID/URL), слишком много целей, тяжёлые запросы дашбордов.

**Решение:** `metric_relabel_configs` с `action: labeldrop`/`drop`, исправить инструментирование, `sample_limit` на job, recording rules, шардирование, больше памяти.

## [medium] Цель в состоянии DOWN на странице Targets
**Причины по тексту ошибки:** `connection refused` (экспортер не запущен/не тот порт), `context deadline exceeded` (таймаут — медленный /metrics, сеть, NetworkPolicy), `server returned HTTP status 401/403` (нужна аутентификация), `x509` (TLS), неверный путь метрик. В K8s — проверить ServiceMonitor selector и labels сервиса, namespaceSelector, имя порта.

## [medium] Алерт не пришёл, хотя проблема была
**Проверить цепочку:** правило загружено (Status → Rules, нет ошибок вычисления)? Условие действительно выполнялось (выполнить expr в UI за тот период)? Не сбрасывалось ли раньше `for`? Алерт дошёл до Alertmanager (Alerts в UI AM)? Не был ли под silence/inhibition? Маршрут ведёт в правильный receiver? Ошибки отправки в логах Alertmanager (`notify retry`)? Работает ли Watchdog?

## [medium] Графики «рвутся» или показывают пропуски
**Причины:** окно `rate` меньше 2 интервалов скрейпа (нужно минимум 4×), рестарты Prometheus/целей, таймауты скрейпа, метрика появляется только при событиях (counter без инициализации нулём).

**Решение:** `rate(x[$__rate_interval])` в Grafana, инициализировать counters при старте, проверить `scrape_duration_seconds`.

## [medium] Логи не доходят до Loki/Elasticsearch
**Диагностика:** логи агента (Fluent Bit/Promtail) на ноде, его метрики (ошибки отправки, ретраи, буфер), права на чтение `/var/log/pods`, парсинг (ошибки JSON), rate limit/лимиты ingestion в Loki (`429 Too Many Requests`, `entry too far behind`), mapping conflicts в Elasticsearch (поле то строка, то объект), заполнен диск ES (индексы в read-only: `flood stage watermark`).

# @quiz

? Какой тип метрики использовать для числа HTTP-запросов?
+ Counter
- Gauge
- Summary
- Histogram без бакетов
> Затем считать скорость через rate().

? Какой запрос правильно считает суммарный RPS сервиса?
- rate(sum(http_requests_total)[5m])
+ sum(rate(http_requests_total[5m]))
- sum(http_requests_total)
- irate(http_requests_total)
> Сначала rate для каждого ряда, затем sum.

? Что делает `for: 10m` в правиле алерта?
- Отправляет алерт каждые 10 минут
+ Алерт сработает, только если условие истинно непрерывно 10 минут
- Хранит алерт 10 минут
- Ограничивает запрос окном 10 минут
> До этого алерт в состоянии pending.

? Какой компонент подавляет зависимые алерты и группирует уведомления?
- Prometheus
- Grafana
+ Alertmanager
- Pushgateway
> inhibition и grouping — функции Alertmanager.

? Что такое RED?
+ Rate, Errors, Duration
- Read, Execute, Delete
- Resources, Events, Dependencies
- Redundancy, Elasticity, Durability
> Методология для сервисов.

? Почему label user_id в метрике — плохая идея?
- Prometheus не поддерживает числа в labels
+ Это создаёт огромную кардинальность (ряд на каждого пользователя)
- Это нарушает GDPR всегда
- Labels не могут содержать подчёркивание
> Каждая комбинация labels — отдельный временной ряд.

? Чем Loki дешевле Elasticsearch?
+ Индексирует только labels, а не содержимое строк
- Не хранит логи вообще
- Хранит только ошибки
- Использует SQL
> Содержимое хранится сжатыми чанками в объектном хранилище.

? Какой заголовок W3C передаёт контекст трейса?
- X-Request-ID
+ traceparent
- X-B3-Sampled
- trace-context-id
> Формат: version-traceid-spanid-flags.
