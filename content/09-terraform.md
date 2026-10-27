---
id: terraform
title: Terraform / OpenTofu
icon: 🏗️
order: 90
group: Оркестрация и IaC
color: #7b42bc
summary: IaC, HCL, state и remote backends, модули, count/for_each, lifecycle, import/moved, окружения, CI/CD и политики, типовые поломки state.
---

# @theory

## IaC и место Terraform

**Infrastructure as Code** — инфраструктура описывается кодом, хранится в Git, проходит ревью и CI, воспроизводима и документирована сама собой.

| Инструмент | Подход | Для чего |
|---|---|---|
| **Terraform / OpenTofu** | декларативный, state, провайдеры для всего | **провижининг**: облака, сети, БД, DNS, K8s-кластеры, SaaS |
| Pulumi / CDKTF | реальные языки (TS, Python, Go) поверх той же модели | то же, если нужна программная логика |
| CloudFormation / Bicep | декларативный, только своё облако | AWS / Azure |
| **Ansible** | процедурный (задачи по порядку), без state, push по SSH | **конфигурирование** ОС и ПО на серверах |
| Crossplane | Kubernetes-контроллеры для облачных ресурсов | инфраструктура как CRD |

**OpenTofu** — форк Terraform под управлением Linux Foundation (после смены лицензии Terraform на BSL в 2023). Совместим по синтаксису, CLI `tofu`, добавляет шифрование state и другие фичи.

### Рабочий цикл
```bash
terraform init          # скачать провайдеры и модули, настроить backend
terraform fmt -recursive
terraform validate
terraform plan -out=tfplan     # что изменится: + create, ~ update, - destroy, -/+ replace
terraform apply tfplan
terraform destroy
terraform output -json
terraform providers; terraform version
```

Как работает: Terraform строит **граф зависимостей** ресурсов, сравнивает **конфигурацию** (желаемое), **state** (что он создал раньше) и **реальное состояние** (refresh через API провайдера) и вычисляет минимальный набор изменений. Независимые ресурсы создаются параллельно (`-parallelism=10`).

## HCL: синтаксис

```hcl main.tf
terraform {
  required_version = ">= 1.6"
  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.60"
    }
  }
  backend "s3" {
    bucket         = "acme-tfstate"
    key            = "prod/network/terraform.tfstate"
    region         = "eu-central-1"
    use_lockfile   = true     # нативная блокировка в S3 (раньше — dynamodb_table)
    encrypt        = true
  }
}

provider "aws" {
  region = var.region
  default_tags { tags = local.tags }
}

locals {
  name = "${var.project}-${var.env}"
  tags = { Project = var.project, Env = var.env, ManagedBy = "terraform" }
}

data "aws_availability_zones" "available" {
  state = "available"
}

resource "aws_vpc" "main" {
  cidr_block           = var.vpc_cidr
  enable_dns_hostnames = true
  tags                 = { Name = local.name }
}

resource "aws_subnet" "private" {
  for_each          = { for i, az in slice(data.aws_availability_zones.available.names, 0, 3) : az => i }
  vpc_id            = aws_vpc.main.id
  availability_zone = each.key
  cidr_block        = cidrsubnet(var.vpc_cidr, 4, each.value)
  tags              = { Name = "${local.name}-private-${each.key}" }
}
```

```hcl variables.tf
variable "env" {
  type        = string
  description = "Окружение"
  validation {
    condition     = contains(["dev", "staging", "prod"], var.env)
    error_message = "env должен быть dev, staging или prod."
  }
}

variable "vpc_cidr" {
  type    = string
  default = "10.10.0.0/16"
}

variable "db_password" {
  type      = string
  sensitive = true
}

variable "instances" {
  type = map(object({
    size = string
    disk = optional(number, 20)
  }))
}
```

```hcl outputs.tf
output "vpc_id" {
  value = aws_vpc.main.id
}
output "private_subnet_ids" {
  value = [for s in aws_subnet.private : s.id]
}
```

### Блоки
| Блок | Назначение |
|---|---|
| `terraform {}` | версии, провайдеры, backend |
| `provider` | настройка провайдера (регион, креды, alias для мульти-региона) |
| `resource` | управляемый ресурс |
| `data` | **чтение** существующего (не управляется) |
| `variable` | входные параметры |
| `output` | выходные значения (для людей, CI и других конфигураций) |
| `locals` | вычисляемые локальные значения |
| `module` | вызов модуля |
| `moved`, `import`, `removed` | рефакторинг и импорт декларативно |
| `check` | проверки/ассерты после apply |

