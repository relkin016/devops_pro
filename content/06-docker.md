---
id: docker
title: Docker и контейнеры
icon: 🐳
order: 60
group: Контейнеры и доставка
color: #2496ed
summary: Образы и слои, Dockerfile и multi-stage, сети, volumes, Compose, безопасность, рантаймы (containerd, runc), оптимизация и отладка контейнеров.
---

# @theory

## Что такое контейнер

Контейнер — **обычный процесс Linux**, который:
- изолирован **namespaces** (свои PID, сеть, mount, hostname, IPC, user);
- ограничен **cgroups** (CPU, память, PIDs, I/O);
- работает на корневой ФС из **слоёв образа** (overlayfs);
- лишён лишних **capabilities**, ограничен **seccomp** и AppArmor/SELinux.

Ядро у всех контейнеров — общее с хостом. Поэтому контейнер стартует за миллисекунды, но не может запустить другое ядро (Linux-контейнер на Windows/macOS работает внутри скрытой ВМ).

| | Контейнер | Виртуальная машина |
|---|---|---|
| Изоляция | namespaces/cgroups, общее ядро | гипервизор, своё ядро |
| Старт | мс–секунды | десятки секунд |
| Размер | МБ | ГБ |
| Плотность | сотни на хост | десятки |
| Безопасность | слабее (общее ядро) | сильнее |

Для сильной изоляции контейнеров есть **gVisor** (ядро в user space), **Kata Containers** / **Firecracker** (микро-ВМ).

### Архитектура Docker
```text
docker CLI ──REST API──▶ dockerd ──gRPC──▶ containerd ──▶ containerd-shim ──▶ runc ──▶ процесс контейнера
```
- **dockerd** — демон Docker: API, сборка (BuildKit), сети, volumes.
- **containerd** — управление жизненным циклом контейнеров и образов (используется и Kubernetes напрямую).
- **runc** — низкоуровневый рантайм по стандарту **OCI**: создаёт namespaces/cgroups и запускает процесс.
- **shim** — позволяет перезапускать dockerd/containerd без остановки контейнеров.

Альтернативы: **Podman** (без демона, rootless, совместимый CLI), **Buildah**/**Kaniko**/**BuildKit** (сборка), **CRI-O** (рантайм для K8s), **nerdctl** (CLI для containerd).

## Образы и слои

Образ — набор **read-only слоёв** (каждый — diff файловой системы) + конфиг (CMD, ENV, порты...). При запуске сверху добавляется тонкий **writable-слой** контейнера (copy-on-write). Удалили контейнер — writable-слой пропал.

- Каждая инструкция `RUN`, `COPY`, `ADD` создаёт слой.
- Слои **кэшируются** и разделяются между образами: 10 образов на `python:3.12-slim` хранят базу один раз.
- Удаление файла в следующем слое **не уменьшает образ** — файл остаётся в нижнем слое.
- Образ адресуется по **digest** (`sha256:...`) — неизменяемый; **тег** (`:1.4`, `:latest`) — изменяемый указатель.

```bash
docker image ls; docker image inspect nginx:1.27
docker history --no-trunc myapp:1.0         # слои и их размер
docker pull nginx@sha256:…                   # по digest — неизменяемо
dive myapp:1.0                               # анализ слоёв (сторонняя утилита)
docker save -o img.tar myapp:1.0; docker load -i img.tar
docker tag myapp:1.0 registry.local/team/myapp:1.0 && docker push registry.local/team/myapp:1.0
```

> [!warn] Не используйте :latest в production
> Это просто тег «по умолчанию», а не «последняя версия». Он не даёт воспроизводимости и отката. Используйте неизменяемые теги (`1.4.2`, git SHA) и в идеале — digest.

## Dockerfile: инструкции

