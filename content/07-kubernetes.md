---
id: kubernetes
title: Kubernetes
icon: ☸️
order: 70
group: Оркестрация и IaC
color: #326ce5
summary: Архитектура, поды и контроллеры, сервисы и Ingress, хранилище, ресурсы и QoS, планирование, автоскейлинг, RBAC, NetworkPolicy, etcd, обновления и масса траблшутинга.
---

# @theory

## Архитектура кластера

Kubernetes — **декларативная** система: вы описываете желаемое состояние (manifest), а **контроллеры** в бесконечном цикле (reconciliation loop) приводят текущее состояние к желаемому.

### Control plane
| Компонент | Роль |
|---|---|
| **kube-apiserver** | единственная точка входа: REST API, аутентификация, авторизация (RBAC), admission controllers, валидация. Единственный, кто общается с etcd |
| **etcd** | распределённое key-value хранилище (Raft) — **всё состояние кластера**. Нужен нечётный кворум (3/5) |
| **kube-scheduler** | выбирает ноду для подов без `nodeName`: фильтрация (ресурсы, taints, affinity) → скоринг → binding |
| **kube-controller-manager** | набор контроллеров: Deployment, ReplicaSet, Node, Job, EndpointSlice, ServiceAccount, namespace... |
| **cloud-controller-manager** | интеграция с облаком: LoadBalancer-сервисы, маршруты, жизненный цикл нод |

### Worker node
| Компонент | Роль |
|---|---|
| **kubelet** | агент на ноде: получает PodSpec из API, через **CRI** запускает контейнеры, выполняет probes, монтирует тома (CSI), отчитывается о статусе |
| **container runtime** | containerd / CRI-O → runc |
| **kube-proxy** | реализует Service: правила iptables/IPVS (или его заменяет eBPF — Cilium) |
| **CNI-плагин** | сеть подов: Calico, Cilium, Flannel, AWS VPC CNI |
| **CoreDNS** | (как под в кластере) DNS для сервисов |

> [!info] Всё общается через API server
> Scheduler, контроллеры, kubelet не разговаривают друг с другом — они **watch**-ат объекты в API и пишут туда изменения. Это и делает систему расширяемой (операторы — просто ещё контроллеры).

## Что происходит при kubectl apply

Любимый вопрос. Пример — создание Deployment:

1. `kubectl` читает kubeconfig, отправляет POST/PATCH в **kube-apiserver**.
2. API server: **аутентификация** (сертификат, токен, OIDC) → **авторизация** (RBAC) → **mutating admission** (дефолты, инъекция sidecar) → валидация схемы → **validating admission** (политики Kyverno/OPA, Pod Security) → запись в **etcd**.
3. **Deployment controller** видит новый Deployment → создаёт **ReplicaSet**.
4. **ReplicaSet controller** видит, что подов 0 из 3 → создаёт 3 объекта **Pod** (без ноды).
5. **Scheduler** видит поды без `nodeName` → фильтрует ноды (ресурсы, taints, affinity, тома) → оценивает → записывает binding.
6. **kubelet** на выбранной ноде видит под → через CRI просит **containerd** скачать образ и создать sandbox (pause-контейнер с сетевым namespace) → **CNI** выдаёт IP → запускаются init-контейнеры, затем основные.
7. kubelet запускает **probes** и обновляет статус пода в API.
8. Когда под **Ready**, **EndpointSlice controller** добавляет его IP в endpoints сервиса → **kube-proxy** на всех нодах обновляет правила → трафик пошёл.

## Pod

Pod — минимальная единица развёртывания: один или несколько контейнеров, **разделяющих** сетевой namespace (один IP, общаются через localhost), IPC и тома. Поды эфемерны: умерший под не «оживает» — контроллер создаёт новый с новым IP.

```yaml pod.yaml
apiVersion: v1
kind: Pod
metadata:
  name: api
  labels: { app: api }
spec:
  serviceAccountName: api
  securityContext:
    runAsNonRoot: true
    runAsUser: 10001
    fsGroup: 10001
  initContainers:
    - name: wait-db
      image: busybox:1.36
      command: ["sh", "-c", "until nc -z postgres 5432; do sleep 2; done"]
  containers:
    - name: api
      image: registry.local/api:1.4.2
      ports: [{ containerPort: 8080, name: http }]
      env:
        - name: DB_PASSWORD
          valueFrom: { secretKeyRef: { name: db, key: password } }
      envFrom:
        - configMapRef: { name: api-config }
      resources:
        requests: { cpu: 250m, memory: 256Mi }
        limits:   { memory: 512Mi }
      startupProbe:
        httpGet: { path: /health, port: http }
        failureThreshold: 30
        periodSeconds: 2
      readinessProbe:
        httpGet: { path: /ready, port: http }
        periodSeconds: 5
      livenessProbe:
        httpGet: { path: /health, port: http }
        periodSeconds: 10
        failureThreshold: 3
      lifecycle:
        preStop:
          exec: { command: ["sleep", "10"] }
      securityContext:
        allowPrivilegeEscalation: false
        readOnlyRootFilesystem: true
        capabilities: { drop: ["ALL"] }
      volumeMounts:
        - { name: tmp, mountPath: /tmp }
  volumes:
    - name: tmp
      emptyDir: {}
  terminationGracePeriodSeconds: 30
```

### Фазы и состояния
- **Phase пода**: `Pending` (принят, но контейнеры не запущены — нет ноды или качается образ), `Running`, `Succeeded`, `Failed`, `Unknown` (нет связи с нодой).
- **Состояние контейнера**: `Waiting` (с причиной: `ContainerCreating`, `CrashLoopBackOff`, `ImagePullBackOff`, `CreateContainerConfigError`), `Running`, `Terminated` (с exit code и причиной: `Completed`, `Error`, `OOMKilled`).
- **Conditions**: `PodScheduled`, `Initialized`, `ContainersReady`, `Ready`.

### Probes
| Probe | Вопрос | При провале |
|---|---|---|
| **startupProbe** | приложение запустилось? | пока не прошла — liveness/readiness не выполняются; провал → рестарт |
| **readinessProbe** | готов принимать трафик? | под **убирается из endpoints** Service, не перезапускается |
| **livenessProbe** | живо ли (не зависло)? | контейнер **перезапускается** |

Типы: `httpGet`, `tcpSocket`, `exec`, `grpc`.

> [!warn] Ошибки с probes, которые кладут прод
> - liveness проверяет зависимости (БД): БД мигнула → kubelet перезапускает **все** поды → каскадный отказ. Liveness должна проверять только сам процесс.
> - liveness без startupProbe у медленно стартующего приложения (JVM) → вечный CrashLoop.
> - одинаковые readiness и liveness с жёсткими таймаутами под нагрузкой → рестарты именно тогда, когда нагрузка максимальна.

### Multi-container паттерны
- **Sidecar** — вспомогательный контейнер рядом (прокси Envoy/Istio, сборщик логов). С 1.29 — нативные sidecar: init-контейнер с `restartPolicy: Always` (стартует до основного, завершается после).
- **Ambassador** — прокси к внешнему сервису. **Adapter** — нормализует вывод (экспортер метрик).
- **Init containers** — выполняются последовательно до основных: миграции, ожидание зависимостей, подготовка конфигов.

### Завершение пода (graceful shutdown)
1. Под помечается Terminating, **одновременно**: удаляется из endpoints и kubelet начинает остановку.
2. Выполняется **preStop** hook.
3. Контейнеру отправляется **SIGTERM**.
4. Ждём до `terminationGracePeriodSeconds` (30 с по умолчанию) → **SIGKILL**.