### Откуда берутся значения переменных (по возрастанию приоритета)
`default` → переменные окружения `TF_VAR_name` → `terraform.tfvars` → `*.auto.tfvars` → `-var-file` → `-var` в CLI.

### Выражения и функции
```hcl
# условие
instance_type = var.env == "prod" ? "m6i.large" : "t3.small"
# for-выражения
upper_names = [for n in var.names : upper(n)]
by_name     = { for u in var.users : u.name => u if u.active }
# splat
ids = aws_instance.web[*].id
# функции
cidrsubnet("10.0.0.0/16", 8, 2)      # 10.0.2.0/24
lookup(var.amis, var.region, "ami-default")
merge(local.tags, { Role = "db" })
coalesce(var.name, "default")
try(var.config.port, 8080)
jsonencode({ a = 1 })
templatefile("${path.module}/user-data.sh.tftpl", { env = var.env })
file("${path.module}/policy.json")
```
`terraform console` — интерактивная проверка выражений.

## State

**State** (`terraform.tfstate`) — JSON-сопоставление «ресурс в коде ↔ реальный объект (ID)» плюс атрибуты. Без него Terraform не знает, что уже создано.

### Почему remote backend обязателен в команде
- общий доступ (S3, GCS, Azure Blob, Terraform Cloud/HCP, Consul, PostgreSQL, GitLab);
- **блокировка** (locking) — два `apply` одновременно испортят state;
- шифрование и версионирование (включайте versioning на бакете — это ваш бэкап state);
- **state содержит секреты в открытом виде** (пароли БД, ключи) — нельзя в Git, доступ строго ограничен.

### Команды работы со state
```bash
terraform state list
terraform state show aws_instance.web
terraform state mv aws_instance.web aws_instance.app         # переименовать без пересоздания
terraform state mv 'aws_instance.web' 'module.app.aws_instance.web'
terraform state rm aws_s3_bucket.legacy                       # забыть ресурс (в облаке останется)
terraform state pull > backup.tfstate; terraform state push
terraform import aws_s3_bucket.logs my-logs-bucket            # взять существующий ресурс под управление
terraform force-unlock <LOCK_ID>
terraform plan -refresh-only; terraform apply -refresh-only   # синхронизировать state с реальностью
terraform apply -replace=aws_instance.web                     # принудительно пересоздать (вместо taint)
```

### Декларативный рефакторинг
```hcl refactor.tf
moved {
  from = aws_instance.web
  to   = module.app.aws_instance.this
}

import {
  to = aws_s3_bucket.logs
  id = "my-logs-bucket"
}

removed {
  from = aws_s3_bucket.old
  lifecycle { destroy = false }      # убрать из управления, не удаляя
}
```
`terraform plan -generate-config-out=generated.tf` — сгенерировать код для импортированных ресурсов.

### Drift
Дрейф — изменения инфраструктуры в обход Terraform (руками в консоли). Обнаруживается `plan` (покажет, что вернёт обратно). Регулярный `plan` по расписанию в CI с алертом — хорошая практика.

## count, for_each, dynamic

### count vs for_each
```hcl
# count — список по индексу
resource "aws_instance" "web" {
  count = 3
  tags  = { Name = "web-${count.index}" }
}

# for_each — по ключам map/set
resource "aws_iam_user" "u" {
  for_each = toset(["alice", "bob", "carol"])
  name     = each.key
}
```

> [!warn] Ловушка count
> С `count = length(var.users)` удаление элемента из **середины** списка сдвигает индексы: Terraform пересоздаст все ресурсы после него. `for_each` адресует по ключу (`aws_iam_user.u["bob"]`), поэтому удаление одного элемента трогает только его. Используйте `count` только для «0 или 1» (`count = var.enabled ? 1 : 0`) или действительно одинаковых ресурсов.

Ограничение: ключи `for_each` должны быть известны на этапе plan (нельзя построить из ID ресурсов, которые ещё не созданы).

### dynamic
```hcl
resource "aws_security_group" "web" {
  name   = "web"
  vpc_id = aws_vpc.main.id
  dynamic "ingress" {
    for_each = var.ingress_ports
    content {
      from_port   = ingress.value
      to_port     = ingress.value
      protocol    = "tcp"
      cidr_blocks = ["0.0.0.0/0"]
    }
  }
}
```

## lifecycle и зависимости