```dockerfile Dockerfile
# syntax=docker/dockerfile:1.7
FROM python:3.12-slim AS base
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1
WORKDIR /app

# Зависимости отдельно от кода — кэш слоя не сбрасывается при изменении кода
COPY requirements.txt .
RUN --mount=type=cache,target=/root/.cache/pip pip install -r requirements.txt

COPY . .
RUN useradd -r -u 10001 app && chown -R app /app
USER 10001
EXPOSE 8000
HEALTHCHECK --interval=30s --timeout=3s CMD python -c "import urllib.request;urllib.request.urlopen('http://localhost:8000/health')"
ENTRYPOINT ["gunicorn", "-b", "0.0.0.0:8000"]
CMD ["app:app", "--workers", "4"]
```

| Инструкция | Назначение |
|---|---|
| `FROM` | базовый образ (можно несколько — multi-stage) |
| `RUN` | выполнить команду при сборке → новый слой |
| `COPY` | скопировать файлы из контекста |
| `ADD` | как COPY + распаковка tar и загрузка URL (лучше избегать) |
| `ENV` | переменная окружения (есть и при сборке, и при запуске) |
| `ARG` | переменная только на время сборки (`--build-arg`) |
| `WORKDIR` | рабочий каталог |
| `USER` | от кого запускать |
| `EXPOSE` | документирует порт (ничего не публикует!) |
| `VOLUME` | точка монтирования тома |
| `ENTRYPOINT` | исполняемый файл контейнера |
| `CMD` | аргументы по умолчанию (или команда, если нет ENTRYPOINT) |
| `HEALTHCHECK` | проверка здоровья |
| `LABEL` | метаданные (OCI labels) |
| `STOPSIGNAL` | сигнал остановки |

### ENTRYPOINT vs CMD
- `CMD` легко переопределить: `docker run img other-cmd`.
- `ENTRYPOINT` — «что запускается», `CMD` — «аргументы по умолчанию». `docker run img --debug` подставит `--debug` вместо CMD.
- **exec-форма** `["bin", "arg"]` — процесс запускается напрямую и становится PID 1, получает сигналы. **shell-форма** `CMD bin arg` — запускается `/bin/sh -c`, сигнал SIGTERM получит sh, а не приложение → контейнер убьют по таймауту через 10 с.

### Порядок слоёв и кэш
Кэш инвалидируется на первой изменившейся инструкции и **всех после неё**. Поэтому: редко меняющееся — выше (системные пакеты, зависимости), часто меняющееся — ниже (код).

### .dockerignore
```text .dockerignore
.git
node_modules
**/*.log
.env
Dockerfile
docker-compose*.yml
```
Уменьшает контекст сборки (быстрее) и не даёт утечь `.git` и секретам в образ.

## Multi-stage сборка и минимальные образы

```dockerfile Dockerfile (Go)
FROM golang:1.23 AS build
WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download
COPY . .
RUN CGO_ENABLED=0 go build -ldflags="-s -w" -o /out/api ./cmd/api

FROM gcr.io/distroless/static-debian12:nonroot
COPY --from=build /out/api /api
USER nonroot
ENTRYPOINT ["/api"]
```
Итог: образ ~10 МБ без компилятора, shell и пакетного менеджера.

```dockerfile Dockerfile (Node)
FROM node:22-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build

FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY --from=deps /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
USER node
CMD ["node", "dist/server.js"]
```

### Базовые образы
| Образ | Размер | Особенности |
|---|---|---|
| `ubuntu`, `debian` | 30–80 МБ | привычно, glibc, много пакетов |
| `*-slim` | 30–50 МБ | урезанный Debian — хороший дефолт |
| `alpine` | ~5 МБ | **musl** вместо glibc (бывают проблемы с DNS, Python wheels, производительностью) |
| `distroless` | 2–20 МБ | только рантайм, нет shell — безопасно, отлаживать через `kubectl debug` |
| `scratch` | 0 | пустой, для статических бинарников |
| Chainguard/Wolfi | малый | минимальные, часто обновляемые, мало CVE |

