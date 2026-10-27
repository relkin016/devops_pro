---
id: helm
title: Helm, Kustomize, GitOps
icon: ⎈
order: 80
group: Оркестрация и IaC
color: #0f1689
summary: Шаблонизация манифестов (Helm, Kustomize), релизы и откаты, Argo CD и Flux, структура GitOps-репозиториев, управление секретами.
---

# @theory

## Helm: основы

Helm — пакетный менеджер Kubernetes. **Chart** — пакет шаблонов манифестов + значения по умолчанию. **Release** — установленный экземпляр чарта в кластере (у одного чарта может быть много релизов). **Repository** — хранилище чартов (HTTP или OCI-реестр).

```text Структура чарта
mychart/
├── Chart.yaml          # имя, версия чарта, appVersion, зависимости
├── values.yaml         # значения по умолчанию
├── values.schema.json  # (опц.) JSON-схема для валидации values
├── templates/
│   ├── _helpers.tpl    # именованные шаблоны (define)
│   ├── deployment.yaml
│   ├── service.yaml
│   ├── ingress.yaml
│   ├── NOTES.txt       # выводится после установки
│   └── tests/
└── charts/             # зависимости (subcharts)
```

```bash
helm repo add bitnami https://charts.bitnami.com/bitnami && helm repo update
helm search repo postgres
helm show values bitnami/postgresql > values.yaml
helm install pg bitnami/postgresql -n db --create-namespace -f values.yaml --set auth.database=app
helm upgrade --install api ./chart -n api -f values-prod.yaml --atomic --timeout 5m --wait
helm list -A
helm history api -n api
helm rollback api 3 -n api
helm uninstall api -n api
helm get values api -n api --all; helm get manifest api -n api
helm template api ./chart -f values-prod.yaml > rendered.yaml     # рендер без установки
helm lint ./chart
helm diff upgrade api ./chart -f values-prod.yaml                  # плагин helm-diff
helm package ./chart; helm push mychart-1.2.0.tgz oci://registry.local/charts
helm dependency update ./chart
```

Helm 3 не имеет серверного компонента (Tiller удалён), состояние релиза хранится в **Secret** в namespace релиза (`sh.helm.release.v1.api.v5`).

## Шаблоны Helm

```yaml templates/deployment.yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: {{ include "mychart.fullname" . }}
  labels:
    {{- include "mychart.labels" . | nindent 4 }}
spec:
  {{- if not .Values.autoscaling.enabled }}
  replicas: {{ .Values.replicaCount }}
  {{- end }}
  selector:
    matchLabels:
      {{- include "mychart.selectorLabels" . | nindent 6 }}
  template:
    metadata:
      annotations:
        checksum/config: {{ include (print $.Template.BasePath "/configmap.yaml") . | sha256sum }}
      labels:
        {{- include "mychart.selectorLabels" . | nindent 8 }}
    spec:
      containers:
        - name: app
          image: "{{ .Values.image.repository }}:{{ .Values.image.tag | default .Chart.AppVersion }}"
          {{- with .Values.env }}
          env:
            {{- range $k, $v := . }}
            - name: {{ $k }}
              value: {{ $v | quote }}
            {{- end }}
          {{- end }}
          resources:
            {{- toYaml .Values.resources | nindent 12 }}
```

| Конструкция | Что делает |
|---|---|
| `.Values`, `.Chart`, `.Release`, `.Capabilities` | встроенные объекты |
| `{{- ... -}}` | обрезать пробелы/переводы строк слева/справа |
| `include "name" .` + `nindent N` | вставить именованный шаблон с отступом |
| `toYaml` | сериализовать структуру |
| `default`, `required "msg"`, `quote`, `tpl` | функции Sprig |
| `if / else`, `with`, `range` | управление |
| `lookup` | прочитать существующий объект из кластера |
| `checksum/config` аннотация | перезапуск подов при изменении конфига |

**Hooks**: `helm.sh/hook: pre-install,pre-upgrade` — например, Job миграции БД перед обновлением; `hook-weight`, `hook-delete-policy`.