```hcl
resource "aws_db_instance" "main" {
  # ...
  lifecycle {
    prevent_destroy       = true                 # plan упадёт при попытке удалить
    create_before_destroy = true                 # сначала создать новый, потом удалить старый
    ignore_changes        = [password, tags["UpdatedBy"]]   # не реагировать на изменения этих полей
    replace_triggered_by  = [aws_launch_template.app.latest_version]
    precondition {
      condition     = var.env != "prod" || var.multi_az
      error_message = "В prod БД должна быть multi-AZ."
    }
  }
}
```

- **Неявные зависимости** — по ссылкам (`aws_vpc.main.id`) — предпочтительный способ.
- **`depends_on`** — явная зависимость, когда связи нет в атрибутах (например, IAM-политика должна быть применена до запуска Lambda). Злоупотребление замедляет план и делает значения «known after apply».
- `-/+` в плане (**replace**) — атрибут меняется только пересозданием (ForceNew): смена AMI, имени бакета, зоны подсети. **Всегда читайте план перед apply**, особенно для stateful-ресурсов.

## Модули

Модуль — каталог с `.tf`-файлами. Корневой модуль — то, где запускаете terraform. Дочерние вызываются блоком `module`.

```hcl
module "vpc" {
  source  = "terraform-aws-modules/vpc/aws"
  version = "5.13.0"

  name            = local.name
  cidr            = "10.10.0.0/16"
  azs             = ["eu-central-1a", "eu-central-1b", "eu-central-1c"]
  private_subnets = ["10.10.1.0/24", "10.10.2.0/24", "10.10.3.0/24"]
  public_subnets  = ["10.10.101.0/24", "10.10.102.0/24", "10.10.103.0/24"]
  enable_nat_gateway = true
  single_nat_gateway = var.env != "prod"
}

module "app" {
  source     = "git::https://git.example.com/infra/modules.git//ecs-service?ref=v2.3.1"
  vpc_id     = module.vpc.vpc_id
  subnet_ids = module.vpc.private_subnets
}
```

Хорошие практики:
- стандартная структура: `main.tf`, `variables.tf`, `outputs.tf`, `versions.tf`, `README.md`, `examples/`;
- **пиннинг версий** модулей (`version` / `?ref=v1.2.3`) и провайдеров;
- модуль делает одну логичную вещь (сеть, кластер, сервис), не «монолит всего»;
- не настраивайте `provider` внутри переиспользуемого модуля — передавайте через `providers = { aws = aws.eu }`;
- документация — `terraform-docs`.

## Окружения и структура проекта

### Варианты разделения dev/stage/prod
1. **Каталоги на окружение** (рекомендуется): `envs/dev`, `envs/prod` — каждый со своим backend key, вызывают общие модули. Явно, изолированно, разные версии модулей.
2. **Workspaces** (`terraform workspace new prod`): один код, разные state. Подходит для одинаковых временных окружений (feature-стенды), но опасно для prod — легко применить не в тот workspace, нет различий в коде.
3. **Terragrunt** — обёртка: DRY-конфигурация backend и провайдеров, зависимости между стеками, `run-all`.

### Декомпозиция state
Не держите всё в одном state: долгий plan, большой «радиус поражения», блокировки. Делите по слоям и частоте изменений: `network` → `k8s-cluster` → `databases` → `apps`. Связь — через `terraform_remote_state` или data sources / SSM-параметры.

```text
infra/
├── modules/
│   ├── vpc/
│   └── eks/
└── live/
    ├── prod/
    │   ├── network/  (backend key: prod/network)
    │   ├── eks/
    │   └── rds/
    └── staging/...
```

### .terraform.lock.hcl
Фиксирует точные версии и хэши провайдеров — **коммитьте** его. Обновление — `terraform init -upgrade`. Для разных платформ: `terraform providers lock -platform=linux_amd64 -platform=darwin_arm64`.

## Terraform в CI/CD и безопасность

### Пайплайн
1. На MR/PR: `fmt -check`, `validate`, линтеры (**tflint**), сканеры безопасности (**checkov**, **trivy config**/tfsec), `plan` → комментарий с планом в PR, **Infracost** (оценка стоимости).
2. Ревью плана человеком.
3. После merge: `apply` **того же** сохранённого плана (`plan -out` → артефакт → `apply tfplan`) с ручным подтверждением для prod.
4. По расписанию — drift detection.

Инструменты: **Atlantis** (plan/apply из комментариев PR), Terraform Cloud/HCP, Spacelift, env0, Digger, GitLab-интеграция.