### Как уменьшить образ
- multi-stage, минимальная база;
- объединять `RUN` и чистить кэш в **той же** инструкции: `apt-get update && apt-get install -y --no-install-recommends x && rm -rf /var/lib/apt/lists/*`;
- `.dockerignore`; не копировать лишнее;
- BuildKit `--mount=type=cache` для кэша пакетных менеджеров (не попадает в слой).

### Секреты при сборке
Никогда `ARG TOKEN` / `ENV PASSWORD` — останутся в `docker history`. Правильно:
```dockerfile
RUN --mount=type=secret,id=npmrc,target=/root/.npmrc npm ci
```
`docker build --secret id=npmrc,src=$HOME/.npmrc .`

## Запуск и управление контейнерами

```bash
docker run -d --name web -p 8080:80 --restart unless-stopped nginx:1.27
docker run --rm -it --entrypoint sh alpine        # одноразовый интерактивный
docker run -e ENV=prod --env-file .env -v data:/var/lib/data -w /app img
docker run --memory 512m --cpus 1.5 --pids-limit 200 img
docker run --read-only --tmpfs /tmp --cap-drop ALL --cap-add NET_BIND_SERVICE --security-opt no-new-privileges img
docker ps -a; docker ps --format 'table {{.Names}}\t{{.Status}}\t{{.Ports}}'
docker logs -f --tail 100 --since 10m web
docker exec -it web sh
docker inspect web | jq '.[0].State, .[0].NetworkSettings.Networks'
docker inspect -f '{{.State.ExitCode}} {{.State.OOMKilled}}' web
docker stats --no-stream
docker top web
docker cp web:/etc/nginx/nginx.conf .
docker stop -t 30 web        # SIGTERM, через 30 с — SIGKILL
docker kill -s HUP web
docker rm -f web
docker events --since 1h
docker system df; docker system prune -a --volumes   # очистка (осторожно)
```

### Restart policies
`no` (по умолчанию), `on-failure[:N]`, `always`, `unless-stopped`.

### Коды выхода
| Код | Смысл |
|---|---|
| 0 | нормальное завершение |
| 1 | ошибка приложения |
| 125 | ошибка самого docker run (флаги) |
| 126 | команда не исполняемая |
| 127 | команда не найдена |
| 137 | SIGKILL (128+9) — OOM или `docker kill`/таймаут stop |
| 139 | SIGSEGV — segfault |
| 143 | SIGTERM (128+15) — штатная остановка |

## Сети Docker

| Драйвер | Описание |
|---|---|
| **bridge** (default) | виртуальный мост `docker0`, контейнеры получают IP из 172.17.0.0/16, выход наружу — через NAT (MASQUERADE), публикация портов — через DNAT/docker-proxy |
| **user-defined bridge** | то же, но с **встроенным DNS** (контейнеры видят друг друга по имени) и лучшей изоляцией — используйте его, а не default |
| **host** | контейнер в сетевом namespace хоста, без изоляции и NAT, максимальная производительность |
| **none** | только loopback |
| **overlay** | сеть между хостами (Swarm), VXLAN |
| **macvlan / ipvlan** | контейнер получает свой MAC/IP в физической сети |

```bash
docker network create app-net
docker run -d --name db --network app-net postgres:16
docker run -d --name api --network app-net -e DB_HOST=db myapi   # имя "db" резолвится встроенным DNS (127.0.0.11)
docker network inspect app-net
docker run -p 127.0.0.1:5432:5432 postgres     # опубликовать только на localhost
```

> [!danger] Docker обходит UFW/firewalld
> Публикация порта `-p 5432:5432` добавляет правила DNAT в iptables (цепочка `DOCKER`) **до** правил UFW. Порт окажется открыт в интернет, даже если UFW его «закрывает». Публикуйте на `127.0.0.1:` или используйте цепочку `DOCKER-USER` для фильтрации.

## Хранение данных: volumes и bind mounts

