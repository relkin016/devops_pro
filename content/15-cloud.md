---
id: cloud
title: Облака (AWS и др.)
icon: ☁️
order: 150
group: Эксплуатация
color: #ff9900
summary: Модели облаков, регионы и AZ, VPC, IAM, вычисления, хранилища, managed БД, EKS, serverless, сравнение AWS/GCP/Azure, FinOps и Well-Architected.
---

# @theory

## Модели и основы

| Модель | Вы управляете | Провайдер управляет | Примеры |
|---|---|---|---|
| **IaaS** | ОС, рантайм, приложение, данные | железо, сеть, виртуализация | EC2, Compute Engine |
| **PaaS** | приложение и данные | всё до рантайма | Elastic Beanstalk, App Engine, Heroku, Cloud Run |
| **SaaS** | только настройки и данные | всё | Gmail, Slack |
| **FaaS (serverless)** | код функции | всё, включая масштабирование | Lambda, Cloud Functions |
| **CaaS** | контейнеры | оркестрацию | ECS, EKS, GKE, Fargate |

**Shared responsibility model**: провайдер отвечает за безопасность **облака** (ЦОДы, железо, гипервизор), вы — за безопасность **в облаке** (IAM, конфигурация, данные, патчи ОС на IaaS, шифрование).

### Регионы и зоны
- **Регион** — географическая область (eu-central-1 — Франкфурт), полностью независимая.
- **Availability Zone (AZ)** — один или несколько изолированных ЦОДов в регионе с отдельным питанием и сетью, низкой задержкой между ними (< 2 мс).
- **Edge locations** — точки присутствия CDN (CloudFront) и DNS (Route 53).
- Высокая доступность — **multi-AZ** (2–3 зоны). Катастрофоустойчивость — **multi-region**.

## Сеть: VPC

```text
VPC 10.0.0.0/16 (eu-central-1)
├── Public subnet  10.0.0.0/24  (AZ a)  → route 0.0.0.0/0 → Internet Gateway   [ALB, NAT GW, bastion]
├── Public subnet  10.0.1.0/24  (AZ b)
├── Private subnet 10.0.10.0/24 (AZ a)  → route 0.0.0.0/0 → NAT Gateway (AZ a) [приложения, EKS-ноды]
├── Private subnet 10.0.11.0/24 (AZ b)  → NAT Gateway (AZ b)
├── DB subnet      10.0.20.0/24 (AZ a)  → без выхода в интернет                [RDS]
└── DB subnet      10.0.21.0/24 (AZ b)
```

| Компонент | Назначение |
|---|---|
| **VPC** | изолированная виртуальная сеть с CIDR |
| **Subnet** | подсеть в **одной** AZ; «публичная» = есть маршрут в IGW |
| **Internet Gateway** | вход/выход в интернет для ресурсов с публичным IP |
| **NAT Gateway** | только исходящий интернет для приватных подсетей (платный, по одному на AZ для HA) |
| **Route table** | маршруты подсети |
| **Security Group** | stateful файрвол на уровне ENI, только allow, ссылки на другие SG |
| **NACL** | stateless файрвол на уровне подсети, allow/deny, по номерам правил |
| **VPC Endpoints** | приватный доступ к сервисам AWS без интернета: Gateway (S3, DynamoDB — бесплатно), Interface (PrivateLink) |
| **VPC Peering** | связь двух VPC (не транзитивная, CIDR не должны пересекаться) |
| **Transit Gateway** | хаб для множества VPC и VPN/Direct Connect |
| **Site-to-Site VPN / Direct Connect** | связь с on-prem (через интернет / выделенный канал) |
| **Flow Logs** | логи сетевых потоков для отладки и безопасности |

> [!tip] NAT Gateway — частая статья расходов
> Трафик из приватных подсетей к S3/ECR через NAT тарифицируется за ГБ. Gateway Endpoint для S3 бесплатен, Interface Endpoints для ECR/STS/CloudWatch часто окупаются.