### Креды
- В CI — **OIDC федерация** (GitHub Actions/GitLab → AWS IAM role через `AssumeRoleWithWebIdentity`) вместо долгоживущих ключей.
- Разные роли для plan (read-only) и apply.
- Секреты в переменных — `sensitive = true` (скрывает из вывода, но **не из state**). Лучше читать секреты из Vault/Secrets Manager через data source или генерировать (random_password → Secrets Manager), а приложение читает их оттуда.
- State: шифрование, минимальный доступ, versioning, (OpenTofu — клиентское шифрование state).

### Политики
OPA/Conftest по JSON плана (`terraform show -json tfplan`), Sentinel (HCP), checkov — «все бакеты зашифрованы», «нет 0.0.0.0/0 на 22», обязательные теги.

## Тестирование

- `terraform validate`, `tflint`, `checkov` — статика.
- `terraform plan` в CI — главный «тест».
- **`terraform test`** (1.6+) — встроенный фреймворк: файлы `*.tftest.hcl` с `run`-блоками и `assert`, с `command = plan` или реальным apply, mock-провайдеры (1.7+).
- **Terratest** (Go) — интеграционные тесты: развернуть, проверить (HTTP-запрос, SSH), уничтожить.

```hcl tests/vpc.tftest.hcl
run "subnets_created" {
  command = plan
  variables { env = "dev" }
  assert {
    condition     = length(aws_subnet.private) == 3
    error_message = "Ожидалось 3 приватные подсети"
  }
}
```

# @interview

## [junior] Что такое Terraform state и зачем он нужен?
Файл, сопоставляющий ресурсы в конфигурации с реальными объектами (ID) и хранящий их атрибуты. Нужен, чтобы вычислять изменения (diff), знать зависимости при удалении, работать быстрее (кэш атрибутов). Без state Terraform не знает, что он уже создал.

## [junior] Почему state нельзя хранить в Git?
Он содержит секреты в открытом виде, в Git нет блокировок — параллельные изменения испортят state, легко закоммитить устаревшую версию. Нужен remote backend (S3 + блокировка, GCS, Terraform Cloud) с шифрованием, версионированием и ограниченным доступом.

## [middle] Что такое state locking и что будет без него?
Блокировка state на время операции, изменяющей его (plan/apply). Без неё два одновременных apply могут прочитать один state и записать конфликтующие версии — потеря ресурсов из state, дубли, поломка. В S3 — lock-файл (`use_lockfile`) или DynamoDB-таблица, в GCS/Azure/HCP — встроенная.

## [middle] Чем count отличается от for_each?
`count` создаёт N экземпляров по числовому индексу; удаление элемента из середины списка сдвигает индексы и пересоздаёт ресурсы. `for_each` работает по ключам map/set — каждый экземпляр адресуется стабильным ключом. for_each предпочтительнее для коллекций, count — для условного создания (0/1).

## [middle] Что такое data source?
Блок `data` для чтения информации о существующих объектах (AMI, VPC, зоны, секреты, ресурсы из другого state), которыми этот код не управляет. Data source не создаёт и не удаляет ресурсы.

## [middle] Как взять под управление Terraform ресурс, созданный вручную?
`terraform import` (CLI) или декларативный блок `import { to = ..., id = ... }` + написать соответствующий код ресурса (или сгенерировать: `plan -generate-config-out`). Затем `plan` должен показать «no changes» — подгоняем код под реальность.

## [middle] Как переименовать ресурс или перенести его в модуль без пересоздания?
Блок `moved { from = ..., to = ... }` (предпочтительно, видно в ревью) или `terraform state mv`. Без этого Terraform удалит старый адрес и создаст новый.

## [middle] Что делает lifecycle prevent_destroy, create_before_destroy, ignore_changes?
`prevent_destroy` — ошибка при попытке удалить ресурс (защита БД, бакетов). `create_before_destroy` — при замене сначала создаётся новый объект (без простоя; нужны уникальные имена). `ignore_changes` — игнорировать изменения указанных атрибутов (меняются вне Terraform: теги автоскейлинга, пароль после ротации, desired_count под автоскейлингом).

## [middle] Workspaces или отдельные каталоги для окружений?
Каталоги/отдельные root-модули на окружение: явная изоляция, разные backend, легко сделать различия и разные версии модулей, меньше риск применить не туда. Workspaces удобны для однотипных эфемерных окружений из одного кода. Для prod/stage обычно выбирают каталоги (или Terragrunt).