| Тип | Синтаксис | Где данные | Когда |
|---|---|---|---|
| **Named volume** | `-v pgdata:/var/lib/postgresql/data` | `/var/lib/docker/volumes/` (управляет Docker) | данные БД, всё persistent |
| **Bind mount** | `-v /srv/conf:/etc/app:ro` | любой путь хоста | конфиги, разработка (hot reload) |
| **tmpfs** | `--tmpfs /tmp` | память | временные/секретные данные |

```bash
docker volume ls; docker volume inspect pgdata
# Бэкап тома
docker run --rm -v pgdata:/data -v $PWD:/backup alpine tar czf /backup/pgdata.tgz -C /data .
```

> [!warn] Права в bind mounts
> UID внутри контейнера = UID на хосте (если нет user namespaces). Контейнер с `USER 10001` не сможет писать в каталог хоста, принадлежащий `1000`. Решения: `chown 10001` на хосте, `--user $(id -u):$(id -g)`, init-контейнер, userns-remap.

## Docker Compose

```yaml compose.yaml
services:
  db:
    image: postgres:16
    environment:
      POSTGRES_PASSWORD_FILE: /run/secrets/db_password
    volumes:
      - pgdata:/var/lib/postgresql/data
    secrets: [db_password]
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U postgres"]
      interval: 5s
      retries: 10

  api:
    build:
      context: .
      target: runtime
    image: registry.local/api:${TAG:-dev}
    env_file: .env
    depends_on:
      db:
        condition: service_healthy     # ждать именно готовности, а не старта
    ports:
      - "127.0.0.1:8000:8000"
    deploy:
      resources:
        limits: { cpus: "1.0", memory: 512M }
    restart: unless-stopped

  nginx:
    image: nginx:1.27-alpine
    volumes:
      - ./nginx.conf:/etc/nginx/conf.d/default.conf:ro
    ports: ["80:80"]
    depends_on: [api]

volumes:
  pgdata:

secrets:
  db_password:
    file: ./secrets/db_password.txt
```

```bash
docker compose up -d --build
docker compose ps; docker compose logs -f api
docker compose exec db psql -U postgres
docker compose config            # итоговая конфигурация с подставленными переменными
docker compose down              # -v удалит и volumes!
docker compose -f compose.yaml -f compose.prod.yaml up -d   # override-файлы
docker compose --profile debug up
```

Compose — для локальной разработки, CI и простых одно-серверных инсталляций. Для кластера — Kubernetes (или Swarm/Nomad).

## Безопасность контейнеров

1. **Не root внутри**: `USER 10001`. Root в контейнере = root на хосте при побеге (без user namespaces).
2. **Минимальный образ** (distroless/slim), меньше пакетов — меньше CVE.
3. **Сканирование** образов: Trivy, Grype, Docker Scout — в CI, блокировать critical.
4. **Подпись и происхождение**: cosign (Sigstore), SBOM (syft), проверка подписи при деплое (Kyverno/Connaisseur).
5. **Без лишних привилегий**: никогда `--privileged` без крайней нужды, `--cap-drop ALL`, `no-new-privileges`, `--read-only`.
6. **Не монтировать docker.sock** в контейнеры — это root-доступ к хосту.
7. **Не открывать Docker API (2375)** наружу — мгновенный взлом майнерами.
8. **Секреты** не в образе и не в ENV (видны в `inspect`), а через secrets/файлы/Vault.
9. **Rootless Docker / Podman**, user namespaces (`userns-remap`).
10. Обновлять базовые образы регулярно (Renovate/Dependabot), пересобирать.

```bash
trivy image --severity HIGH,CRITICAL --exit-code 1 myapp:1.0
hadolint Dockerfile                 # линтер Dockerfile
docker scout cves myapp:1.0
cosign sign registry/app@sha256:…; cosign verify …
```

## Настройка демона и логи