## IAM

| Сущность | Что это |
|---|---|
| **User** | человек или приложение с долгоживущими кредами (избегать для приложений) |
| **Group** | набор пользователей для назначения политик |
| **Role** | набор прав, который **принимают** (assume) — сервисы, пользователи из SSO, другие аккаунты, OIDC (CI, K8s); выдаёт **временные** креды через STS |
| **Policy** | JSON-документ с разрешениями |

```json policy.json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": ["s3:GetObject", "s3:PutObject"],
      "Resource": "arn:aws:s3:::acme-uploads/*",
      "Condition": { "StringEquals": { "aws:RequestedRegion": "eu-central-1" } }
    }
  ]
}
```

### Логика вычисления прав
1. По умолчанию всё **запрещено** (implicit deny).
2. Явный **Allow** в любой применимой политике разрешает...
3. ...но явный **Deny** в любой политике побеждает всё.
4. Плюс ограничители: **SCP** (Organizations — потолок для аккаунта), permission boundaries, resource-based policies (политика бакета, KMS-ключа), session policies.

Типы политик: identity-based (на user/role), **resource-based** (на ресурсе: S3 bucket policy, SQS, KMS — позволяет кросс-аккаунтный доступ), trust policy (кто может assume роль).

Практики: **least privilege**, никаких access keys у root, MFA, SSO (IAM Identity Center) для людей, **роли для EC2 (instance profile), Lambda, подов (IRSA/Pod Identity), CI (OIDC)** — без статических ключей, отдельные аккаунты для prod/staging/security (AWS Organizations + Control Tower), IAM Access Analyzer.

## Вычисления

### EC2
- Типы: `t` (burstable, CPU-кредиты!), `m` (general), `c` (compute), `r`/`x` (memory), `i` (storage NVMe), `g`/`p` (GPU); суффикс `g` — Graviton (ARM, дешевле на 20–40%).
- Модели оплаты: **On-Demand**, **Reserved Instances / Savings Plans** (1–3 года, до −72%), **Spot** (до −90%, могут отозвать с предупреждением за 2 минуты — для stateless, batch, CI, K8s-нод с Karpenter).
- **AMI** — образ; собирать «золотые» образы Packer'ом.
- **User data** / cloud-init — скрипт первого запуска.
- **Instance metadata** (`169.254.169.254`) — используйте **IMDSv2** (токен), защищает от SSRF-кражи кредов.
- Хранилище: **EBS** (сетевые диски: gp3 — дефолт, io2 — гарантированные IOPS; снапшоты в S3), **instance store** (локальный NVMe, теряется при остановке).

### Масштабирование и балансировка
- **Auto Scaling Group**: launch template, min/max/desired, политики (target tracking по CPU/RPS), health checks (EC2/ELB), instance refresh для обновления.
- **ELB**: **ALB** (L7: HTTP/HTTPS, маршрутизация по хостам/путям, WAF, OIDC-аутентификация), **NLB** (L4: TCP/UDP/TLS, статические IP, миллионы RPS, сохранение IP клиента), GWLB (для appliance).

### Контейнеры и serverless
- **ECS** (оркестратор AWS) / **EKS** (managed Kubernetes) / **Fargate** (serverless-вычисления для подов/задач, без управления нодами).
- **Lambda**: функция по событию (API Gateway, S3, SQS, EventBridge, cron), оплата за мс выполнения, лимит 15 мин, холодные старты, конкурентность (reserved/provisioned). Логи — CloudWatch.
- **ECR** — реестр образов.

## Хранилища

| Сервис | Тип | Когда |
|---|---|---|
| **S3** | объектное | файлы, бэкапы, артефакты, статика, data lake, state Terraform |
| **EBS** | блочное (один инстанс, одна AZ) | диски ВМ, БД на EC2 |
| **EFS** | файловое NFS (много инстансов, multi-AZ) | общие файлы, RWX-тома K8s |
| **FSx** | Windows/Lustre/NetApp/OpenZFS | специфичные нагрузки |
| **S3 Glacier** | архив | долгосрочное хранение |

