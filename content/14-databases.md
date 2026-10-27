---
id: databases
title: Базы данных и очереди
icon: 🗄️
order: 140
group: Эксплуатация
color: #336791
summary: PostgreSQL для DevOps (MVCC, VACUUM, репликация, бэкапы и PITR, пулинг), MySQL, Redis, Kafka и RabbitMQ, ACID/CAP, типичные аварии БД.
---

# @theory

## Базовые понятия

### ACID
- **Atomicity** — транзакция выполняется целиком или не выполняется.
- **Consistency** — переводит БД из одного корректного состояния в другое (ограничения, внешние ключи).
- **Isolation** — параллельные транзакции не мешают друг другу (уровни изоляции).
- **Durability** — подтверждённая транзакция переживёт сбой (WAL + fsync).

### Уровни изоляции
| Уровень | Грязное чтение | Неповторяющееся чтение | Фантомы |
|---|---|---|---|
| Read Uncommitted | возможно | возможно | возможно |
| Read Committed (**дефолт PostgreSQL**) | нет | возможно | возможно |
| Repeatable Read (**дефолт MySQL InnoDB**) | нет | нет | возможно (в PG — нет) |
| Serializable | нет | нет | нет |

### CAP и PACELC
При сетевом разделении (**P**artition) распределённая система выбирает между **C**onsistency (отказать в запросе) и **A**vailability (ответить, возможно устаревшими данными). PACELC добавляет: **E**lse (без разделения) — выбор между **L**atency и **C**onsistency. Примеры: etcd/ZooKeeper — CP, Cassandra/DynamoDB — AP (с настраиваемой согласованностью).

### Индексы
B-tree (по умолчанию: равенство, диапазоны, сортировка), Hash, GIN (массивы, JSONB, полнотекстовый поиск), GiST (геоданные), BRIN (огромные упорядоченные таблицы). Индекс ускоряет чтение, но замедляет запись и занимает место. Проверка — `EXPLAIN (ANALYZE, BUFFERS)`.

### Масштабирование
- **Вертикальное** — больше CPU/RAM/IOPS.
- **Read replicas** — чтение с реплик (учитывать лаг).
- **Пулинг соединений** — PgBouncer, ProxySQL.
- **Кэш** — Redis/Memcached перед БД.
- **Партиционирование** — разбиение таблицы на части внутри одной БД (по дате).
- **Шардирование** — данные по разным серверам по ключу (Citus, Vitess, на уровне приложения).

## PostgreSQL: архитектура

- **Процессная модель**: postmaster + **отдельный процесс на каждое соединение** (backend). Соединения дорогие (несколько МБ памяти каждое) → нужен пулер.
- Фоновые процессы: **checkpointer**, **background writer**, **WAL writer**, **autovacuum launcher/workers**, **walsender** (репликация), stats collector.
- **Shared buffers** — кэш страниц в общей памяти (обычно ~25% RAM), плюс page cache ОС.
- **WAL** (Write-Ahead Log) — каждое изменение сначала пишется в журнал (`pg_wal/`), потом в файлы данных. Обеспечивает durability, репликацию и PITR.
- **Checkpoint** — сброс грязных страниц на диск; после него старый WAL можно удалять (если не нужен репликам/архиву).

### MVCC и VACUUM
PostgreSQL не изменяет строки на месте: `UPDATE` = новая версия строки + старая помечается мёртвой; `DELETE` помечает строку. Читатели не блокируют писателей и наоборот.

- Мёртвые версии (**dead tuples**) накапливаются → **bloat** (раздувание таблиц и индексов).
- **VACUUM** помечает место мёртвых строк как свободное для переиспользования (файл не уменьшается); `VACUUM FULL` переписывает таблицу целиком с **эксклюзивной блокировкой** (в проде — `pg_repack`).
- **autovacuum** запускает VACUUM и ANALYZE автоматически по порогам.
- **Transaction ID wraparound**: XID 32-битные; если VACUUM долго не замораживает старые строки, PostgreSQL остановит запись для защиты от потери данных. Мониторить `age(datfrozenxid)`.
- **Долгие транзакции** (в т.ч. `idle in transaction`) мешают VACUUM удалить мёртвые строки → bloat и рост WAL.