> [!tip] Флаги для CI
> `helm upgrade --install --atomic --wait --timeout 10m` — если релиз не стал здоровым, Helm сам откатит его. Плюс `helm diff` в merge request для ревью изменений.

## Kustomize

Kustomize — **без шаблонов**: берёт обычные YAML (base) и накладывает патчи (overlays). Встроен в kubectl (`kubectl apply -k`).

```text Структура
k8s/
├── base/
│   ├── deployment.yaml
│   ├── service.yaml
│   └── kustomization.yaml
└── overlays/
    ├── staging/kustomization.yaml
    └── prod/
        ├── kustomization.yaml
        └── replicas-patch.yaml
```

```yaml overlays/prod/kustomization.yaml
apiVersion: kustomize.config.k8s.io/v1beta1
kind: Kustomization
namespace: api-prod
resources:
  - ../../base
images:
  - name: registry.local/api
    newTag: "1.4.2"
patches:
  - path: replicas-patch.yaml
configMapGenerator:
  - name: api-config
    literals: [LOG_LEVEL=warn]
labels:
  - pairs: { env: prod }
```

```bash
kubectl kustomize overlays/prod      # рендер
kubectl apply -k overlays/prod
```

| | Helm | Kustomize |
|---|---|---|
| Подход | шаблоны + values | патчи поверх чистого YAML |
| Пакетирование и версии | да (чарты, репозитории) | нет |
| Релизы и откат | да (`helm rollback`) | нет (через Git) |
| Сложность | выше, логика в шаблонах | проще, но меньше гибкости |
| Сторонний софт | стандарт де-факто | редко |

Часто комбинируют: сторонние компоненты — Helm-чарты, свои сервисы — Kustomize или собственный общий чарт.

## GitOps

**GitOps** — Git как единственный источник истины для желаемого состояния инфраструктуры и приложений; агент **внутри кластера** постоянно сравнивает состояние кластера с Git и синхронизирует (pull-модель).

Принципы (OpenGitOps): декларативность, версионирование и неизменяемость (Git), автоматическое применение (pull), непрерывная сверка (reconciliation).

| Push (классический CI/CD) | Pull (GitOps) |
|---|---|
| CI имеет kubeconfig/креды кластера и делает `kubectl apply`/`helm upgrade` | CI только собирает образ и меняет тег в Git; агент в кластере сам применяет |
| Дрейф не отслеживается | Дрейф обнаруживается и исправляется |
| Креды кластера в CI | Кластер наружу ничего не открывает |
| Откат — перезапуск пайплайна | Откат — `git revert` |

### Argo CD
- Объект **Application**: источник (Git-репо, путь, Helm/Kustomize, ревизия) → назначение (кластер, namespace).
- Статусы: **Sync** (Synced/OutOfSync) и **Health** (Healthy/Progressing/Degraded).
- `syncPolicy.automated` с `prune` (удалять то, чего нет в Git) и `selfHeal` (откатывать ручные изменения).
- **ApplicationSet** — генерация Application по шаблону (на каждый кластер, каждую папку, каждый PR).
- **App of Apps** — корневое приложение, создающее остальные.
- Sync waves и hooks (`argocd.argoproj.io/sync-wave`) — порядок применения.
- **Argo CD Image Updater** / Renovate — автоматически обновлять теги образов в Git.

```yaml application.yaml
apiVersion: argoproj.io/v1alpha1
kind: Application
metadata:
  name: api-prod
  namespace: argocd
spec:
  project: default
  source:
    repoURL: https://git.example.com/platform/deploy.git
    targetRevision: main
    path: apps/api/overlays/prod
  destination:
    server: https://kubernetes.default.svc
    namespace: api
  syncPolicy:
    automated: { prune: true, selfHeal: true }
    syncOptions: [CreateNamespace=true, ServerSideApply=true]
```

### Flux
Набор контроллеров: `GitRepository`/`OCIRepository` (источник), `Kustomization` (применение), `HelmRelease`, image automation. Без собственного UI (есть Weave GitOps/Capacitor), ближе к «чистому Kubernetes».