### S3
- Бакет (глобально уникальное имя) → объекты по ключам. Durability 11 девяток.
- Классы: Standard, Intelligent-Tiering, Standard-IA, One Zone-IA, Glacier Instant/Flexible/Deep Archive. **Lifecycle policies** переводят/удаляют объекты по возрасту.
- **Versioning** (защита от удаления/перезаписи), **Object Lock** (WORM, защита бэкапов от шифровальщиков), репликация (CRR/SRR).
- Доступ: **Block Public Access** (включён по умолчанию — не отключайте без причины), bucket policy, IAM, presigned URLs для временного доступа, шифрование SSE-S3/SSE-KMS.
- Сильная консистентность read-after-write (с 2020).

## Managed базы и другие сервисы

| AWS | Что это | GCP | Azure |
|---|---|---|---|
| EC2 | ВМ | Compute Engine | Virtual Machines |
| EKS | Kubernetes | GKE | AKS |
| Lambda | функции | Cloud Functions / Cloud Run | Functions |
| S3 | объектное хранилище | Cloud Storage | Blob Storage |
| RDS / Aurora | реляционные БД | Cloud SQL / AlloyDB / Spanner | Azure SQL / Database for PostgreSQL |
| DynamoDB | NoSQL key-value | Firestore / Bigtable | Cosmos DB |
| ElastiCache | Redis/Valkey/Memcached | Memorystore | Cache for Redis |
| SQS / SNS | очередь / pub-sub | Pub/Sub | Service Bus / Event Grid |
| MSK | Kafka | (Managed Kafka) | Event Hubs |
| VPC | сеть | VPC (глобальная!) | VNet |
| Route 53 | DNS | Cloud DNS | Azure DNS |
| CloudFront | CDN | Cloud CDN | Front Door |
| IAM | доступ | IAM | Entra ID + RBAC |
| CloudWatch | метрики/логи | Cloud Monitoring/Logging | Azure Monitor |
| CloudTrail | аудит API | Cloud Audit Logs | Activity Log |
| KMS / Secrets Manager | ключи / секреты | Cloud KMS / Secret Manager | Key Vault |
| CloudFormation | IaC | Deployment Manager / Infrastructure Manager | ARM / Bicep |

### RDS
Managed PostgreSQL/MySQL/MariaDB/Oracle/SQL Server: автоматические бэкапы и PITR (до 35 дней), **Multi-AZ** (синхронная standby в другой AZ, автоматический failover за 1–2 мин через DNS), **Read Replicas** (асинхронные, в т.ч. кросс-регион), Parameter Groups, Performance Insights, патчи в окно обслуживания. **Aurora** — облачная архитектура хранилища (6 копий в 3 AZ), быстрый failover, до 15 реплик, Serverless v2.

### Наблюдаемость и аудит
- **CloudWatch**: метрики (у EC2 по умолчанию **нет метрик памяти и диска** — нужен CloudWatch Agent), логи, алармы, дашборды.
- **CloudTrail**: кто, когда и какой API вызвал — обязателен для безопасности и расследований.
- **AWS Config**: история конфигурации ресурсов и правила соответствия.
- **GuardDuty** (обнаружение угроз), **Security Hub**, **Inspector** (уязвимости).

## Well-Architected и FinOps

### AWS Well-Architected Framework — 6 столпов
1. **Operational Excellence** — IaC, автоматизация, observability, учимся на инцидентах.
2. **Security** — IAM least privilege, шифрование, трассируемость, защита на всех уровнях.
3. **Reliability** — multi-AZ, автоматическое восстановление, бэкапы, тестирование отказов, квоты.
4. **Performance Efficiency** — правильные типы ресурсов, serverless, кэш, CDN.
5. **Cost Optimization** — платить только за нужное, измерять.
6. **Sustainability** — эффективность использования ресурсов.