```json /etc/docker/daemon.json
{
  "log-driver": "json-file",
  "log-opts": { "max-size": "50m", "max-file": "3" },
  "live-restore": true,
  "default-address-pools": [{ "base": "10.201.0.0/16", "size": 24 }],
  "registry-mirrors": ["https://mirror.local"],
  "data-root": "/data/docker",
  "features": { "buildkit": true }
}
```
- **Без лимитов json-file** логи контейнеров растут бесконечно и заполняют диск.
- `live-restore` — контейнеры продолжают работать при рестарте dockerd.
- Логи контейнера — то, что приложение пишет в **stdout/stderr**. Не пишите логи в файлы внутри контейнера.
- Драйверы: `json-file`, `local`, `journald`, `syslog`, `fluentd`, `awslogs`, `gelf`.

## Отладка контейнеров

```bash
docker logs --tail 200 app                    # почему упал
docker inspect app --format '{{json .State}}' | jq
docker run -it --entrypoint sh myimage        # зайти в образ, не запуская приложение
docker exec -it app sh                        # в живой контейнер
# В distroless нет shell — подключиться отладочным контейнером к namespaces:
docker run -it --rm --pid=container:app --network=container:app nicolaka/netshoot
# Сетевой namespace контейнера с хоста:
PID=$(docker inspect -f '{{.State.Pid}}' app); nsenter -t $PID -n ss -tlpn
docker diff app                               # что изменилось в файловой системе контейнера
docker stats
docker build --progress=plain --no-cache .    # подробный вывод сборки
```

# @interview

## [junior] Чем контейнер отличается от виртуальной машины?
Контейнер — изолированный процесс на общем ядре хоста (namespaces + cgroups), лёгкий и быстрый. ВМ эмулирует железо через гипервизор и имеет собственное ядро — изоляция сильнее, но тяжелее по ресурсам и времени старта.

## [junior] Чем образ отличается от контейнера?
Образ — неизменяемый шаблон из read-only слоёв и метаданных. Контейнер — запущенный (или остановленный) экземпляр образа с собственным writable-слоем, сетевыми настройками и состоянием.

## [junior] Чем CMD отличается от ENTRYPOINT?
ENTRYPOINT задаёт исполняемый файл контейнера, CMD — аргументы по умолчанию (или команду, если ENTRYPOINT нет). Аргументы `docker run img args` заменяют CMD. ENTRYPOINT переопределяется только `--entrypoint`. Типичный паттерн: `ENTRYPOINT ["app"]`, `CMD ["--help"]`.

## [middle] Чем exec-форма отличается от shell-формы в CMD и почему это важно?
Exec-форма (`["nginx","-g","daemon off;"]`) запускает процесс напрямую — он PID 1 и получает сигналы. Shell-форма оборачивает в `/bin/sh -c`, PID 1 становится shell, который не пробрасывает SIGTERM → graceful shutdown не работает, контейнер убивается SIGKILL после таймаута.

## [junior] Чем COPY отличается от ADD?
COPY просто копирует файлы из контекста. ADD дополнительно распаковывает локальные tar-архивы и умеет скачивать URL. Рекомендуется COPY — поведение предсказуемо; для скачивания — `RUN curl` с проверкой хэша или `ADD --checksum`.

## [middle] Как уменьшить размер образа?
Multi-stage сборка (в финальный образ только артефакт), минимальная база (slim/distroless/alpine/scratch), объединение RUN с очисткой кэшей в одном слое, `--no-install-recommends`, `.dockerignore`, не копировать лишнее, кэш пакетных менеджеров через `--mount=type=cache`.

## [middle] Как работает кэш слоёв при сборке? Как его правильно использовать?
Docker проверяет для каждой инструкции, есть ли слой с той же родительской цепочкой и тем же содержимым (для COPY — хэш файлов). При первом промахе все последующие инструкции пересобираются. Поэтому копируем сначала файлы зависимостей (`package.json`, `go.mod`) и ставим зависимости, а исходники — потом. В CI — `--cache-from`/`--cache-to` (registry cache).