```sql
-- Активные запросы и кто что ждёт
SELECT pid, usename, state, wait_event_type, wait_event, now() - xact_start AS xact_age, left(query, 80)
FROM pg_stat_activity WHERE state <> 'idle' ORDER BY xact_age DESC NULLS LAST;

-- Блокировки: кто кого блокирует
SELECT pid, pg_blocking_pids(pid) AS blocked_by, left(query, 60) FROM pg_stat_activity WHERE cardinality(pg_blocking_pids(pid)) > 0;

-- Отменить запрос / убить соединение
SELECT pg_cancel_backend(12345);
SELECT pg_terminate_backend(12345);

-- Мёртвые строки и последний autovacuum
SELECT relname, n_live_tup, n_dead_tup, last_autovacuum FROM pg_stat_user_tables ORDER BY n_dead_tup DESC LIMIT 10;

-- Размер БД и таблиц
SELECT pg_size_pretty(pg_database_size(current_database()));
SELECT relname, pg_size_pretty(pg_total_relation_size(relid)) FROM pg_catalog.pg_statio_user_tables ORDER BY pg_total_relation_size(relid) DESC LIMIT 10;

-- Самые тяжёлые запросы (расширение pg_stat_statements)
SELECT calls, round(total_exec_time) AS total_ms, round(mean_exec_time, 1) AS mean_ms, left(query, 80)
FROM pg_stat_statements ORDER BY total_exec_time DESC LIMIT 10;

-- Возраст XID (wraparound)
SELECT datname, age(datfrozenxid) FROM pg_database ORDER BY 2 DESC;
```

### Важные настройки
| Параметр | Смысл |
|---|---|
| `max_connections` | максимум соединений (100–300 + пулер) |
| `shared_buffers` | ~25% RAM |
| `effective_cache_size` | подсказка планировщику: ~50–75% RAM |
| `work_mem` | память на сортировку/хэш **на операцию** (× соединения × операции!) |
| `maintenance_work_mem` | для VACUUM, CREATE INDEX |
| `max_wal_size`, `checkpoint_timeout` | частота checkpoint'ов |
| `wal_level=replica`, `archive_mode`, `archive_command` | репликация и архив WAL |
| `log_min_duration_statement = 500ms` | логировать медленные запросы |
| `idle_in_transaction_session_timeout`, `statement_timeout` | защита от зависших транзакций |

`pg_hba.conf` — кто, откуда, к какой БД и каким методом аутентифицируется (`scram-sha-256`).

## Репликация и высокая доступность

### Физическая (streaming) репликация PostgreSQL
Реплика получает поток WAL от primary (walsender → walreceiver) и применяет его — побайтовая копия кластера, **read-only** (hot standby).
- **Асинхронная** (по умолчанию): primary не ждёт реплику — быстро, но при падении primary последние транзакции могут потеряться (RPO > 0).
- **Синхронная** (`synchronous_standby_names`): коммит ждёт подтверждения реплики — RPO = 0, но выше латентность и риск остановки записи при недоступности реплики.
- **Replication slots** гарантируют, что primary не удалит WAL, пока реплика его не получила. Мёртвая реплика со слотом → `pg_wal` растёт бесконечно → диск переполнен!

```sql
-- На primary
SELECT client_addr, state, sync_state, pg_wal_lsn_diff(pg_current_wal_lsn(), replay_lsn) AS lag_bytes FROM pg_stat_replication;
SELECT slot_name, active, pg_size_pretty(pg_wal_lsn_diff(pg_current_wal_lsn(), restart_lsn)) AS retained FROM pg_replication_slots;
-- На реплике
SELECT now() - pg_last_xact_replay_timestamp() AS replay_lag;
```