### Оптимизация затрат (FinOps)
- **Rightsizing** — инстансы по фактической загрузке (Compute Optimizer).
- **Savings Plans/RI** на базовую нагрузку, **Spot** на прерываемую, автоскейлинг на пики.
- **Graviton** (ARM).
- Выключать dev/staging ночью и в выходные.
- Удалять «сирот»: неподключенные EBS, старые снапшоты, неиспользуемые Elastic IP, LB без таргетов.
- S3 lifecycle и Intelligent-Tiering; gp2 → gp3.
- Сетевые расходы: **трафик между AZ и NAT Gateway** — частые скрытые траты; VPC Endpoints.
- **Теги** (owner, team, env, cost-center) + Cost Explorer, бюджеты и алерты (AWS Budgets), аномалии (Cost Anomaly Detection).

# @interview

## [junior] Чем регион отличается от зоны доступности?
Регион — отдельная географическая область со своим набором сервисов и полной изоляцией. AZ — изолированный ЦОД (или группа) внутри региона с независимым питанием и сетью, связанный с другими AZ низколатентными каналами. HA строится на нескольких AZ, DR — на нескольких регионах.

## [junior] Чем публичная подсеть отличается от приватной?
У публичной в таблице маршрутизации есть маршрут `0.0.0.0/0` на Internet Gateway, и ресурсы с публичным IP доступны из интернета. У приватной нет прямого маршрута в IGW; исходящий доступ — через NAT Gateway, входящий из интернета невозможен напрямую.

## [middle] Чем Security Group отличается от NACL?
SG — stateful (ответный трафик разрешён автоматически), на уровне сетевого интерфейса, только разрешающие правила, может ссылаться на другие SG. NACL — stateless (нужно разрешать и ответный трафик на эфемерные порты), на уровне подсети, разрешающие и запрещающие правила, обрабатываются по порядку номеров.

## [middle] Как приложению на EC2 получить доступ к S3 без ключей?
Назначить инстансу IAM-роль через instance profile. SDK автоматически получает временные креды из metadata-сервиса (IMDSv2) и обновляет их. Для подов в EKS — IRSA/Pod Identity, для Lambda — execution role, для CI — OIDC.

## [middle] Как AWS вычисляет, разрешён ли запрос?
По умолчанию — неявный запрет. Собираются все применимые политики (SCP, permission boundary, identity-based, resource-based, session policy). Если где-то есть явный Deny — запрет. Иначе нужен Allow во всех «ограничивающих» слоях (SCP, boundary) и хотя бы в одной политике, дающей права (identity или resource).

## [middle] Что такое IMDSv2 и зачем он нужен?
Вторая версия metadata-сервиса EC2, требующая предварительного получения сессионного токена через PUT-запрос с заголовком. Защищает от SSRF-атак, когда уязвимое приложение можно заставить сделать GET к `169.254.169.254` и украсть креды роли (как в инциденте Capital One).

## [middle] Чем ALB отличается от NLB?
ALB — L7 (HTTP/HTTPS/gRPC): маршрутизация по хосту, пути, заголовкам, WAF, аутентификация, sticky sessions. NLB — L4 (TCP/UDP/TLS): сверхнизкая задержка и высокая пропускная способность, статический IP на AZ, сохранение IP клиента, PrivateLink.

## [middle] Как спроектировать отказоустойчивое веб-приложение в AWS?
VPC в 2–3 AZ с публичными и приватными подсетями, ALB в публичных подсетях, приложение в ASG/EKS в приватных подсетях по нескольким AZ, RDS Multi-AZ (+ read replicas), ElastiCache с репликацией, статика в S3 + CloudFront, NAT Gateway в каждой AZ, Route 53 health checks, бэкапы и мониторинг (CloudWatch, алармы), IaC (Terraform), секреты в Secrets Manager.