## [middle] Что такое multi-stage build?
Dockerfile с несколькими `FROM`; ранние стадии собирают артефакты (компилятор, dev-зависимости), финальная копирует только результат через `COPY --from=stage`. Итоговый образ маленький и без инструментов сборки — меньше поверхность атаки.

## [middle] Какие сетевые драйверы есть в Docker?
bridge (по умолчанию, NAT), user-defined bridge (с DNS по именам), host (сеть хоста), none, overlay (между хостами), macvlan/ipvlan (свой адрес в физической сети). Контейнеры в одной user-defined сети находят друг друга по имени через встроенный DNS 127.0.0.11.

## [middle] Чем volume отличается от bind mount?
Volume управляется Docker (хранится в `/var/lib/docker/volumes`), переносим, удобен для данных, есть драйверы (NFS, облака). Bind mount — произвольный путь хоста, зависит от структуры хоста, удобен для конфигов и разработки. tmpfs — в памяти.

## [middle] Контейнер завершается с кодом 137. Что это значит?
128 + 9 = SIGKILL. Чаще всего OOM — превышен лимит памяти (`docker inspect` → `OOMKilled: true`, `dmesg`). Либо контейнер не завершился за таймаут после SIGTERM при `docker stop` и был убит, либо `docker kill`.

## [middle] Как передать секреты в контейнер правильно?
Не в образ (слои и history), не через ARG/ENV в Dockerfile. Варианты: Docker/Compose secrets (файлы в `/run/secrets`), монтирование файла, переменные окружения в рантайме (хуже — видны в `inspect` и `/proc`), внешние хранилища (Vault, AWS Secrets Manager) с получением при старте. При сборке — `RUN --mount=type=secret`.

## [middle] Почему не стоит запускать процессы в контейнере от root?
Root в контейнере — это UID 0 на хосте (без user namespaces). При уязвимости рантайма/ядра или неправильной конфигурации (privileged, docker.sock, hostPath) атакующий получает root на хосте. Плюс root может менять файлы в смонтированных томах.

## [senior] Что такое PID 1 problem в контейнерах?
Процесс с PID 1 в namespace особенный: ядро не применяет к нему действия сигналов по умолчанию (SIGTERM без обработчика игнорируется), и он отвечает за сбор зомби-процессов. Приложение, не рассчитанное быть init, не завершится по SIGTERM и будет копить зомби. Решения: обрабатывать сигналы в приложении, `exec` в entrypoint-скриптах, лёгкий init (`tini`, `dumb-init`, `docker run --init`).

## [senior] Что такое OCI, containerd, runc, CRI?
OCI — стандарты формата образа, рантайма и дистрибуции. runc — эталонная реализация OCI runtime (создаёт контейнер по bundle). containerd — демон, управляющий образами и жизненным циклом контейнеров поверх runc. CRI — gRPC-интерфейс kubelet для рантаймов (containerd, CRI-O). Docker использует containerd внутри; Kubernetes с 1.24 работает с containerd/CRI-O напрямую, без dockershim — при этом Docker-образы продолжают работать, т.к. это OCI-образы.

## [middle] Чем Docker отличается от Podman?
Podman не имеет центрального демона (каждый контейнер — дочерний процесс через conmon), изначально rootless, умеет поды и генерацию systemd-юнитов/Quadlet и K8s YAML. CLI совместим с Docker. Docker — демон-ориентированный, с богатой экосистемой (Compose, Desktop).

## [middle] Как ограничить ресурсы контейнера и что будет при превышении?
`--memory` (при превышении — OOM kill внутри cgroup), `--cpus`/`--cpu-quota` (при превышении — throttling, не убийство), `--pids-limit` (ошибка fork), `--blkio-weight`/`--device-read-bps`. В Compose — `deploy.resources.limits`.

## [middle] Чем опасно монтирование /var/run/docker.sock в контейнер?
Доступ к сокету = полный доступ к Docker API = возможность запустить privileged-контейнер с монтированием `/` хоста, т.е. root на хосте. Для CI-сборок лучше использовать Kaniko, BuildKit rootless, Buildah или DinD в изолированных раннерах.