## [middle] Что такое drift и как с ним бороться?
Расхождение реальной инфраструктуры с кодом/state из-за ручных изменений или внешних процессов. Обнаружение — регулярный `terraform plan` (или `-refresh-only`) в CI с алертами. Борьба: запрет ручных изменений (IAM, read-only консоль), импорт/отражение изменений в код или их откат через apply.

## [middle] Что значит -/+ в выводе plan?
Ресурс будет пересоздан (destroy + create), потому что изменился атрибут, который нельзя поменять на месте (ForceNew). Для stateful-ресурсов (БД, диски) это потеря данных — нужно внимательно читать план, использовать `prevent_destroy`, `create_before_destroy`, или менять подход.

## [senior] Как организовать Terraform для большой компании с десятками команд?
Слои и разделение state (сеть, общие сервисы, кластеры, приложения), версионированные внутренние модули в реестре, стандарты (структура, теги, naming), единый пайплайн (PR → fmt/validate/tflint/checkov/plan/infracost → ревью → apply), OIDC-креды с минимальными правами, политики как код (OPA/Sentinel), drift detection, Terragrunt или платформы (Atlantis, Spacelift, HCP), self-service через модули/шаблоны.

## [senior] Как безопасно обращаться с секретами в Terraform?
Помнить, что все значения попадают в state. Минимизировать секреты в state (генерировать пароль через random_password и класть в Secrets Manager; использовать IAM-аутентификацию к БД; managed master passwords RDS), шифровать state и ограничивать доступ, помечать переменные `sensitive`, не передавать секреты через CLI-аргументы, использовать ephemeral-ресурсы/write-only атрибуты (1.10+/1.11+), которые не сохраняются в state.

## [middle] Что такое провайдер? Как зафиксировать версии?
Плагин, реализующий ресурсы и data sources для конкретного API (AWS, Kubernetes, GitHub, Cloudflare). Версии — в `required_providers` с ограничениями (`~> 5.60`), точные версии и хэши фиксируются в `.terraform.lock.hcl`, который коммитится.