## [middle] Как снизить расходы на облако?
Rightsizing, автоскейлинг и выключение неиспользуемого, Savings Plans/RI для постоянной нагрузки, Spot для прерываемой, Graviton, lifecycle-политики хранилищ, gp3, удаление сирот, оптимизация сетевого трафика (VPC endpoints, меньше межзонального трафика), теги и бюджеты с алертами, регулярный FinOps-анализ.

## [middle] Что такое Spot-инстансы и когда их использовать?
Свободные мощности со скидкой до 90%, которые AWS может забрать с уведомлением за 2 минуты. Подходят для stateless и устойчивых к прерыванию нагрузок: batch, CI-раннеры, обработка очередей, ноды K8s (с Karpenter, PDB, диверсификацией типов). Не подходят для одиночных stateful-сервисов.

## [middle] Чем RDS Multi-AZ отличается от Read Replica?
Multi-AZ — синхронная standby-копия в другой AZ только для отказоустойчивости (автоматический failover), обычно не принимает чтение (кроме Multi-AZ cluster). Read Replica — асинхронная реплика для масштабирования чтения (можно в другом регионе), может быть вручную промоутирована, failover не автоматический (для обычного RDS).

## [senior] Как организовать мультиаккаунтную структуру в AWS?
AWS Organizations с OU (Security, Infrastructure, Workloads-Prod, Workloads-NonProd, Sandbox), Control Tower/Landing Zone, SCP-ограничения (запрет отключать CloudTrail, разрешённые регионы), централизованные аккаунты логов и безопасности, IAM Identity Center для доступа людей, сеть через Transit Gateway или shared VPC, централизованный биллинг и теги.

## [middle] Что такое VPC Endpoint и зачем он нужен?
Приватное подключение из VPC к сервисам AWS без интернета/NAT. Gateway endpoint (S3, DynamoDB) — запись в таблице маршрутизации, бесплатно. Interface endpoint (PrivateLink) — ENI в подсети для других сервисов (ECR, STS, Secrets Manager), платно. Повышает безопасность и снижает расходы на NAT.

## [middle] Shared responsibility model — что это?
Разделение ответственности за безопасность: провайдер — за физическую инфраструктуру, железо, сеть и виртуализацию («безопасность облака»), клиент — за данные, IAM, конфигурацию сервисов, сетевые правила, ОС и приложения на IaaS («безопасность в облаке»). Чем выше уровень сервиса (SaaS), тем больше берёт провайдер.

# @troubleshooting

## [high] Не удаётся подключиться к EC2 по SSH
**Проверить по порядку:**
1. Инстанс running, status checks 2/2 (иначе — проблемы ОС/железа: system log, serial console).
2. **Security Group**: входящий TCP 22 с вашего IP.
3. **NACL** подсети: разрешены входящий 22 и **исходящие эфемерные порты** (1024–65535).
4. **Маршрутизация**: публичная подсеть с маршрутом в IGW, у инстанса есть публичный IP / Elastic IP.
5. Правильный пользователь (`ec2-user`, `ubuntu`, `admin`) и ключ (key pair при создании).
6. Внутри ОС: sshd работает, файрвол ОС, диск не переполнен.

Альтернативы: **SSM Session Manager** (без открытого 22 порта, нужна роль `AmazonSSMManagedInstanceCore` и выход к endpoints SSM), **EC2 Instance Connect**, **EC2 Serial Console**.

## [high] AccessDenied при обращении к AWS API
**Диагностика:**
```bash
aws sts get-caller-identity                         # кто я на самом деле (какая роль/аккаунт)
aws iam simulate-principal-policy --policy-source-arn <role-arn> --action-names s3:GetObject --resource-arns arn:aws:s3:::bucket/key
```
Сообщение об ошибке часто содержит, **какой тип политики** отказал (`explicit deny in a service control policy`, `no identity-based policy allows`). CloudTrail → событие с `errorCode: AccessDenied`.