## [junior] Что делает EXPOSE?
Только документирует, на каком порту слушает приложение (метаданные образа). Порт публикуется на хост лишь через `-p`/`-P` при запуске.

## [senior] Как сделать сборку образов в CI быстрой?
BuildKit, правильный порядок слоёв, `.dockerignore`, удалённый кэш (`--cache-to type=registry,mode=max`, `--cache-from`), `--mount=type=cache` для пакетных менеджеров, multi-stage с параллельными стадиями, предсобранные базовые образы с зависимостями, локальные зеркала реестров, buildx bake для множества образов, сборка только изменённых сервисов в монорепо.

# @troubleshooting

## [high] Контейнер сразу завершается (Exited (0) / Exited (1))
**Диагностика:**
```bash
docker ps -a --filter name=app
docker logs app
docker inspect app --format '{{.State.ExitCode}} {{.State.Error}} OOM={{.State.OOMKilled}}'
docker run -it --entrypoint sh image      # посмотреть, что внутри, запустить руками
```
**Причины:**
- **Exited (0)** — главный процесс просто завершился: запустили демона в фоновом режиме (`nginx` без `daemon off;`, `service x start`), CMD — скрипт без долгоживущего процесса. Процесс в контейнере должен работать на переднем плане.
- **Exited (1)** — ошибка приложения: нет конфига/переменной, нет доступа к БД при старте.
- **127** — нет бинарника (опечатка, другой WORKDIR, бинарник собран под glibc, а образ alpine — тогда «not found» даже когда файл существует).
- **126 / permission denied** — нет `+x` у entrypoint-скрипта, CRLF в шебанге.
- **exec format error** — образ собран под другую архитектуру (arm64 на amd64): `docker buildx build --platform linux/amd64,linux/arm64`.

## [high] Контейнер убит OOM (exit 137)
**Диагностика:** `docker inspect -f '{{.State.OOMKilled}}' app`, `docker stats`, `dmesg -T | grep -i oom`.

**Решение:** увеличить `--memory` или снизить потребление; для JVM — `-XX:MaxRAMPercentage=75` (JVM ≥ 10 понимает лимиты cgroup), для Node — `--max-old-space-size`; проверить утечки.

## [critical] Docker заполнил диск
**Диагностика:**
```bash
docker system df -v
du -sh /var/lib/docker/*
find /var/lib/docker/containers -name "*-json.log" -size +100M -exec ls -lh {} \;
```
**Причины:** логи контейнеров без ротации, висячие образы после каждой сборки, остановленные контейнеры, неиспользуемые volumes, кэш сборки BuildKit.

**Решение:**
```bash
docker container prune; docker image prune -a --filter "until=168h"
docker builder prune --keep-storage 20GB
docker volume prune                         # осторожно с данными
truncate -s 0 /var/lib/docker/containers/<id>/<id>-json.log
```
Постоянно: `log-opts max-size/max-file` в daemon.json (применится к новым контейнерам), cron/systemd timer на prune, вынести `data-root` на отдельный диск.

## [high] Контейнеры не видят друг друга по имени
**Причины:** контейнеры в default bridge (там нет DNS по именам), в разных сетях, или приложение обращается к `localhost` (внутри контейнера localhost — это сам контейнер!).

**Решение:** создать user-defined сеть (`docker network create`) или использовать Compose (создаёт сеть автоматически), обращаться по имени сервиса (`db:5432`), проверить `docker network inspect`. Из контейнера к сервису на хосте — `host.docker.internal` (на Linux: `--add-host=host.docker.internal:host-gateway`).