### Структура репозиториев
- **Разделяйте** репозиторий кода приложения и репозиторий деплоя (конфигурации окружений), чтобы коммит тега не запускал CI приложения и права были раздельными.
- Окружения — через каталоги (`overlays/staging`, `overlays/prod`) или values-файлы, а **не** через долгоживущие ветки.
- Продвижение между окружениями — PR, меняющий тег в каталоге следующего окружения.

## Секреты в GitOps

| Подход | Как работает |
|---|---|
| **Sealed Secrets** | шифруете `kubeseal` публичным ключом контроллера → в Git `SealedSecret` → контроллер в кластере расшифровывает в Secret |
| **SOPS** (+ age/KMS) | шифрует значения в YAML; расшифровка в Flux нативно, в Argo CD — через плагин (helm-secrets/KSOPS) |
| **External Secrets Operator** | в Git только ссылка (`ExternalSecret`), сам секрет — в Vault/AWS SM/GCP SM, оператор синхронизирует в Secret |
| **Secrets Store CSI Driver** | секрет монтируется файлом напрямую из внешнего хранилища |
| **Vault Agent Injector** | sidecar получает секреты из Vault |

# @interview

## [junior] Что такое Helm и зачем он нужен?
Пакетный менеджер для Kubernetes: шаблонизирует манифесты (одни шаблоны + разные values для окружений), управляет релизами (установка, обновление, история, откат), позволяет переиспользовать готовые чарты (БД, мониторинг, ingress).

## [middle] Где Helm 3 хранит информацию о релизах? Что было в Helm 2?
В Secret'ах в namespace релиза (`sh.helm.release.v1.<name>.v<revision>`), содержащих сжатый манифест, values и статус. В Helm 2 был серверный компонент Tiller с широкими правами в кластере — дыра в безопасности, удалён в Helm 3.

## [middle] Как перезапустить поды, когда меняется только ConfigMap в чарте?
Добавить в pod template аннотацию с хэшем конфига: `checksum/config: {{ include (print $.Template.BasePath "/configmap.yaml") . | sha256sum }}`. При изменении конфига меняется шаблон пода → rolling update.

## [middle] Что делает helm upgrade --atomic?
Ждёт готовности ресурсов (`--wait`) и при неуспехе или таймауте автоматически откатывает релиз к предыдущей ревизии. Удобно для CI, чтобы не оставлять кластер в сломанном состоянии.

## [middle] Helm или Kustomize — что выбрать?
Helm — когда нужно пакетировать и распространять (версии, зависимости, параметризация, сторонние продукты), есть релизы и откаты. Kustomize — для своих сервисов с небольшими различиями между окружениями, без шаблонной логики, «чистый YAML». Часто используются вместе (Kustomize поверх отрендеренного Helm, или helmCharts в kustomization).

## [middle] Что такое GitOps? Чем pull-модель лучше push?
Подход, при котором желаемое состояние хранится в Git, а агент в кластере (Argo CD/Flux) постоянно приводит кластер к нему. Pull: кредов кластера нет в CI, дрейф автоматически обнаруживается и исправляется, вся история изменений и откаты — через Git, аудит через PR.

## [middle] Что такое Sync и Health в Argo CD?
Sync status — совпадает ли состояние ресурсов в кластере с Git (Synced/OutOfSync). Health — работоспособность ресурсов (Healthy, Progressing, Degraded, Missing, Suspended), считается по встроенным правилам (Deployment доступен, PVC Bound) или кастомным Lua-проверкам.

## [senior] Как организовать продвижение релиза dev → staging → prod в GitOps?
CI собирает образ с неизменяемым тегом → автоматически (Image Updater/Renovate/CI-коммит) обновляет тег в каталоге dev → после тестов создаётся PR, переносящий тот же тег в staging, затем в prod (с ревью/approve). Окружения — каталоги/values, а не ветки. Для прогрессивной доставки — Argo Rollouts с анализом метрик.