Удаление из endpoints распространяется по kube-proxy/Ingress с задержкой, поэтому `preStop: sleep 5-10` помогает не терять запросы при деплое.

## Контроллеры нагрузки

| Объект | Для чего |
|---|---|
| **Deployment** | stateless-приложения; управляет ReplicaSet'ами, rolling update, откат |
| **ReplicaSet** | поддерживает N копий пода (напрямую не используют) |
| **StatefulSet** | stateful: стабильные имена (`db-0`, `db-1`), стабильные DNS через headless service, свой PVC на каждую реплику (`volumeClaimTemplates`), упорядоченный старт/остановка |
| **DaemonSet** | по одному поду на каждую (подходящую) ноду: логи, мониторинг, CNI, kube-proxy |
| **Job** | выполнить до успешного завершения (`completions`, `parallelism`, `backoffLimit`, `activeDeadlineSeconds`) |
| **CronJob** | Job по расписанию (`concurrencyPolicy: Forbid`, `startingDeadlineSeconds`, `successfulJobsHistoryLimit`) |

```yaml deployment.yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: api
spec:
  replicas: 3
  revisionHistoryLimit: 5
  selector:
    matchLabels: { app: api }
  strategy:
    type: RollingUpdate
    rollingUpdate:
      maxSurge: 25%          # сколько подов сверх replicas можно создать
      maxUnavailable: 0      # сколько может быть недоступно (0 = без потери ёмкости)
  template:
    metadata:
      labels: { app: api }
    spec:
      containers:
        - name: api
          image: registry.local/api:1.4.2
          readinessProbe: { httpGet: { path: /ready, port: 8080 } }
```

```bash
kubectl rollout status deploy/api
kubectl rollout history deploy/api
kubectl rollout undo deploy/api --to-revision=3
kubectl rollout restart deploy/api            # пересоздать поды (например, подхватить секрет)
kubectl rollout pause/resume deploy/api
kubectl set image deploy/api api=registry.local/api:1.4.3
kubectl scale deploy/api --replicas=5
```

Стратегии: `RollingUpdate` (по умолчанию) и `Recreate` (сначала убить все, потом создать — когда две версии не могут работать одновременно). Canary/blue-green — средствами Argo Rollouts, Flagger, service mesh или вручную двумя Deployment.

## Service и сеть кластера

### Сетевая модель Kubernetes
1. Каждый под получает **свой IP**.
2. Все поды могут общаться со всеми подами **без NAT** (в том числе между нодами).
3. Агенты на ноде могут общаться со всеми подами ноды.

Реализацию даёт **CNI-плагин**: оверлей (VXLAN/IPIP — Flannel, Calico), маршрутизация (BGP — Calico), нативные IP облака (AWS VPC CNI), eBPF (Cilium).

### Service
Стабильный виртуальный IP и DNS-имя для набора подов, выбранных **selector**-ом по меткам. Поды за сервисом — в **EndpointSlices** (только Ready-поды).

| Тип | Доступ |
|---|---|
| **ClusterIP** (по умолчанию) | виртуальный IP только внутри кластера |
| **NodePort** | ClusterIP + порт 30000–32767 на **каждой** ноде |
| **LoadBalancer** | NodePort + внешний балансировщик облака (через cloud-controller / MetalLB) |
| **ExternalName** | CNAME на внешнее имя, без проксирования |
| **Headless** (`clusterIP: None`) | без виртуального IP: DNS возвращает IP подов напрямую (StatefulSet, клиентская балансировка) |

```yaml service.yaml
apiVersion: v1
kind: Service
metadata:
  name: api
spec:
  selector: { app: api }
  ports:
    - name: http
      port: 80          # порт сервиса
      targetPort: 8080  # порт контейнера (можно имя: http)
```

DNS: `api.default.svc.cluster.local` → ClusterIP; для headless — A-записи подов; для StatefulSet — `db-0.db.default.svc.cluster.local`.

### Как работает kube-proxy
ClusterIP — **не реальный интерфейс**: никто его не слушает. kube-proxy на каждой ноде программирует правила:
- **iptables mode**: цепочки `KUBE-SERVICES → KUBE-SVC-xxx → KUBE-SEP-xxx` с DNAT на IP пода и случайным выбором (`statistic --probability`). O(n) по числу правил — тормозит на тысячах сервисов.
- **IPVS mode**: ядро-балансировщик с хэш-таблицами, алгоритмы rr/lc/sh, лучше масштабируется.
- **nftables mode** (1.31+), или **eBPF** (Cilium kube-proxy replacement).

`externalTrafficPolicy: Local` — трафик NodePort/LB идёт только на поды этой ноды: сохраняется IP клиента, нет лишнего хопа, но возможен дисбаланс. `Cluster` (по умолчанию) — на любую ноду, SNAT, IP клиента теряется.

## Ingress и Gateway API

**Ingress** — L7-правила (хост, путь → Service). Сам по себе ничего не делает: нужен **Ingress Controller** (ingress-nginx, Traefik, HAProxy, AWS Load Balancer Controller, Contour).

```yaml ingress.yaml
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: api
  annotations:
    cert-manager.io/cluster-issuer: letsencrypt
    nginx.ingress.kubernetes.io/proxy-body-size: "20m"
spec:
  ingressClassName: nginx
  tls:
    - hosts: [api.example.com]
      secretName: api-tls
  rules:
    - host: api.example.com
      http:
        paths:
          - path: /
            pathType: Prefix
            backend:
              service: { name: api, port: { number: 80 } }
```

**Gateway API** — преемник Ingress: роли разделены (`GatewayClass` — инфраструктура, `Gateway` — точка входа, `HTTPRoute`/`GRPCRoute`/`TCPRoute` — маршруты команд), нативно поддерживает разделение трафика по весам (canary), заголовкам, кросс-namespace маршрутизацию.

> [!info] ingress-nginx
> Проект ingress-nginx объявлен к завершению поддержки (retirement в 2026). Для новых установок рассматривайте Gateway API-реализации (Envoy Gateway, Cilium, Istio, NGINX Gateway Fabric, Traefik).