## [high] Порт опубликован, но снаружи не открывается
**Диагностика:**
```bash
docker port app
docker exec app ss -tlpn         # или netstat; слушает ли 0.0.0.0, а не 127.0.0.1
curl -v localhost:8080           # с хоста
iptables -t nat -L DOCKER -n
```
**Причины:** приложение внутри слушает `127.0.0.1` (нужно `0.0.0.0`), перепутаны порты в `-p host:container`, облачный файрвол/SG, `net.ipv4.ip_forward=0`, сломаны iptables-правила после рестарта файрвола (`systemctl restart docker` восстановит).

## [medium] Permission denied при записи в volume
**Причина:** UID процесса в контейнере не совпадает с владельцем каталога на хосте (bind mount), или SELinux.

**Решение:** `ls -ln /host/path` vs `docker exec app id`; `chown -R 10001:10001 /host/path`; `--user`; для SELinux — суффикс `:z`/`:Z` в `-v /path:/data:Z`.

## [medium] Сборка не видит изменений / наоборот всё пересобирается
**Причины:** кэш слоя `RUN apt-get update` устарел (кэш по тексту команды), `COPY . .` в начале Dockerfile инвалидирует всё, в контекст попадают меняющиеся файлы (`.git`, логи) — нет `.dockerignore`.

**Решение:** правильный порядок инструкций, `.dockerignore`, `--no-cache` для форсированной пересборки, `--pull` для обновления базы.

## [medium] toomanyrequests: Docker Hub rate limit
**Причина:** анонимный pull ограничен (по IP), в CI с NAT все раннеры выглядят одним IP.

**Решение:** логин в Docker Hub (`docker login`), pull-through cache/зеркало (Harbor, Nexus, `registry:2` как proxy, ECR pull-through), копирование образов в свой реестр.

# @quiz

? Что делает инструкция EXPOSE?
- Публикует порт на хост
+ Документирует порт в метаданных образа
- Открывает порт в файрволе
- Пробрасывает порт в другую сеть
> Публикация — только через -p/-P.

? Почему важна exec-форма CMD ["app"]?
- Она быстрее собирается
+ Приложение становится PID 1 и получает сигналы напрямую
- Она позволяет использовать переменные окружения
- Она обязательна для multi-stage
> В shell-форме PID 1 — /bin/sh, который не пробрасывает SIGTERM.

? Вы удалили большой файл отдельной инструкцией RUN rm. Размер образа:
- Уменьшится
+ Не уменьшится — файл остался в предыдущем слое
- Станет нулевым
- Сборка упадёт
> Удалять нужно в той же инструкции, где файл был создан.

? Как контейнеры в одной user-defined bridge сети находят друг друга?
- Через /etc/hosts хоста
+ Через встроенный DNS Docker по имени контейнера/сервиса
- Только по IP
- Через mDNS
> Встроенный DNS 127.0.0.11 работает в user-defined сетях.

? Какой код выхода у контейнера, убитого OOM?
- 1
- 139
+ 137
- 143
> 128 + 9 (SIGKILL).

? Что из этого компонент, который непосредственно создаёт namespaces и cgroups для контейнера?
- dockerd
- containerd
+ runc
- docker CLI
> runc — низкоуровневый OCI runtime.

? Почему опубликованный порт Docker доступен из интернета, хотя UFW его блокирует?
+ Docker добавляет NAT-правила в iptables, которые срабатывают раньше правил UFW
- UFW не умеет блокировать TCP
- Docker отключает UFW
- Это баг ядра
> Используйте публикацию на 127.0.0.1 или цепочку DOCKER-USER.

? Как правильно передать токен для приватного npm-реестра при сборке?
- ARG NPM_TOKEN
- ENV NPM_TOKEN
+ RUN --mount=type=secret
- COPY .npmrc и удалить в конце
> secret-mount не попадает в слои и историю образа.

? `depends_on` с `condition: service_healthy` в Compose:
- Ждёт только запуска контейнера
+ Ждёт, пока healthcheck зависимости станет healthy
- Перезапускает сервис при падении зависимости
- Ничего не делает
> Без condition depends_on гарантирует только порядок старта.