**Частые причины:** не та роль (другие креды в env-переменных перекрывают профиль), нет Allow на нужное действие/ресурс (неверный ARN: бакет `arn:aws:s3:::b` vs объекты `arn:aws:s3:::b/*`), Deny в SCP/boundary, bucket policy или KMS key policy не разрешает (для SSE-KMS нужны права на `kms:Decrypt`), условие (регион, VPC endpoint, MFA).

## [high] S3: 403 Forbidden при доступе к объекту
**Причины:** Block Public Access при попытке сделать объект публичным, отсутствует право в IAM или bucket policy, объект зашифрован KMS-ключом без прав на ключ, объект загружен другим аккаунтом (Object Ownership — используйте `BucketOwnerEnforced`), presigned URL истёк или подписан кредами без прав, доступ через VPC endpoint с ограничивающей политикой.

## [medium] Приватные инстансы не выходят в интернет
**Проверить:** таблица маршрутов приватной подсети содержит `0.0.0.0/0 → nat-xxx`; NAT Gateway в **публичной** подсети (с маршрутом в IGW) и в статусе Available; SG инстанса разрешает исходящий трафик; NACL разрешает исходящий и ответный; DNS (`enableDnsSupport`). Для доступа к S3/ECR без интернета — VPC endpoints.

## [high] Ноды EKS не присоединяются к кластеру
**Причины:** роль ноды не прописана в `aws-auth` ConfigMap / Access Entries; SG нод и control plane не разрешают трафик (443, 10250); ноды в приватных подсетях без NAT/endpoints не могут скачать образы из ECR и достучаться до API; несоответствие версий AMI и кластера; ошибки bootstrap/nodeadm в user data (смотреть `/var/log/cloud-init-output.log` и `journalctl -u kubelet` на ноде).

## [medium] Неожиданно большой счёт
**Диагностика:** Cost Explorer по сервисам и тегам, по Usage Type (`DataTransfer`, `NatGateway-Bytes`, `EBS:SnapshotUsage`), Cost Anomaly Detection.

**Частые виновники:** NAT Gateway трафик (поды качают образы через NAT), межзональный трафик, забытые инстансы/GPU в другом регионе, неподключенные EBS и старые снапшоты, CloudWatch Logs без ретенции, S3 без lifecycle, утёкшие ключи (майнинг!), Lambda в бесконечном цикле.

# @quiz

? Чем определяется, что подсеть в AWS публичная?
- Флагом public при создании
+ Маршрутом 0.0.0.0/0 на Internet Gateway в её route table
- Наличием NAT Gateway внутри
- CIDR-диапазоном
> Плюс у инстанса должен быть публичный IP.

? Что произойдёт, если в одной политике Allow, а в SCP — Deny на то же действие?
- Allow победит
+ Запрос будет запрещён
- Зависит от порядка политик
- Будет запрошено MFA
> Явный Deny побеждает всегда.

? Какой тип балансировщика нужен для маршрутизации по пути URL?
+ ALB
- NLB
- GWLB
- Classic LB только
> ALB работает на L7.

? Какие метрики EC2 не доступны в CloudWatch по умолчанию?
- CPUUtilization
- NetworkIn
+ Использование памяти и места на диске
- StatusCheckFailed
> Нужен CloudWatch Agent.

? Как бесплатно убрать трафик к S3 из приватных подсетей с NAT Gateway?
- Interface endpoint
+ Gateway endpoint для S3
- Peering
- Transit Gateway
> Gateway endpoint для S3/DynamoDB не тарифицируется.

? Какой тип инстансов может быть отозван провайдером с предупреждением за 2 минуты?
- Reserved
- On-Demand
+ Spot
- Dedicated
> Подходит для прерываемых нагрузок.

? Зачем нужен IMDSv2?
+ Защита от кражи кредов роли через SSRF
- Ускорение получения метаданных
- Шифрование EBS
- Доступ к метаданным из интернета
> Требует токен, полученный через PUT.