**cert-manager** автоматически выпускает и продлевает TLS-сертификаты (Let's Encrypt, Vault, внутренний CA) в Secret.

## Конфигурация: ConfigMap и Secret

```bash
kubectl create configmap api-config --from-literal=LOG_LEVEL=info --from-file=app.yaml
kubectl create secret generic db --from-literal=password='s3cr3t'
kubectl create secret tls api-tls --cert=tls.crt --key=tls.key
kubectl create secret docker-registry regcred --docker-server=… --docker-username=… --docker-password=…
kubectl get secret db -o jsonpath='{.data.password}' | base64 -d
```

Способы использования: переменные (`env.valueFrom`, `envFrom`) или **файлы** (volume). При изменении ConfigMap/Secret:
- смонтированные **файлы** обновляются автоматически (через ~минуту, кроме `subPath`!);
- **переменные окружения не обновляются** — нужен рестарт пода (`rollout restart`, или хэш конфига в аннотации шаблона — паттерн Helm `checksum/config`, или Reloader).

> [!danger] Secret — это не шифрование
> Значения в Secret только закодированы **base64**. Защита: шифрование etcd at rest (`EncryptionConfiguration`, KMS), RBAC (кто может `get secrets`), не коммитить в Git в открытом виде — **Sealed Secrets**, **SOPS**, **External Secrets Operator** (из Vault/AWS SM), Secrets Store CSI Driver.

## Хранилище: PV, PVC, StorageClass

- **PersistentVolume (PV)** — кусок хранилища в кластере (диск EBS, NFS-шара, Ceph RBD).
- **PersistentVolumeClaim (PVC)** — запрос приложения: «нужно 10Gi, ReadWriteOnce, класс fast».
- **StorageClass** — «тип» хранилища + провижионер (CSI-драйвер) для **динамического** создания PV.
- **CSI** — стандартный интерфейс драйверов хранилищ.

```yaml pvc.yaml
apiVersion: v1
kind: PersistentVolumeClaim
metadata:
  name: data
spec:
  accessModes: [ReadWriteOnce]
  storageClassName: gp3
  resources:
    requests: { storage: 20Gi }
```

| Access mode | Значение |
|---|---|
| RWO — ReadWriteOnce | чтение/запись с **одной ноды** (EBS, большинство блочных дисков) |
| RWOP — ReadWriteOncePod | только один под |
| ROX — ReadOnlyMany | чтение со многих нод |
| RWX — ReadWriteMany | запись со многих нод (NFS, EFS, CephFS) |

- `reclaimPolicy`: `Delete` (удалить диск вместе с PVC — дефолт для динамических!) или `Retain`.
- `volumeBindingMode: WaitForFirstConsumer` — создавать диск в зоне, куда запланирован под (важно для зональных дисков).
- `allowVolumeExpansion: true` — можно увеличить PVC.
- Эфемерные тома: `emptyDir` (живёт с подом; `medium: Memory` — tmpfs), `configMap`, `secret`, `projected`, `downwardAPI`.
- `hostPath` — каталог ноды: опасно (доступ к хосту), только для системных DaemonSet.

## Ресурсы, QoS, лимиты

- **requests** — гарантированный минимум; **по requests работает планировщик** (сумма requests на ноде ≤ allocatable).
- **limits** — потолок. CPU — **throttling** (CFS quota), память — **OOMKill** контейнера.
- Единицы: CPU `500m` = 0.5 ядра; память `256Mi` (2^20), `256M` (10^6).

### QoS-классы
| Класс | Условие | При нехватке памяти на ноде |
|---|---|---|
| **Guaranteed** | у всех контейнеров requests = limits для CPU и памяти | выселяется последним |
| **Burstable** | есть хоть какие-то requests/limits | средний приоритет |
| **BestEffort** | нет ни requests, ни limits | выселяется первым |

> [!tip] Практика
> Всегда ставьте requests (CPU и память) и memory limit. CPU limit — спорно: часто приводит к throttling при свободном CPU на ноде; многие команды ставят CPU requests без limits. Для latency-критичных — Guaranteed + static CPU manager.

### Eviction
kubelet выселяет поды при нехватке ресурсов ноды (`memory.available < 100Mi`, `nodefs.available < 10%`, `imagefs`, `pid`) — статус `Evicted`. Порядок — по QoS и превышению requests.

### LimitRange и ResourceQuota
- **LimitRange** — дефолтные и min/max requests/limits для контейнеров в namespace.
- **ResourceQuota** — суммарные лимиты namespace (CPU, память, число подов, PVC, LoadBalancer'ов).

## Планирование подов

```yaml
spec:
  nodeSelector:
    node-type: compute
  affinity:
    nodeAffinity:
      requiredDuringSchedulingIgnoredDuringExecution:
        nodeSelectorTerms:
          - matchExpressions:
              - { key: topology.kubernetes.io/zone, operator: In, values: [eu-west-1a, eu-west-1b] }
    podAntiAffinity:
      preferredDuringSchedulingIgnoredDuringExecution:
        - weight: 100
          podAffinityTerm:
            labelSelector: { matchLabels: { app: api } }
            topologyKey: kubernetes.io/hostname     # не класть реплики на одну ноду
  topologySpreadConstraints:
    - maxSkew: 1
      topologyKey: topology.kubernetes.io/zone
      whenUnsatisfiable: ScheduleAnyway
      labelSelector: { matchLabels: { app: api } }
  tolerations:
    - { key: dedicated, operator: Equal, value: gpu, effect: NoSchedule }
  priorityClassName: high-priority
```

- **nodeSelector / nodeAffinity** — «под хочет на такие ноды».
- **Taints** на ноде + **tolerations** у пода — «нода не пускает никого, кроме тех, кто терпит». Эффекты: `NoSchedule`, `PreferNoSchedule`, `NoExecute` (ещё и выгоняет уже работающие).
- **podAffinity/podAntiAffinity** — размещать рядом/порознь с другими подами.
- **topologySpreadConstraints** — равномерно по зонам/нодам.
- **PriorityClass** и **preemption** — важные поды вытесняют менее важные.

```bash
kubectl taint nodes node1 dedicated=gpu:NoSchedule
kubectl taint nodes node1 dedicated-          # снять
kubectl cordon node1                           # запретить новые поды
kubectl drain node1 --ignore-daemonsets --delete-emptydir-data   # выселить всё (для обслуживания)
kubectl uncordon node1
```

### PodDisruptionBudget
Защищает от **добровольных** нарушений (drain, обновление нод, autoscaler): «не меньше 2 доступных подов».
```yaml
apiVersion: policy/v1
kind: PodDisruptionBudget
metadata: { name: api }
spec:
  minAvailable: 2          # или maxUnavailable: 1
  selector: { matchLabels: { app: api } }
```
> [!warn] PDB с `maxUnavailable: 0` или `minAvailable` = числу реплик блокирует drain навсегда — обновление нод зависнет.

## Автомасштабирование

| Что | Как |
|---|---|
| **HPA** | меняет число реплик по метрикам (CPU/память относительно **requests**, custom/external metrics через Prometheus Adapter) |
| **VPA** | подбирает requests/limits (режимы Off — рекомендации, Auto — пересоздаёт поды); с HPA по CPU одновременно не использовать |
| **KEDA** | event-driven: масштабирование по очередям (Kafka lag, RabbitMQ, SQS), cron, Prometheus, **до нуля** |
| **Cluster Autoscaler** | добавляет ноды, если есть **Pending**-поды, которые не помещаются; удаляет недогруженные |
| **Karpenter** | провижинит оптимальные ноды под конкретные поды напрямую (без node groups), консолидация |

```yaml hpa.yaml
apiVersion: autoscaling/v2
kind: HorizontalPodAutoscaler
metadata: { name: api }
spec:
  scaleTargetRef: { apiVersion: apps/v1, kind: Deployment, name: api }
  minReplicas: 3
  maxReplicas: 30
  metrics:
    - type: Resource
      resource:
        name: cpu
        target: { type: Utilization, averageUtilization: 70 }
  behavior:
    scaleDown:
      stabilizationWindowSeconds: 300
```
HPA требует **metrics-server** и заданных requests. Формула: `desired = ceil(current × currentMetric / target)`.

## Безопасность: RBAC, ServiceAccount, Pod Security

### RBAC
- **Role** (в namespace) / **ClusterRole** (кластерно) — набор разрешений: `apiGroups`, `resources`, `verbs` (get, list, watch, create, update, patch, delete).
- **RoleBinding** / **ClusterRoleBinding** — кому (User, Group, ServiceAccount) выдать роль.

```yaml rbac.yaml
apiVersion: rbac.authorization.k8s.io/v1
kind: Role
metadata: { name: pod-reader, namespace: dev }
rules:
  - apiGroups: [""]
    resources: [pods, pods/log]
    verbs: [get, list, watch]
---
apiVersion: rbac.authorization.k8s.io/v1
kind: RoleBinding
metadata: { name: ci-pod-reader, namespace: dev }
subjects:
  - kind: ServiceAccount
    name: ci
    namespace: dev
roleRef:
  kind: Role
  name: pod-reader
  apiGroup: rbac.authorization.k8s.io
```
```bash
kubectl auth can-i delete pods -n dev --as=system:serviceaccount:dev:ci
kubectl auth can-i --list --as=jane
```

### ServiceAccount
Identity для подов. Токен (короткоживущий, projected) монтируется в `/var/run/secrets/kubernetes.io/serviceaccount/`. Если поду не нужен API — `automountServiceAccountToken: false`. В облаках SA связывают с IAM-ролями: **IRSA / EKS Pod Identity** (AWS), **Workload Identity** (GCP/Azure) — без статических ключей.

### Pod Security Standards
Встроенный admission **Pod Security Admission** (заменил PodSecurityPolicy, удалённую в 1.25): уровни `privileged`, `baseline`, `restricted` через метки namespace:
```bash
kubectl label ns prod pod-security.kubernetes.io/enforce=restricted
```
Тонкие политики — **Kyverno**, **OPA Gatekeeper**, ValidatingAdmissionPolicy (CEL): запрет `:latest`, обязательные лимиты, только доверенные реестры, подписи образов.

## NetworkPolicy

По умолчанию **все поды могут общаться со всеми**. NetworkPolicy — файрвол на уровне подов (реализуется CNI: Calico, Cilium; **Flannel не поддерживает**).

```yaml netpol.yaml
# 1. Запретить весь входящий трафик в namespace
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata: { name: default-deny-ingress, namespace: prod }
spec:
  podSelector: {}
  policyTypes: [Ingress]
---
# 2. Разрешить к БД только от api
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata: { name: db-from-api, namespace: prod }
spec:
  podSelector: { matchLabels: { app: postgres } }
  policyTypes: [Ingress]
  ingress:
    - from:
        - podSelector: { matchLabels: { app: api } }
      ports:
        - { protocol: TCP, port: 5432 }
```
Если включаете default-deny для **Egress** — не забудьте разрешить DNS (UDP/TCP 53 к kube-dns), иначе всё сломается.

## etcd, бэкапы, обновления кластера

### etcd
- Raft-консенсус: запись подтверждается большинством. 3 узла переживают отказ 1, 5 — отказ 2. Чётное число не добавляет отказоустойчивости.
- Чувствителен к латентности диска (fsync) — только SSD/NVMe, метрика `etcd_disk_wal_fsync_duration_seconds`.
- Размер по умолчанию ограничен (2 ГБ, до 8 ГБ) → нужна компакция и дефрагментация, иначе `mvcc: database space exceeded`.

```bash
ETCDCTL_API=3 etcdctl --endpoints=https://127.0.0.1:2379 \
  --cacert=/etc/kubernetes/pki/etcd/ca.crt \
  --cert=/etc/kubernetes/pki/etcd/server.crt \
  --key=/etc/kubernetes/pki/etcd/server.key \
  snapshot save /backup/etcd-$(date +%F).db
etcdctl snapshot status /backup/etcd.db -w table
etcdctl endpoint health; etcdctl endpoint status -w table
etcdutl snapshot restore /backup/etcd.db --data-dir /var/lib/etcd-restore
```
Кроме etcd бэкапить надо и **данные PV** — **Velero** (ресурсы + снапшоты томов), а лучше — держать всё в Git (GitOps) и уметь пересоздать кластер.

### Обновление кластера (kubeadm)
- Версии: control plane обновляют по **одной минорной** за раз (1.30 → 1.31 → 1.32). kubelet может отставать от API server (до 3 минорных в новых версиях).
- Порядок: прочитать changelog (удалённые API!) → бэкап etcd → `kubeadm upgrade plan` → `kubeadm upgrade apply` на первом master → остальные master (`kubeadm upgrade node`) → для каждой worker: `drain` → обновить kubeadm/kubelet → `uncordon`.
- Проверка устаревших API: `kubent`, `pluto`.
- Сертификаты kubeadm живут **1 год** (`kubeadm certs check-expiration`, `kubeadm certs renew all`); обновляются автоматически при upgrade.
- В managed (EKS/GKE/AKS) control plane обновляет провайдер, ноды — через node groups/surge upgrade.

## CRD и операторы

- **CRD** (CustomResourceDefinition) — расширение API своими типами: `Certificate`, `PostgresCluster`, `Application`.
- **Оператор** = CRD + контроллер, который кодирует операционные знания: развернуть кластер БД, сделать failover, бэкап, обновление. Примеры: CloudNativePG, Strimzi (Kafka), Prometheus Operator, cert-manager, ArgoCD.
- Пишут на Go (kubebuilder, operator-sdk) или Python (kopf).
- **Finalizers** — метки в metadata, которые не дают удалить объект, пока контроллер не выполнит очистку (поэтому «зависает Terminating», если контроллера нет).

## kubectl: шпаргалка

```bash
kubectl config get-contexts; kubectl config use-context prod; kubectl config set-context --current --namespace=api
kubectl get pods -A -o wide
kubectl get pods -l app=api --field-selector=status.phase!=Running
kubectl get all,ing,pvc -n api
kubectl get events -A --sort-by=.lastTimestamp | tail -30
kubectl describe pod api-6d4f7-x2k9
kubectl logs api-6d4f7-x2k9 -c api --previous --tail=100     # логи упавшего контейнера
kubectl logs -l app=api -f --max-log-requests=10 --prefix
kubectl exec -it api-6d4f7-x2k9 -- sh
kubectl debug -it api-6d4f7-x2k9 --image=nicolaka/netshoot --target=api   # эфемерный контейнер
kubectl debug node/node1 -it --image=ubuntu                                 # shell на ноде (хост в /host)
kubectl port-forward svc/api 8080:80
kubectl top pods --sort-by=memory; kubectl top nodes
kubectl get pod x -o yaml | yq '.status'
kubectl get pods -o jsonpath='{range .items[*]}{.metadata.name}{"\t"}{.status.containerStatuses[0].restartCount}{"\n"}{end}'
kubectl get pods -o custom-columns=NAME:.metadata.name,NODE:.spec.nodeName,IMAGE:.spec.containers[0].image
kubectl explain deployment.spec.strategy --recursive
kubectl diff -f manifests/; kubectl apply -f manifests/ --server-side
kubectl create deploy x --image=nginx --dry-run=client -o yaml > x.yaml    # заготовка манифеста
kubectl api-resources; kubectl api-versions
kubectl delete pod x --grace-period=0 --force     # крайняя мера
```

Полезное: `k9s` (TUI), `kubectx`/`kubens`, `stern` (логи многих подов), `krew` (плагины), алиас `alias k=kubectl` + автодополнение.

# @interview

## [junior] Из каких компонентов состоит Kubernetes?
Control plane: kube-apiserver, etcd, kube-scheduler, kube-controller-manager, (cloud-controller-manager). На нодах: kubelet, container runtime (containerd/CRI-O), kube-proxy, CNI-плагин. Плюс аддоны: CoreDNS, metrics-server, Ingress controller.

## [middle] Что происходит, когда вы выполняете kubectl apply -f deployment.yaml?
kubectl → API server (аутентификация, RBAC, mutating admission, валидация, validating admission) → запись в etcd → Deployment controller создаёт ReplicaSet → ReplicaSet controller создаёт поды → scheduler выбирает ноды → kubelet через CRI запускает контейнеры, CNI даёт IP → probes → под Ready → EndpointSlice обновляется → kube-proxy программирует правила → трафик идёт.

## [junior] Что такое Pod? Почему не просто контейнер?
Минимальная единица в K8s: группа контейнеров с общим сетевым namespace (IP, localhost), IPC и томами, планируемая на одну ноду. Позволяет объединять тесно связанные процессы (приложение + sidecar), сохраняя «один процесс на контейнер».

## [junior] Чем Deployment отличается от StatefulSet?
Deployment — для stateless: поды взаимозаменяемы, случайные имена, общий том (если есть), параллельный rolling update. StatefulSet — стабильные имена и DNS (`app-0`), отдельный PVC на каждую реплику, упорядоченный старт/остановка/обновление — для БД, Kafka, ZooKeeper.

## [junior] Что такое DaemonSet? Примеры.
Контроллер, запускающий по одному поду на каждую ноду (или на ноды по селектору). Примеры: сборщики логов (Fluent Bit), node-exporter, CNI-агенты, kube-proxy, CSI node-плагины.

## [middle] Чем отличаются liveness, readiness и startup probes?
Readiness — готов ли под получать трафик; при провале под убирается из endpoints, но не перезапускается. Liveness — жив ли процесс; при провале контейнер перезапускается. Startup — для медленно стартующих приложений: пока не прошла, остальные пробы не выполняются. Ошибка — завязывать liveness на внешние зависимости.

## [middle] Какие типы Service бывают?
ClusterIP (внутренний виртуальный IP), NodePort (порт на всех нодах), LoadBalancer (внешний балансировщик облака), ExternalName (CNAME), Headless (`clusterIP: None` — DNS отдаёт IP подов).

## [middle] Как работает Service под капотом?
ClusterIP — виртуальный адрес, которого нет ни на одном интерфейсе. EndpointSlice controller отслеживает Ready-поды по селектору. kube-proxy на каждой ноде создаёт правила iptables/IPVS: пакет на ClusterIP:port DNAT-ится на случайный IP пода. CoreDNS выдаёт A-запись `svc.ns.svc.cluster.local` → ClusterIP.

## [middle] Чем Ingress отличается от Service типа LoadBalancer?
LoadBalancer создаёт отдельный внешний балансировщик (L4) на каждый сервис — дорого и без L7-логики. Ingress — L7-маршрутизация (хосты, пути, TLS) через один Ingress Controller, за которым много сервисов. Ingress controller сам обычно публикуется через один LoadBalancer.

## [middle] Чем requests отличаются от limits? Что будет при превышении?
Requests — гарантированные ресурсы, по ним планировщик размещает поды. Limits — максимум. Превышение CPU limit → throttling (процесс замедляется). Превышение memory limit → OOMKill контейнера (exit 137). Превышение requests по памяти при нехватке на ноде делает под кандидатом на eviction.

## [middle] Что такое QoS-классы?
Guaranteed (requests = limits для всех ресурсов всех контейнеров), Burstable (что-то задано), BestEffort (ничего не задано). Определяют порядок выселения при нехватке памяти на ноде и oom_score_adj: BestEffort первыми, Guaranteed последними.

## [middle] Как обновить приложение без даунтайма?
RollingUpdate с `maxUnavailable: 0` и `maxSurge`, корректная readinessProbe, достаточное количество реплик, PDB, graceful shutdown (обработка SIGTERM, `preStop: sleep` для синхронизации с удалением из endpoints, `terminationGracePeriodSeconds`), обратно совместимые миграции БД. Для рискованных релизов — canary (Argo Rollouts/Flagger) с автоматическим откатом по метрикам.

## [middle] Чем ConfigMap отличается от Secret? Безопасен ли Secret?
Оба хранят конфигурацию key-value; Secret предназначен для чувствительных данных, хранится в base64 (не шифрование!), можно отдельно ограничить RBAC и зашифровать в etcd (EncryptionConfiguration/KMS), монтируется в tmpfs. Для GitOps — Sealed Secrets, SOPS, External Secrets Operator с Vault/облачными секрет-менеджерами.

## [middle] Обновили ConfigMap — приложение не видит изменений. Почему?
Если ConfigMap подключен через env — переменные читаются только при старте контейнера, нужен рестарт. Если смонтирован как том — файлы обновятся с задержкой (до ~1 мин), но не через `subPath`; к тому же приложение должно само перечитать файл. Решения: `rollout restart`, аннотация с хэшем конфига в pod template, Reloader.

## [middle] Что такое PV, PVC и StorageClass?
PV — ресурс хранилища в кластере. PVC — запрос пода на хранилище (размер, режим доступа, класс). StorageClass описывает тип хранилища и provisioner (CSI) для динамического создания PV по PVC. Под ссылается на PVC, а не на конкретный диск.

## [middle] Что такое taints и tolerations? Чем отличаются от nodeAffinity?
Taint на ноде отталкивает поды, у которых нет соответствующей toleration (эффекты NoSchedule, PreferNoSchedule, NoExecute). Affinity — притяжение пода к нодам по меткам. Обычно используют вместе: taint — чтобы на GPU-ноды не попадало лишнее, affinity — чтобы GPU-поды шли именно туда.

## [middle] Что такое PodDisruptionBudget?
Ограничение на число одновременно недоступных подов при добровольных нарушениях (drain, обновление нод, autoscaler). Не защищает от падения ноды. Неправильно настроенный PDB (minAvailable = replicas) блокирует drain.

## [middle] Как работает HPA? Что нужно для его работы?
Периодически (15 с) берёт метрики (metrics-server для CPU/памяти, custom/external API для других), вычисляет `desired = ceil(current * metric / target)` и меняет `replicas`. Нужны: metrics-server, заданные requests (утилизация считается от них), разумные min/max и stabilization window.

## [middle] Чем HPA отличается от Cluster Autoscaler?
HPA масштабирует поды (реплики), Cluster Autoscaler/Karpenter — ноды. Они работают в связке: HPA создаёт новые поды → они Pending из-за нехватки ресурсов → CA добавляет ноду. CA удаляет ноды, если поды можно перераспределить.

## [middle] Как устроен RBAC в Kubernetes?
Role/ClusterRole описывают разрешения (apiGroups, resources, verbs), RoleBinding/ClusterRoleBinding связывают их с субъектами (User, Group, ServiceAccount). Role — в рамках namespace, ClusterRole — кластерно или переиспользуемо через RoleBinding. Проверка — `kubectl auth can-i`. Принцип минимальных привилегий; опасны `*` verbs, доступ к secrets, `pods/exec`, `escalate`, `bind`, создание подов в привилегированных namespace.

## [middle] Что такое NetworkPolicy? Что будет, если её создать во Flannel?
Правила фильтрации трафика подов по меткам/namespace/CIDR и портам. По умолчанию трафик разрешён везде; как только под выбран политикой с типом Ingress/Egress — разрешено только явно указанное. Реализуется CNI; Flannel не поддерживает NetworkPolicy — объекты создадутся, но ничего не будут делать.

## [senior] Почему etcd должен иметь нечётное число узлов?
Raft требует кворума — большинства (n/2+1). 3 узла: кворум 2, переживают отказ 1. 4 узла: кворум 3, переживают отказ тоже 1 — дороже без выигрыша, а при разделении сети 2/2 кластер встанет. 5 узлов — отказ 2.

## [senior] Как сделать бэкап и восстановление Kubernetes-кластера?
etcd snapshot (`etcdctl snapshot save`) регулярно, вне кластера, с проверкой восстановления. Для ресурсов и PV — Velero (бэкап объектов + снапшоты дисков/restic/kopia). Лучшая стратегия — GitOps: всё описано в Git, кластер пересоздаётся из IaC + Argo CD, а бэкапить нужно только данные (БД, PV). Для managed — etcd не доступен, бэкапим через Velero и Git.

## [senior] Как обновить версию Kubernetes-кластера?
Проверить совместимость (удалённые API — kubent/pluto, аддоны, CNI, Ingress), бэкап etcd, обновлять по одной минорной версии: control plane (kubeadm upgrade plan/apply, затем остальные мастера), затем ноды по одной: cordon/drain → обновить kubelet/kubeadm → uncordon (или замена нод новыми с новой версией). PDB и достаточная ёмкость для drain. В managed — обновить control plane, затем node groups (surge).

## [senior] Под получает OOMKilled, хотя потребление по метрикам меньше лимита. Почему?
Метрики снимаются раз в 15–60 с и не ловят кратковременные пики. Лимит учитывает всю память cgroup: RSS + page cache (активный) + tmpfs (emptyDir medium: Memory) + kernel memory. JVM с heap = лимит + metaspace + direct buffers + потоки превышает лимит. Мульти-контейнерный под: лимит у каждого контейнера свой. Смотреть `container_memory_working_set_bytes`, `kubectl describe` (Last State), dmesg на ноде.

## [middle] Что такое CPU throttling и почему он плохо влияет на латентность?
При CPU limit cgroup выдаёт квоту времени на период 100 мс. Многопоточное приложение может выбрать квоту за первые миллисекунды и остальное время периода стоять — латентность p99 растёт, хотя средняя загрузка низкая. Метрика `container_cpu_cfs_throttled_periods_total`. Решения: увеличить/убрать CPU limit, правильно настроить число потоков (GOMAXPROCS через automaxprocs, JVM ActiveProcessorCount).

## [middle] Как поды разрешают DNS-имена сервисов? Что такое ndots?
kubelet прописывает в resolv.conf пода nameserver CoreDNS и search-домены `ns.svc.cluster.local svc.cluster.local cluster.local` + `ndots:5`. Имена с менее чем 5 точками сначала пробуются с каждым search-суффиксом — внешний `api.github.com` порождает лишние запросы. Решения: FQDN с точкой в конце, `dnsConfig` с меньшим ndots, NodeLocal DNSCache.

## [middle] Что такое init-контейнеры и sidecar-контейнеры?
Init-контейнеры выполняются последовательно до основных и должны завершиться успешно (миграции, ожидание зависимостей, подготовка файлов). Sidecar работает параллельно основному весь жизненный цикл (прокси mesh, агенты логов). С 1.29 нативные sidecar — init-контейнеры с `restartPolicy: Always`: стартуют до основных и останавливаются после них (важно для Job).

## [senior] Что такое оператор в Kubernetes? Когда его стоит писать?
CRD + контроллер, автоматизирующий эксплуатацию конкретной системы (развёртывание, масштабирование, failover, бэкапы, апгрейды) через reconciliation loop. Писать стоит, когда есть повторяющиеся сложные операционные процедуры, которые нельзя выразить шаблонами Helm. Сначала искать готовые (OperatorHub).

## [middle] Как ограничить, кто и что может запускать в кластере?
RBAC (кто может создавать ресурсы), Pod Security Admission (restricted/baseline), admission-политики (Kyverno, Gatekeeper, ValidatingAdmissionPolicy): разрешённые реестры, проверка подписи образов, запрет privileged/hostPath/hostNetwork, обязательные лимиты и метки; ResourceQuota/LimitRange; NetworkPolicy.

## [middle] Что такое Headless Service и зачем он StatefulSet'у?
Service с `clusterIP: None`: без виртуального IP и балансировки, DNS возвращает IP подов напрямую, а для StatefulSet создаются записи `pod-0.svc.ns.svc.cluster.local`. Это даёт стабильные адреса конкретных реплик (нужно для кластеров БД: лидер/реплики, peer discovery).

## [senior] Как организовать multi-tenancy в Kubernetes?
Мягкая: namespace на команду + RBAC + ResourceQuota/LimitRange + NetworkPolicy (default deny) + Pod Security + политики admission + отдельные node pools с taints для чувствительных нагрузок. Жёсткая: отдельные кластеры, или виртуальные кластеры (vcluster), Capsule/HNC. Выбор зависит от доверия между арендаторами.

## [middle] Чем отличается kubectl apply от kubectl create и replace?
`create` — императивно создать, ошибка если существует. `replace` — заменить целиком (нужен полный объект). `apply` — декларативно: сравнивает с last-applied-configuration (или server-side apply с field managers) и делает 3-way merge, создаёт или обновляет. Для GitOps и CI — apply (лучше `--server-side`).

## [senior] Что такое finalizers и почему namespace может зависнуть в Terminating?
Finalizers — список «обязательств» в metadata: объект не удаляется из etcd, пока все finalizers не сняты контроллерами (например, удалить облачный балансировщик, PV). Namespace зависает, если внутри остались ресурсы с finalizers, чей контроллер удалён/не работает, или недоступен APIService (metrics/aggregated API) — namespace controller не может перечислить ресурсы.

## [middle] Как отладить под без shell (distroless)?
`kubectl debug -it pod --image=busybox --target=container` — эфемерный контейнер в том же поде с общим PID namespace процесса. Или `kubectl debug pod --copy-to=dbg --share-processes --image=...`. Для ноды — `kubectl debug node/x`. Сеть — `netshoot`.

## [senior] Чем отличаются CNI-плагины Calico, Cilium, Flannel?
Flannel — простой оверлей (VXLAN), без NetworkPolicy. Calico — маршрутизация L3 (BGP или IPIP/VXLAN), мощные NetworkPolicy, eBPF dataplane опционально. Cilium — eBPF: заменяет kube-proxy, L3–L7 политики, наблюдаемость (Hubble), шифрование (WireGuard/IPsec), service mesh без sidecar. AWS VPC CNI — поды получают реальные IP VPC (ограничение по IP на ENI).

## [middle] Как предоставить поду доступ к AWS без статических ключей?
IRSA (IAM Roles for Service Accounts): OIDC-провайдер кластера + IAM-роль с trust policy на конкретный ServiceAccount; SDK обменивает projected-токен SA на временные креды через STS AssumeRoleWithWebIdentity. Или EKS Pod Identity (агент на нодах). В GCP — Workload Identity, в Azure — Workload Identity Federation.

# @troubleshooting

## [high] CrashLoopBackOff
**Что это:** контейнер запускается и падает, kubelet перезапускает его с растущей задержкой (10 с → 20 → 40 … до 5 мин).

**Диагностика:**
```bash
kubectl describe pod POD             # Last State: Terminated, Reason, Exit Code, Events
kubectl logs POD -c CONTAINER --previous    # логи ПРЕДЫДУЩЕГО (упавшего) запуска
kubectl get pod POD -o jsonpath='{.status.containerStatuses[*].lastState}'
```
**По коду выхода:**
- **1 / 2** — ошибка приложения: нет переменной/конфига, не подключиться к БД, синтаксис конфига. Смотреть логи.
- **137 + OOMKilled** — превышен memory limit.
- **137 без OOM** — убит liveness-пробой (в Events: `Liveness probe failed ... will be restarted`).
- **139** — segfault (несовместимая библиотека, alpine/musl).
- **127 / 126** — неверная команда/нет прав на исполнение.
- **0** — процесс завершился «успешно», но это Deployment (ожидается долгоживущий процесс): неверная команда, демон ушёл в фон.

**Если логов нет:** временно заменить команду на `sleep infinity` (`kubectl debug POD --copy-to=dbg --container=app -- sleep 1d`) и запустить приложение руками внутри.

## [high] ImagePullBackOff / ErrImagePull
**Диагностика:** `kubectl describe pod` → Events, точный текст ошибки.

| Сообщение | Причина |
|---|---|
| `manifest unknown` / `not found` | опечатка в имени/теге, тег не запушен |
| `unauthorized` / `pull access denied` | приватный реестр без `imagePullSecrets`, истёк токен (ECR — 12 ч) |
| `no match for platform in manifest` | образ только под arm64/amd64 |
| `toomanyrequests` | rate limit Docker Hub |
| `i/o timeout`, `dial tcp` | ноде нет доступа к реестру (NAT, прокси, DNS, firewall) |
| `x509: certificate signed by unknown authority` | приватный реестр с самоподписанным сертификатом — CA не добавлен в containerd |

**Проверка с ноды:** `crictl pull registry/image:tag`.

## [high] Под висит в Pending
**Диагностика:** `kubectl describe pod` → Events от scheduler: `0/5 nodes are available: ...`.

| Сообщение | Решение |
|---|---|
| `Insufficient cpu/memory` | requests больше свободного allocatable: уменьшить requests, добавить ноды, проверить Cluster Autoscaler |
| `node(s) had untolerated taint` | добавить toleration или убрать taint |
| `didn't match Pod's node affinity/selector` | метки нод, nodeSelector |
| `didn't match pod anti-affinity rules` | реплик больше, чем нод/зон при required anti-affinity |
| `pod has unbound immediate PersistentVolumeClaims` | PVC не привязан — см. кейс PVC Pending |
| `volume node affinity conflict` | диск в одной AZ, а ноды с ресурсами — в другой |
| `Too many pods` | лимит подов на ноду (110 / ограничение IP в AWS VPC CNI) |
| нет событий scheduler | нет scheduler / указан несуществующий `schedulerName`, ResourceQuota (тогда под даже не создастся — смотреть events ReplicaSet) |

```bash
kubectl describe nodes | grep -A8 "Allocated resources"
kubectl get events --field-selector reason=FailedScheduling
```

## [critical] OOMKilled
**Диагностика:**
```bash
kubectl describe pod POD | grep -A5 "Last State"     # Reason: OOMKilled, Exit Code: 137
kubectl top pod POD --containers
# Prometheus: container_memory_working_set_bytes, kube_pod_container_status_last_terminated_reason
```
**Решение:** понять, это пик/утечка или лимит просто мал (график памяти перед смертью). Увеличить memory limit; настроить рантайм под лимит (`-XX:MaxRAMPercentage=75`, `GOMEMLIMIT`, `--max-old-space-size`); проверить emptyDir в памяти; искать утечку профилировщиком. Если OOM на уровне **ноды** (а не контейнера) — поды без лимитов съели память ноды: ставить лимиты, `kube-reserved`/`system-reserved`.

## [high] Поды Evicted
**Причина:** kubelet выселяет поды при давлении ресурсов ноды: `The node was low on resource: memory / ephemeral-storage`. Часто — **ephemeral-storage**: логи контейнеров, запись в файловую систему контейнера, emptyDir.

**Диагностика и решение:**
```bash
kubectl get pods -A --field-selector=status.phase=Failed | grep Evicted
kubectl describe pod EVICTED_POD | grep -i message
kubectl describe node NODE | grep -A5 Conditions     # MemoryPressure / DiskPressure
# почистить отработавшие:
kubectl delete pods -A --field-selector=status.phase=Failed
```
Задать `resources.requests/limits.ephemeral-storage`, лимит размера emptyDir, ротацию логов (`containerLogMaxSize`), увеличить диск нод, правильные memory requests.

## [high] Service не работает: нет endpoints
**Симптомы:** обращение к сервису даёт `connection refused`/таймаут, Ingress — 503.

**Диагностика:**
```bash
kubectl get endpointslices -l kubernetes.io/service-name=api    # или kubectl get ep api
kubectl get svc api -o yaml | yq '.spec.selector'
kubectl get pods -l app=api --show-labels                       # совпадают ли метки?
kubectl get pods -l app=api -o wide                             # Ready ли поды?
kubectl run tmp --rm -it --image=nicolaka/netshoot -- curl -sv http://api.ns.svc.cluster.local
```
**Причины:**
- selector не совпадает с метками подов (опечатка, разные `app`/`app.kubernetes.io/name`);
- поды не Ready (провал readinessProbe) → в endpoints их нет;
- `targetPort` не тот, что слушает контейнер, или приложение слушает `127.0.0.1`;
- сервис в другом namespace — нужно полное имя `svc.ns`;
- NetworkPolicy блокирует.

## [high] Ingress отдаёт 404 / 502 / 503
**Диагностика:**
```bash
kubectl get ingress -A; kubectl describe ingress api
kubectl logs -n ingress-nginx deploy/ingress-nginx-controller --tail=200 | grep api
kubectl get ingressclass
```
- **404 от nginx (default backend)** — запрос не совпал ни с одним правилом: другой `host`, `pathType`, не указан/неверный `ingressClassName` (контроллер игнорирует ингресс).
- **503** — у бэкенд-сервиса нет Ready endpoints (см. кейс выше).
- **502** — контроллер не может достучаться до подов: неверный порт, под падает, приложение закрывает соединение (keep-alive timeout приложения меньше, чем у nginx), протокол (HTTPS-бэкенд без аннотации `backend-protocol`).
- **504** — бэкенд отвечает дольше `proxy-read-timeout`.
- **413** — `proxy-body-size`.

## [medium] Под не может разрешить DNS-имена
**Диагностика:**
```bash
kubectl exec -it POD -- cat /etc/resolv.conf
kubectl run dnstest --rm -it --image=busybox:1.36 -- nslookup kubernetes.default
kubectl get pods -n kube-system -l k8s-app=kube-dns
kubectl logs -n kube-system -l k8s-app=kube-dns --tail=50
kubectl get svc -n kube-system kube-dns; kubectl get ep -n kube-system kube-dns
```
**Причины:** CoreDNS не работает/CrashLoop (loop detection, когда upstream — 127.0.0.53 ноды), NetworkPolicy с default-deny egress без разрешения DNS, conntrack-гонки UDP (5-секундные таймауты), перегрузка CoreDNS (мало реплик, ndots:5). Решения: исправить forward в Corefile, разрешить порт 53, NodeLocal DNSCache, масштабировать CoreDNS.

## [critical] Нода NotReady
**Диагностика:**
```bash
kubectl describe node NODE           # Conditions, последние события
# на ноде:
systemctl status kubelet containerd
journalctl -u kubelet -n 100 --no-pager
df -h; free -h; crictl ps
```
**Частые причины:** kubelet остановлен/упал, истёк сертификат kubelet (`x509: certificate has expired`), containerd не отвечает, CNI не инициализирован (`network plugin is not ready: cni config uninitialized`), DiskPressure/MemoryPressure, нода потеряла связь с API (сеть, SG), закончилось место на `/var/lib/containerd`, PLEG is not healthy (рантайм тормозит под нагрузкой).

Через ~5 мин NotReady поды с ноды начнут переезжать (taint `node.kubernetes.io/unreachable:NoExecute`, `tolerationSeconds: 300`); поды StatefulSet не переедут, пока ноду не удалят — защита от split-brain.

## [high] PVC в статусе Pending
**Диагностика:** `kubectl describe pvc NAME` → Events.

**Причины:**
- нет StorageClass по умолчанию и не указан `storageClassName`;
- CSI-драйвер не установлен/не работает (EBS CSI на EKS — отдельный аддон с IAM-ролью);
- `WaitForFirstConsumer` — это нормально, PVC ждёт, пока появится под;
- статический PV не подходит по размеру/accessMode/классу;
- квота/лимит дисков в облаке.

## [high] Multi-Attach error / volume уже подключен к другой ноде
**Симптомы:** `Multi-Attach error for volume "pvc-..." Volume is already exclusively attached to one node`.

**Причина:** RWO-диск может быть подключен только к одной ноде. При переезде пода (нода умерла, rolling update Deployment с RWO-томом и maxSurge) старая привязка не снята.

**Решение:** для Deployment с RWO-томом — стратегия `Recreate`; дождаться отключения тома (6 мин) или удалить VolumeAttachment мёртвой ноды; для shared-доступа — RWX-хранилище (EFS/NFS).

## [medium] CreateContainerConfigError
**Причина:** под ссылается на несуществующий ConfigMap/Secret или ключ в нём (`secret "db" not found`, `couldn't find key password`), либо `runAsNonRoot: true`, а образ запускается от root (`container has runAsNonRoot and image will run as root`).

**Решение:** `kubectl describe pod` → создать объект в **том же namespace**, проверить ключи, задать `runAsUser` или `USER` в Dockerfile.

## [medium] Под или namespace завис в Terminating
**Диагностика и решение:**
```bash
kubectl get pod POD -o jsonpath='{.metadata.finalizers}'
kubectl get ns NS -o json | jq '.spec.finalizers, .status.conditions'
kubectl api-resources --verbs=list --namespaced -o name | xargs -n1 kubectl get -n NS --ignore-not-found --show-kind
kubectl get apiservice | grep False        # недоступный aggregated API блокирует удаление ns
```
- Под на мёртвой ноде: `kubectl delete pod POD --grace-period=0 --force` (только если уверены, что нода мертва — иначе две копии StatefulSet).
- Finalizer без контроллера: `kubectl patch ... -p '{"metadata":{"finalizers":null}}' --type=merge` — только понимая, что внешний ресурс (LB, диск) останется висеть.
- Namespace: починить/удалить сломанный APIService, удалить ресурсы с finalizers.

## [high] Rollout завис: новые поды не становятся Ready
**Симптомы:** `kubectl rollout status` ждёт бесконечно, старые и новые поды одновременно, `progressDeadlineSeconds` → `ProgressDeadlineExceeded`.

**Решение:** разобраться с новыми подами (readiness, логи), быстрый откат — `kubectl rollout undo deploy/x`. В CI использовать `kubectl rollout status --timeout` и автоматический откат; Helm `--atomic` / `--rollback-on-failure`.

## [high] Высокая латентность при низкой загрузке CPU (throttling)
**Диагностика:**
```promql
rate(container_cpu_cfs_throttled_periods_total{container="api"}[5m])
  / rate(container_cpu_cfs_periods_total{container="api"}[5m])
```
Если доля throttled периодов > 10–20% — приложение упирается в CPU limit пачками.

**Решение:** поднять или убрать CPU limit (оставив requests), согласовать число потоков рантайма с лимитом (`GOMAXPROCS`, пулы воркеров), профилировать.

## [critical] x509: certificate has expired (kubeadm-кластер)
**Симптомы:** `kubectl` не подключается, API server/kubelet в логах — истёкший сертификат. Обычно ровно через год после установки, если кластер ни разу не обновлялся.

**Решение (на control plane):**
```bash
kubeadm certs check-expiration
kubeadm certs renew all
# перезапустить статические поды control plane:
mkdir /tmp/m && mv /etc/kubernetes/manifests/*.yaml /tmp/m/ && sleep 20 && mv /tmp/m/*.yaml /etc/kubernetes/manifests/
cp /etc/kubernetes/admin.conf ~/.kube/config
```
kubelet-сертификаты ротируются сами при `rotateCertificates: true`. Профилактика — алерт на срок сертификатов и регулярные апгрейды.

## [high] etcd: database space exceeded / медленный кластер
**Симптомы:** API отвечает ошибкой `etcdserver: mvcc: database space exceeded` (кластер read-only), или всё медленно, `etcd_disk_wal_fsync_duration_seconds` p99 > 10 мс, частая смена лидера.

**Решение:**
```bash
etcdctl endpoint status -w table             # DB SIZE
rev=$(etcdctl endpoint status -w json | jq '.[0].Status.header.revision')
etcdctl compact $rev
etcdctl defrag --endpoints=...               # по очереди на каждом узле
etcdctl alarm disarm
```
Найти, кто пишет много объектов (Events, CRD-операторы, огромные ConfigMap), увеличить `--quota-backend-bytes`, вынести etcd на быстрые SSD.

# @quiz

? Какой компонент единственный общается с etcd напрямую?
- kube-scheduler
- kubelet
+ kube-apiserver
- kube-controller-manager
> Все остальные работают через API server.

? Что произойдёт при провале readinessProbe?
- Контейнер перезапустится
+ Под будет исключён из endpoints сервиса
- Под будет удалён
- Нода станет NotReady
> Перезапуск вызывает только livenessProbe (и startupProbe).

? Под требует 2 CPU в requests, на нодах свободно по 1.5 CPU. Состояние пода:
- Running с throttling
+ Pending с Insufficient cpu
- CrashLoopBackOff
- OOMKilled
> Планировщик учитывает requests.

? QoS-класс пода с requests = limits для CPU и памяти у всех контейнеров:
+ Guaranteed
- Burstable
- BestEffort
- Critical
> Guaranteed выселяется последним.

? Что делает превышение CPU limit?
- OOMKill
+ Throttling
- Eviction
- Рестарт контейнера
> CPU — сжимаемый ресурс, процесс просто замедляется.

? Какой тип Service нужен StatefulSet для стабильных DNS-имён реплик?
- NodePort
- LoadBalancer
+ Headless (clusterIP: None)
- ExternalName
> Headless создаёт DNS-записи для каждого пода.

? Что покажет `kubectl logs POD --previous`?
- Логи предыдущей версии Deployment
+ Логи предыдущего (упавшего) запуска контейнера
- Логи предыдущего пода в ReplicaSet
- События пода
> Незаменимо при CrashLoopBackOff.

? Какой эффект taint выселит уже работающие поды без toleration?
- NoSchedule
- PreferNoSchedule
+ NoExecute
- Evict
> NoSchedule только запрещает новые поды.

? Сколько узлов etcd нужно, чтобы пережить отказ двух?
- 3
- 4
+ 5
- 6
> Кворум = n/2+1: из 5 нужно 3 живых.

? Изменили ConfigMap, подключенный через envFrom. Что нужно, чтобы приложение увидело изменения?
- Ничего, обновится само
+ Перезапустить поды
- Пересоздать ConfigMap
- Перезапустить kubelet
> Переменные окружения читаются только при старте контейнера.

? Почему NetworkPolicy может не работать?
- Нужно перезапустить kube-proxy
+ CNI-плагин не поддерживает NetworkPolicy (например, Flannel)
- NetworkPolicy работает только в default namespace
- Нужно указать ingressClassName
> Политики реализует CNI, а не сам Kubernetes.

? Что блокирует drain ноды при minAvailable равном числу реплик?
- ResourceQuota
+ PodDisruptionBudget
- LimitRange
- HPA
> PDB не разрешит выселить ни одного пода.

? Ingress отдаёт 404 от nginx для всех запросов к новому хосту. Наиболее вероятно:
- Под упал
+ Не совпал host или не указан ingressClassName
- Закончились endpoints
- Сертификат истёк
> 503 было бы при отсутствии endpoints.

? Что нужно HPA для масштабирования по CPU?
- Prometheus
+ metrics-server и заданные requests CPU
- VPA
- Cluster Autoscaler
> Утилизация считается относительно requests.

? Какой компонент создаёт поды по ReplicaSet?
- Scheduler
- kubelet
+ ReplicaSet controller в kube-controller-manager
- API server
> Scheduler только назначает ноду уже созданным подам.