### Логическая репликация
Публикации/подписки на уровне таблиц, между разными мажорными версиями — для миграций и апгрейдов с минимальным простоем, CDC (Debezium).

### HA и failover
- **Patroni** (+ etcd/Consul для лидер-выбора) — стандарт для самостоятельного HA PostgreSQL; **CloudNativePG** — оператор для Kubernetes; managed — RDS/Aurora Multi-AZ, Cloud SQL.
- **Split-brain** — два primary одновременно; защищаются кворумом DCS и fencing.
- Точка входа: VIP (keepalived), HAProxy с проверкой роли через Patroni REST API, DNS, PgBouncer.

### MySQL кратко
- Репликация через **binlog** (row/statement/mixed); асинхронная, полусинхронная, **GTID** упрощает переключение.
- InnoDB: кластерный индекс по PK, redo/undo логи, buffer pool (`innodb_buffer_pool_size` ~70% RAM).
- HA: Group Replication / InnoDB Cluster, Orchestrator, Galera (Percona XtraDB Cluster), ProxySQL перед кластером.
- Бэкапы: `mysqldump --single-transaction`, **Percona XtraBackup** (физический горячий), binlog для PITR.

## Бэкапы и восстановление

| Метод | Что это | Плюсы / минусы |
|---|---|---|
| `pg_dump` / `pg_dumpall` | логический дамп (SQL или custom-формат) | переносимый, выборочный, между версиями; медленный на больших БД, нет PITR |
| `pg_basebackup` | физическая копия кластера | быстро; только целиком и та же мажорная версия |
| Физический бэкап + **архив WAL** | base backup + все WAL после него | **PITR** — восстановление на любой момент времени |
| Снапшоты дисков | снапшот тома (EBS) | быстро; нужна консистентность (pg_backup_start или crash-consistent) |

Инструменты: **pgBackRest**, **WAL-G**, Barman — инкрементальные бэкапы, сжатие, шифрование, хранение в S3, PITR.

```bash
pg_dump -Fc -d app -f app.dump            # custom-формат (сжатый, параллельное восстановление)
pg_restore -d app_new -j 4 app.dump
pg_dump -d app --schema-only > schema.sql
pg_basebackup -D /backup/base -Ft -z -P -X stream
# PITR: восстановить base backup, затем в postgresql.conf:
# restore_command = 'wal-g wal-fetch %f %p'
# recovery_target_time = '2026-10-27 14:30:00'
# touch recovery.signal && start
```

> [!danger] Бэкап, который не восстанавливали, — не бэкап
> Регулярно и **автоматически** проверяйте восстановление (restore в отдельный инстанс + проверочные запросы), измеряйте время восстановления (RTO). Храните копии в другом регионе/аккаунте, защищайте от удаления (object lock, отдельные креды) — от шифровальщиков и ошибок.

- **RPO** (Recovery Point Objective) — сколько данных допустимо потерять (частота бэкапов/архивации WAL).
- **RTO** (Recovery Time Objective) — за сколько нужно восстановиться.
- Правило **3-2-1**: 3 копии, на 2 разных носителях, 1 — вне площадки (+1 неизменяемая, +0 ошибок при проверке).

## Пулинг соединений

**PgBouncer** — лёгкий пулер перед PostgreSQL: тысячи клиентских соединений → десятки серверных.

| Режим | Соединение с сервером выдаётся на | Ограничения |
|---|---|---|
| session | всю сессию клиента | экономии мало |
| **transaction** | время транзакции | не работают сессионные фичи: `SET`, advisory locks, `LISTEN`, prepared statements (поддержка добавлена в PgBouncer 1.21+) |
| statement | один запрос | нельзя многооператорные транзакции |

Почему важно в Kubernetes: 50 подов × пул по 20 соединений = 1000 соединений к БД. Решения — PgBouncer (sidecar или отдельный сервис), уменьшение пулов в приложении, RDS Proxy.

## Redis

In-memory key-value хранилище: кэш, сессии, rate limiting, очереди, pub/sub, лидерборды. Однопоточная обработка команд (I/O-потоки с 6.0) — одна медленная команда (`KEYS *`, большой `SMEMBERS`) блокирует всё.