## [middle] Чем Terraform отличается от Ansible?
Terraform — декларативный провижининг инфраструктуры с state и графом зависимостей, идеально для облачных ресурсов. Ansible — процедурное конфигурирование серверов (пакеты, файлы, сервисы) без state, идемпотентность обеспечивают модули. Часто вместе: Terraform создаёт ВМ, Ansible их настраивает (или образы собираются Packer'ом).

## [junior] Что делает terraform init?
Инициализирует рабочий каталог: настраивает backend, скачивает провайдеры (с учётом lock-файла) и модули. Нужно запускать после клонирования, смены backend, добавления модулей/провайдеров.

## [senior] Как разделить state и передавать значения между стеками?
Делить по жизненному циклу и ответственности. Передача: `terraform_remote_state` (читает outputs другого state — но даёт доступ ко всему state), лучше — публиковать значения в SSM Parameter Store/Consul и читать data source, или data source по тегам (найти VPC по тегу), или Terragrunt `dependency`.

# @troubleshooting

## [high] Error acquiring the state lock
**Симптомы:** `Error: Error acquiring the state lock ... Lock Info: ID: 9db590f1-...  Who: runner@ci  Created: ...`.

**Диагностика:** кто держит блокировку — другой пайплайн/коллега прямо сейчас? Или процесс упал и не снял lock (отменили CI-джобу, обрыв сети)?

**Решение:** если операция действительно идёт — ждать. Если «мёртвый» lock:
```bash
terraform force-unlock 9db590f1-...
```
Никогда не делайте force-unlock, пока не убедились, что никто не применяет изменения. Профилактика: сериализация apply в CI (concurrency group, resource_group в GitLab), не убивать terraform по SIGKILL.

## [high] Ресурс удалили вручную — plan/apply падает
**Симптомы:** ошибки 404/`NotFound` при refresh, или план хочет создать ресурс заново, а зависимые ресурсы ломаются.

**Решение:** обычно `terraform plan` сам заметит отсутствие и предложит создать заново. Если ресурс больше не нужен — удалить из кода и `terraform state rm`. Если plan падает на провайдере — `terraform apply -refresh-only` или `state rm` с последующим импортом/созданием.

## [critical] Plan неожиданно хочет пересоздать ресурс (-/+)
**Диагностика:** в плане рядом с атрибутом — `# forces replacement`.

**Частые причины:** изменился ForceNew-атрибут (имя, AZ, AMI, user_data у некоторых ресурсов); обновили провайдер/модуль, и дефолт изменился; сместились индексы `count`; переименовали ресурс без `moved`; значение «known after apply» из-за `depends_on` на data source.

**Решение:** не применять! Использовать `moved`, перейти на `for_each`, `ignore_changes` для атрибута, зафиксировать версию модуля, вернуть значение. Для stateful-ресурсов — `prevent_destroy`.

## [medium] Cycle error
**Симптомы:** `Error: Cycle: aws_security_group.a, aws_security_group.b`.

**Причина:** ресурсы ссылаются друг на друга (две SG с inline-правилами, разрешающими друг друга).

**Решение:** разорвать цикл: вынести правила в отдельные ресурсы (`aws_vpc_security_group_ingress_rule`), убрать лишний `depends_on`, разделить на этапы. `terraform graph | dot -Tsvg` помогает увидеть.

## [medium] Invalid for_each argument: value depends on resource attributes that cannot be determined until apply
**Причина:** ключи for_each вычисляются из атрибутов ещё не созданных ресурсов (ID).

**Решение:** строить ключи из известных статически значений (имена из переменных), а атрибуты использовать только в значениях map; в крайнем случае — `-target` для двухэтапного применения (не как постоянная практика).

## [high] Повреждённый или потерянный state
**Решение:**
- Восстановить предыдущую версию из versioning бакета (S3 versions / GCS generations) или из `terraform.tfstate.backup`.
- `terraform state pull > current.json` перед любой ручной правкой; правка через `state push` (с увеличенным `serial`).
- Если state потерян полностью — заново импортировать ресурсы (`import`-блоки, инструменты вроде terraformer для генерации).

Профилактика: versioning + запрет удаления на бакете state, отдельный аккаунт/проект для state, бэкапы.

## [medium] Провайдер не совпадает с lock-файлом
**Симптомы:** `the cached package for registry.terraform.io/hashicorp/aws 5.x does not match any of the checksums recorded in the dependency lock file` (часто — другая ОС/архитектура в CI) или `locked provider ... does not match configured version constraint`.

**Решение:** `terraform init -upgrade` (осознанно обновить), `terraform providers lock -platform=linux_amd64 -platform=darwin_arm64 -platform=linux_arm64` и закоммитить lock-файл.

## [medium] Изменение сделано руками, plan хочет откатить
**Решение:** решить, кто прав. Если изменение нужно — отразить его в коде (plan покажет «No changes»). Если нет — `apply` вернёт как было. Если атрибут законно меняется извне (autoscaling desired_count) — `lifecycle.ignore_changes`.

# @quiz

? Что произойдёт при удалении элемента из середины списка, используемого в count?
- Удалится только этот ресурс
+ Ресурсы после него будут пересозданы из-за сдвига индексов
- Terraform выдаст ошибку
- Ничего
> for_each по ключам этой проблемы не имеет.

? Какая команда переименует ресурс в state без пересоздания?
- terraform rename
+ terraform state mv
- terraform import
- terraform taint
> Или декларативно — блок moved.

? Где хранить state для команды?
- В Git
- Локально у каждого
+ В remote backend с блокировкой и шифрованием
- В Docker-образе
> S3/GCS/Azure Blob/HCP и т.п.

? Что делает `lifecycle { create_before_destroy = true }`?
+ При замене сначала создаёт новый ресурс, затем удаляет старый
- Запрещает удаление
- Игнорирует изменения
- Создаёт резервную копию
> Помогает избежать простоя при замене.

? Помечает ли `sensitive = true` значение как скрытое в state?
- Да, значение шифруется в state
+ Нет, оно скрыто только в выводе CLI, в state хранится открыто
- Да, значение не сохраняется в state
- Только в remote backend
> Защищайте сам state.

? Что фиксирует файл .terraform.lock.hcl?
- Блокировку state
+ Версии и хэши провайдеров
- Версии модулей
- Значения переменных
> Его нужно коммитить в репозиторий.

? Какой блок позволяет импортировать существующий ресурс декларативно?
- data
- moved
+ import
- removed
> Доступен с Terraform 1.5.

? `terraform plan` показывает `~ update in-place`. Это значит:
- Ресурс будет удалён и создан
+ Ресурс изменится без пересоздания
- Ресурс будет прочитан
- Ресурс удалён вне Terraform
> Пересоздание — `-/+`.