## [senior] Как хранить секреты при GitOps?
Не в открытом виде. Варианты: Sealed Secrets (шифрование ключом кластера), SOPS с KMS/age, External Secrets Operator (в Git только ссылка, значения в Vault/облачном менеджере), CSI Secrets Store. Предпочтителен ESO/CSI — ротация и аудит в одном месте, в Git ничего чувствительного.

## [middle] Что такое Helm hooks? Пример использования.
Аннотации `helm.sh/hook`, выполняющие ресурсы в определённые моменты жизненного цикла: pre/post-install, pre/post-upgrade, pre/post-delete, test. Пример — Job миграции БД как `pre-upgrade` hook. Нужно помнить про `hook-delete-policy`, иначе повторная установка упадёт на существующем Job.

# @troubleshooting

## [high] Helm: another operation is in progress
**Симптомы:** `Error: UPGRADE FAILED: another operation (install/upgrade/rollback) is in progress`.

**Причина:** предыдущий upgrade прервали (отменили пайплайн, таймаут CI), релиз остался в статусе `pending-upgrade`/`pending-install`.

**Решение:**
```bash
helm history api -n api          # последняя ревизия в pending-*
helm rollback api <последняя deployed ревизия> -n api
# если не помогает — удалить секрет зависшей ревизии:
kubectl get secret -n api -l owner=helm,name=api
kubectl delete secret sh.helm.release.v1.api.v12 -n api
```
Профилактика: не убивать helm в CI, `--atomic`, `--timeout` меньше таймаута джобы.

## [medium] Helm: resource already exists / invalid ownership metadata
**Причина:** ресурс создан вне Helm или другим релизом.

**Решение:** удалить ресурс, переименовать, или «усыновить»: добавить метку `app.kubernetes.io/managed-by=Helm` и аннотации `meta.helm.sh/release-name`, `meta.helm.sh/release-namespace`.

## [medium] Argo CD постоянно показывает OutOfSync
**Причины:** поля, которые изменяет кто-то другой (HPA меняет `replicas`, мутирующие вебхуки добавляют поля, контроллеры дописывают дефолты), разный формат (`"1"` vs `1`), CRD с дефолтами.

**Решение:** `ignoreDifferences` (например, `/spec/replicas` для Deployment под HPA), `ServerSideApply=true`, `RespectIgnoreDifferences=true`, не указывать `replicas` в манифесте при HPA.

## [medium] Шаблон рендерится с ошибкой отступов
**Симптомы:** `error converting YAML to JSON: yaml: line 23: did not find expected key`.

**Решение:** `helm template . --debug` и посмотреть вывод вокруг строки; использовать `nindent` вместо `indent` с ручными переводами строк, `{{-` для обрезки пробелов, `toYaml`; линт `helm lint`, тесты с `helm-unittest`.

# @quiz

? Где Helm 3 хранит историю релизов?
- В Tiller
+ В Secret'ах namespace релиза
- В локальном каталоге ~/.helm
- В etcd отдельно от Kubernetes
> По одному Secret на ревизию.

? Что делает `helm template`?
+ Рендерит манифесты локально, не устанавливая
- Создаёт новый чарт
- Показывает values по умолчанию
- Применяет шаблоны к кластеру
> Удобно для ревью и в GitOps.

? Ключевая особенность Kustomize по сравнению с Helm:
- Поддерживает откаты релизов
+ Патчит обычный YAML без шаблонизации
- Имеет серверный компонент
- Хранит состояние в Secret
> Base + overlays.

? Что делает `selfHeal: true` в Argo CD?
- Перезапускает упавшие поды
+ Возвращает ресурсы к состоянию из Git при ручных изменениях в кластере
- Автоматически обновляет образы
- Удаляет ресурсы, которых нет в Git
> Удаление лишнего — `prune`.

? Как правильно разделить окружения в GitOps-репозитории?
- Долгоживущие ветки dev/staging/prod
+ Каталоги или values-файлы на окружение в одной ветке
- Отдельный Argo CD на каждую ветку
- Тегами Git
> Ветки на окружения приводят к дрейфу и сложным merge.