### Персистентность
- **RDB** — периодические снапшоты (fork + запись). Компактно, быстро восстанавливается, но потеря данных с последнего снапшота. `fork` на большой памяти — кратковременные паузы и нужна память под copy-on-write.
- **AOF** — журнал всех операций (`appendfsync everysec` — потеря ≤ 1 с). Больше и медленнее, периодически переписывается (rewrite).
- Можно оба. Для чистого кэша — без персистентности.

### Память и вытеснение
`maxmemory` + `maxmemory-policy`: `noeviction` (ошибки записи при заполнении — по умолчанию), `allkeys-lru`/`allkeys-lfu` (для кэша), `volatile-lru` (только ключи с TTL), `volatile-ttl`.

### HA
- **Replication** (master → replicas), асинхронная.
- **Sentinel** — мониторинг и автоматический failover для master/replica.
- **Redis Cluster** — шардирование по 16384 hash slots + реплики, клиент должен поддерживать кластер.
- Лицензия Redis сменилась в 2024 → форк **Valkey** (Linux Foundation); в 2025 Redis 8 снова доступен под AGPL.

```bash
redis-cli INFO memory | grep -E "used_memory_human|maxmemory|mem_fragmentation_ratio"
redis-cli INFO stats | grep -E "evicted_keys|keyspace_hits|keyspace_misses"
redis-cli --bigkeys; redis-cli --latency
redis-cli SLOWLOG GET 10
redis-cli CLIENT LIST | wc -l
redis-cli --scan --pattern 'session:*' | head     # вместо KEYS *
```

## Очереди и брокеры: Kafka и RabbitMQ

| | Kafka | RabbitMQ |
|---|---|---|
| Модель | распределённый **лог**: сообщения хранятся по ретенции, consumers читают по offset | **брокер очередей**: сообщение удаляется после подтверждения |
| Пропускная способность | очень высокая (миллионы msg/s) | высокая (десятки тысяч msg/s на узел) |
| Повторное чтение | да (сдвинуть offset) | нет (кроме streams) |
| Маршрутизация | по топикам/партициям | гибкая: exchanges (direct, topic, fanout, headers) |
| Порядок | гарантирован внутри партиции | внутри очереди (с одним consumer) |
| Сценарии | event streaming, логи, CDC, аналитика | задачи, RPC, сложная маршрутизация |

### Kafka: ключевые понятия
- **Topic** делится на **partitions** (единица параллелизма и порядка), каждая реплицируется (`replication.factor=3`) — leader + followers, **ISR** (in-sync replicas).
- **Producer** выбирает партицию по ключу (один ключ → одна партиция → порядок). `acks=all` + `min.insync.replicas=2` — надёжная запись.
- **Consumer group**: каждая партиция читается одним consumer'ом группы → максимум параллелизма = число партиций. **Rebalance** при изменении состава группы.
- **Consumer lag** — отставание consumer'а (главная метрика): `kafka-consumer-groups.sh --describe --group app`.
- Семантика доставки: at-most-once, **at-least-once** (стандарт — нужна идемпотентная обработка), exactly-once (идемпотентный producer + транзакции).
- Метаданные кластера — **KRaft** (с Kafka 4.0 ZooKeeper удалён).

### RabbitMQ
Producer → **exchange** → (binding по routing key) → **queue** → consumer с **ack**. **Quorum queues** (Raft) — для надёжности вместо classic mirrored. Prefetch (`basic.qos`) ограничивает число неподтверждённых сообщений на consumer'а. **DLX** (dead letter exchange) — для сообщений, которые не удалось обработать.

# @interview

## [junior] Что такое ACID?
Atomicity (всё или ничего), Consistency (сохранение инвариантов), Isolation (параллельные транзакции изолированы согласно уровню), Durability (подтверждённые данные переживут сбой).

## [middle] Что такое MVCC и зачем PostgreSQL нужен VACUUM?
Multi-Version Concurrency Control: при изменении создаётся новая версия строки, а старая остаётся для транзакций, которые её видят; читатели и писатели не блокируют друг друга. Старые (мёртвые) версии нужно убирать — это делает VACUUM (autovacuum), иначе таблицы раздуваются, запросы замедляются, а также возможен transaction ID wraparound.

## [middle] Почему в PostgreSQL нельзя просто поставить max_connections = 5000?
Каждое соединение — отдельный процесс с собственной памятью (work_mem на операцию и пр.), растут накладные расходы на переключение контекста и блокировки, снапшоты транзакций дороже. Правильно — пулер (PgBouncer, RDS Proxy) и небольшое число серверных соединений (порядка нескольких × числа ядер).

## [middle] Чем синхронная репликация отличается от асинхронной?
Асинхронная: primary подтверждает коммит, не дожидаясь реплики — быстрее, но при отказе primary последние транзакции могут быть потеряны. Синхронная: коммит подтверждается после записи на реплику — нулевая потеря данных, но выше латентность и запись блокируется при недоступности синхронной реплики (поэтому используют кворум `ANY 1 (r1, r2)`).

## [middle] Что такое RPO и RTO?
RPO — максимально допустимая потеря данных во времени (определяет частоту бэкапов/репликацию). RTO — максимально допустимое время восстановления сервиса (определяет стратегию: восстановление из бэкапа, standby, multi-AZ).

## [middle] Как сделать бэкап PostgreSQL, позволяющий восстановиться на любую секунду?
Регулярный физический base backup + непрерывное архивирование WAL (pgBackRest, WAL-G, Barman) в удалённое хранилище. Восстановление — развернуть base backup, применить WAL до `recovery_target_time`. Плюс регулярная проверка восстановления.

## [middle] Как найти медленные запросы в PostgreSQL?
`pg_stat_statements` (суммарное и среднее время по нормализованным запросам), `log_min_duration_statement` и `auto_explain` в логах, `pg_stat_activity` для текущих, `EXPLAIN (ANALYZE, BUFFERS)` для разбора плана (Seq Scan по большой таблице, неверная оценка строк, отсутствующий индекс), мониторинг (postgres_exporter, pganalyze).

## [senior] Почему растёт pg_wal и чем это грозит?
Причины: неактивный replication slot (мёртвая реплика или забытый слот логической репликации), падает `archive_command` (WAL не архивируется — не удаляется), высокий `wal_keep_size`, долгие checkpoint'ы при большой записи. Грозит переполнением диска и остановкой БД. Мониторить размер pg_wal, `pg_replication_slots`, `pg_stat_archiver`; ограничивать `max_slot_wal_keep_size`.

## [middle] Что такое split-brain и как его избежать?
Ситуация, когда два узла одновременно считают себя primary и принимают запись — данные расходятся. Избегают кворумом (DCS etcd/Consul в Patroni, нечётное число голосующих), fencing/STONITH (гарантированно изолировать старый primary), watchdog, отказ от автоматического failover без кворума.

## [middle] Зачем нужен PgBouncer и какие у него режимы?
Пулер соединений: мультиплексирует множество клиентских соединений на небольшой пул серверных. Режимы: session (соединение на сессию), transaction (на транзакцию — самый эффективный, но ограничивает сессионные возможности), statement.

## [middle] Как Redis сохраняет данные на диск?
RDB — периодические снапшоты через fork; AOF — журнал операций с настраиваемым fsync (always/everysec/no) и периодическим rewrite. Можно комбинировать. Без персистентности Redis — чистый кэш.

## [middle] Что будет, когда Redis достигнет maxmemory?
Зависит от `maxmemory-policy`: при `noeviction` — ошибки `OOM command not allowed` на запись; при LRU/LFU-политиках — вытеснение ключей (для всех или только с TTL). Для кэша — `allkeys-lru`/`allkeys-lfu`.

## [middle] Чем Kafka отличается от RabbitMQ?
Kafka — распределённый журнал с хранением сообщений по ретенции, consumers сами управляют offset (можно перечитать), масштабирование по партициям, очень высокая пропускная способность — для потоков событий. RabbitMQ — классический брокер с очередями, гибкой маршрутизацией через exchanges, подтверждениями и удалением после обработки — для задач и интеграций.

## [middle] Что такое consumer lag в Kafka и как его уменьшить?
Разница между последним offset в партиции и закоммиченным offset группы consumers — насколько обработка отстаёт. Уменьшить: добавить consumers (не больше числа партиций), увеличить число партиций, ускорить обработку (батчи, параллелизм внутри consumer'а), устранить медленные зависимости, проверить частые rebalance.

## [senior] Как обновить мажорную версию PostgreSQL с минимальным простоем?
Варианты: `pg_upgrade --link` (быстро, простой минуты, на месте), логическая репликация на новый кластер новой версии и переключение (простой секунды), managed blue/green deployments (RDS). Обязательно: тест на копии, бэкап, проверка расширений, `ANALYZE` после апгрейда.

## [middle] Почему БД в Kubernetes — спорное решение?
Stateful-нагрузка требует надёжного хранилища (latency, IOPS, поведение при переезде пода и отказе ноды), продуманного HA, бэкапов, тюнинга ядра, защиты от eviction. Сейчас это реально с операторами (CloudNativePG, Percona, Zalando) и локальными NVMe/хорошими CSI, но требует компетенций; managed БД снимает большую часть операционной нагрузки.

# @troubleshooting

## [critical] FATAL: sorry, too many clients already
**Диагностика:**
```sql
SELECT count(*), state FROM pg_stat_activity GROUP BY state;
SELECT usename, application_name, client_addr, count(*) FROM pg_stat_activity GROUP BY 1,2,3 ORDER BY 4 DESC;
SHOW max_connections;
```
**Причины:** приложение масштабировалось (больше подов × размер пула), утечка соединений, много `idle in transaction`, нет пулера.

**Решение:** срочно — завершить idle-соединения (`pg_terminate_backend` для `idle` старше N минут), уменьшить пулы в приложениях; постоянно — PgBouncer, `idle_in_transaction_session_timeout`, лимиты на роль (`ALTER ROLE app CONNECTION LIMIT 100`). `superuser_reserved_connections` оставляет администратору возможность войти.

## [high] Лаг репликации растёт
**Диагностика:** `pg_stat_replication` (sent/write/flush/replay lsn), на реплике `now() - pg_last_xact_replay_timestamp()`, сеть и диск реплики (`iostat`), конфликты hot standby в логах.

**Причины:** реплика не успевает применять WAL (слабый диск/CPU, однопоточное применение), массовые операции на primary (большие UPDATE/миграции, VACUUM FULL, CREATE INDEX), сеть, долгие запросы на реплике с `hot_standby_feedback`/`max_standby_streaming_delay`.

**Решение:** реплика того же класса железа, массовые операции батчами, мониторинг лага с алертом, приложение должно учитывать лаг при чтении с реплик.

## [critical] Диск заполнен WAL-файлами
**Диагностика:**
```bash
du -sh $PGDATA/pg_wal
```
```sql
SELECT slot_name, active, pg_size_pretty(pg_wal_lsn_diff(pg_current_wal_lsn(), restart_lsn)) FROM pg_replication_slots;
SELECT * FROM pg_stat_archiver;    -- failed_count, last_failed_wal
```
**Решение:** удалить неиспользуемый слот (`SELECT pg_drop_replication_slot('old_slot')`), починить `archive_command` (права, место в хранилище, креды S3). **Никогда не удалять файлы из pg_wal вручную** — это повреждение БД. На будущее: `max_slot_wal_keep_size`, алерты на размер pg_wal и ошибки архивации.

## [high] Запросы зависли: блокировки
**Симптомы:** растёт число активных соединений, запросы в `wait_event_type = Lock`, приложение тайм-аутится. Часто после миграции (`ALTER TABLE` ждёт эксклюзивную блокировку за долгим запросом, а все новые запросы встают в очередь за ним).

**Диагностика и решение:**
```sql
SELECT pid, pg_blocking_pids(pid), wait_event, now()-query_start AS dur, left(query,80)
FROM pg_stat_activity WHERE wait_event_type = 'Lock';
SELECT pg_terminate_backend(<блокирующий pid>);
```
Профилактика: `SET lock_timeout = '5s'` в миграциях (лучше упасть и повторить), `CREATE INDEX CONCURRENTLY`, добавление колонок без перезаписи таблицы, `statement_timeout`, `idle_in_transaction_session_timeout`.

## [high] Таблицы раздулись, запросы медленные (bloat)
**Диагностика:** `n_dead_tup` в `pg_stat_user_tables`, `last_autovacuum` давно, долгие транзакции (`xact_start` в `pg_stat_activity`), заброшенные prepared transactions, слоты логической репликации.

**Решение:** найти и завершить долгую транзакцию, мешающую VACUUM; настроить autovacuum агрессивнее для горячих таблиц (`autovacuum_vacuum_scale_factor` на таблицу); `pg_repack` для онлайн-уменьшения.

## [high] Redis: OOM command not allowed / рост памяти
**Диагностика:** `INFO memory` (used_memory vs maxmemory, фрагментация), `INFO keyspace`, `--bigkeys`, ключи без TTL.

**Решение:** правильная `maxmemory-policy` для кэша (`allkeys-lru`), TTL на ключи, удалить большие ключи (`UNLINK` — асинхронно), `activedefrag yes` при высокой фрагментации, увеличить память. Если Redis — не кэш, а хранилище: масштабирование (Cluster), а не вытеснение.

## [high] Kafka: consumer lag растёт
**Диагностика:**
```bash
kafka-consumer-groups.sh --bootstrap-server kafka:9092 --describe --group orders
```
Смотреть LAG по партициям: равномерно (не хватает мощности) или в одной (горячий ключ/зависший consumer); частые rebalance в логах (consumer не успевает за `max.poll.interval.ms`).

**Решение:** масштабировать consumers до числа партиций, увеличить партиции, ускорить обработку, уменьшить `max.poll.records` или увеличить `max.poll.interval.ms`, cooperative rebalancing, исправить перекос ключей.

# @quiz

? Какой уровень изоляции по умолчанию в PostgreSQL?
- Read Uncommitted
+ Read Committed
- Repeatable Read
- Serializable
> В MySQL InnoDB по умолчанию Repeatable Read.

? Что делает обычный VACUUM в PostgreSQL?
- Возвращает место ОС и блокирует таблицу
+ Помечает место мёртвых строк для переиспользования без эксклюзивной блокировки
- Удаляет индексы
- Перестраивает статистику только
> Место ОС возвращает VACUUM FULL (с блокировкой) или pg_repack.

? Неактивный replication slot приводит к:
- Ускорению записи
+ Бесконечному росту pg_wal
- Остановке реплики
- Потере данных на primary
> Primary хранит WAL, пока слот его не подтвердит.

? Что определяет RPO?
+ Допустимую потерю данных
- Допустимое время простоя
- Количество реплик
- Скорость бэкапа
> RTO — время восстановления.

? Какой режим PgBouncer наиболее экономно использует серверные соединения, сохраняя транзакции?
- session
+ transaction
- statement
- pooled
> statement не допускает многооператорных транзакций.

? Какая политика Redis подходит для чистого кэша?
- noeviction
+ allkeys-lru
- volatile-ttl
- none
> Вытесняет наименее используемые ключи среди всех.

? Максимальное число активных consumers в группе Kafka для топика с 6 партициями:
- 3
+ 6
- 12
- без ограничений
> Лишние consumers будут простаивать.

? Как безопасно найти ключи по шаблону в продовом Redis?
- KEYS session:*
+ SCAN с MATCH
- FLUSHALL
- MONITOR
> KEYS блокирует однопоточный Redis на время обхода.
