---
id: tools
title: Другие инструменты
icon: 🧰
order: 165
group: Эксплуатация
color: #6e7681
summary: Service mesh (Istio, Linkerd), Packer и cloud-init, Consul и Nomad, Vagrant, Make, платформенная инженерия и Backstage, полезные CLI на каждый день.
---

# @theory

## Service mesh

Service mesh выносит сетевую логику межсервисного взаимодействия из кода в инфраструктуру: **data plane** (прокси рядом с каждым сервисом — sidecar Envoy, или ambient/eBPF без sidecar) и **control plane** (раздаёт конфигурацию и сертификаты).

Что даёт:
- **mTLS** между всеми сервисами автоматически, с ротацией сертификатов, identity сервисов (SPIFFE).
- **Управление трафиком**: canary по весам, маршрутизация по заголовкам, зеркалирование, ретраи, таймауты, circuit breaking (outlier detection), fault injection.
- **Наблюдаемость**: единые метрики RED и трейсы для всех сервисов без изменения кода.
- **Авторизация** межсервисных вызовов (AuthorizationPolicy).

| | Istio | Linkerd | Cilium Service Mesh |
|---|---|---|---|
| Прокси | Envoy (sidecar) или **ambient** (ztunnel + waypoint) | свой лёгкий linkerd2-proxy на Rust | eBPF + Envoy на ноде |
| Сложность | высокая, очень гибкий | простой, «работает из коробки» | средняя, интегрирован с CNI |
| Ресурсы | больше | меньше | меньше |

```yaml istio-canary.yaml
apiVersion: networking.istio.io/v1
kind: VirtualService
metadata: { name: api }
spec:
  hosts: [api]
  http:
    - route:
        - destination: { host: api, subset: v1 }
          weight: 90
        - destination: { host: api, subset: v2 }
          weight: 10
      retries: { attempts: 2, perTryTimeout: 2s }
      timeout: 5s
```

Когда **не нужен**: несколько сервисов, нет требований к mTLS — mesh добавляет латентность, потребление ресурсов и операционную сложность.

## Packer и «золотые» образы

**Packer** собирает образы ВМ (AMI, образы GCP/Azure, vSphere, QEMU, Docker) из одного описания: базовый образ → провижининг (shell, Ansible) → снапшот.

```hcl ubuntu.pkr.hcl
packer {
  required_plugins {
    amazon = { source = "github.com/hashicorp/amazon", version = "~> 1.3" }
  }
}

source "amazon-ebs" "ubuntu" {
  region        = "eu-central-1"
  instance_type = "t3.small"
  ssh_username  = "ubuntu"
  ami_name      = "base-ubuntu-{{timestamp}}"
  source_ami_filter {
    filters     = { name = "ubuntu/images/hvm-ssd-gp3/ubuntu-noble-24.04-amd64-server-*" }
    owners      = ["099720109477"]
    most_recent = true
  }
}

build {
  sources = ["source.amazon-ebs.ubuntu"]
  provisioner "ansible" {
    playbook_file = "./playbooks/base.yml"
  }
}
```

**Immutable infrastructure**: не обновляем серверы на месте, а собираем новый образ и заменяем инстансы (ASG instance refresh). Плюсы: нет дрейфа, предсказуемость, быстрое масштабирование, простой откат на предыдущий образ.

## cloud-init

Стандарт первичной настройки облачных ВМ при первой загрузке (user data): пользователи и ключи, пакеты, файлы, команды, разметка дисков.

```yaml cloud-init.yaml
#cloud-config
package_update: true
packages: [nginx, chrony]
users:
  - name: deploy
    groups: [sudo]
    shell: /bin/bash
    ssh_authorized_keys: ["ssh-ed25519 AAAA... deploy"]
write_files:
  - path: /etc/motd
    content: "Managed by cloud-init\n"
runcmd:
  - systemctl enable --now nginx
```
Отладка: `/var/log/cloud-init.log`, `/var/log/cloud-init-output.log`, `cloud-init status --long`, `cloud-init schema --config-file x.yaml`.

## Consul, Nomad, Vagrant

- **Consul** (HashiCorp): service discovery (DNS и HTTP API), health checks, KV-хранилище, service mesh (Consul Connect). Часто — DCS для Patroni, бэкенд для Vault (сейчас чаще integrated storage Raft).
- **Nomad**: простой оркестратор для контейнеров, бинарников и VM — альтернатива Kubernetes с меньшей сложностью; связка Nomad + Consul + Vault.
- **Vagrant**: воспроизводимые локальные ВМ (VirtualBox, libvirt) из `Vagrantfile` — для тестирования Ansible-ролей и обучения.

```ruby Vagrantfile
Vagrant.configure("2") do |config|
  config.vm.box = "bento/ubuntu-24.04"
  (1..3).each do |i|
    config.vm.define "node#{i}" do |n|
      n.vm.hostname = "node#{i}"
      n.vm.network "private_network", ip: "192.168.56.1#{i}"
    end
  end
  config.vm.provision "ansible" do |a|
    a.playbook = "site.yml"
  end
end
```

## Make, task runners, dev-окружения

```makefile Makefile
.PHONY: lint test build deploy
IMAGE ?= registry.local/api
TAG   ?= $(shell git rev-parse --short HEAD)

lint:
	ruff check . && hadolint Dockerfile

test:
	pytest -q

build:
	docker build -t $(IMAGE):$(TAG) .

deploy: build
	helm upgrade --install api ./chart --set image.tag=$(TAG) --atomic
```
Make (отступы — **табуляция**!), **Task** (Taskfile.yml), **just** — единая точка входа для команд проекта, одинаково локально и в CI. **devcontainers**, **mise/asdf** — закрепление версий инструментов (terraform, kubectl, node).

## Платформенная инженерия

**Platform engineering** — построение внутренней платформы разработчика (**IDP**), чтобы продуктовые команды получали инфраструктуру самообслуживанием («golden paths»), а не через тикеты в DevOps.

Компоненты: портал (**Backstage** — каталог сервисов, шаблоны новых сервисов, документация TechDocs), шаблоны пайплайнов и чартов, IaC-модули, self-service окружения (Crossplane, Terraform-модули через портал), стандарты наблюдаемости и безопасности «по умолчанию». Платформа — это продукт с пользователями-разработчиками.

## Полезные CLI на каждый день

| Инструмент | Зачем |
|---|---|
| `jq`, `yq` | обработка JSON / YAML в shell |
| `k9s`, `kubectx`/`kubens`, `stern` | работа с Kubernetes |
| `htop`, `btop`, `glances` | мониторинг хоста |
| `ncdu`, `duf` | место на дисках |
| `mtr`, `nmap`, `iperf3`, `tcpdump`, `termshark` | сеть |
| `httpie`, `curl`, `grpcurl` | HTTP/gRPC |
| `tmux` / `screen` | сессии, переживающие разрыв SSH |
| `rg` (ripgrep), `fd`, `fzf`, `bat` | быстрый поиск и навигация |
| `direnv` | переменные окружения на каталог |
| `pre-commit`, `shellcheck`, `hadolint`, `tflint`, `yamllint` | линтеры |
| `trivy`, `gitleaks` | безопасность |
| `age`, `sops` | шифрование файлов и секретов |
| `dive` | анализ слоёв Docker-образа |
| `kubent`, `pluto` | поиск устаревших API Kubernetes |
| `nsenter`, `crictl`, `ctr` | отладка контейнеров на ноде |

# @interview

## [middle] Что такое service mesh и когда он нужен?
Инфраструктурный слой для межсервисного взаимодействия: прокси рядом с каждым сервисом и control plane. Даёт mTLS, управление трафиком (canary, ретраи, таймауты, circuit breaking), единую наблюдаемость и авторизацию без изменения кода. Нужен при большом числе сервисов, требованиях zero trust/mTLS, сложной маршрутизации. Цена — латентность, ресурсы и сложность эксплуатации.

## [middle] Что такое immutable infrastructure?
Подход, при котором серверы не изменяются после создания: для обновления собирается новый образ (Packer, Docker) и инстансы заменяются целиком. Исключает дрейф конфигурации, упрощает откат и масштабирование, делает окружения предсказуемыми. Противоположность — mutable (обновления на месте через Ansible/Chef).

## [junior] Что такое cloud-init?
Стандартный механизм первичной инициализации облачных ВМ при первой загрузке по данным user data: создание пользователей и SSH-ключей, установка пакетов, запись файлов, выполнение команд. Поддерживается всеми крупными облаками и большинством дистрибутивов.

## [middle] Зачем Packer, если есть Ansible?
Packer собирает готовый образ заранее (часто используя Ansible как провижинер), поэтому новые инстансы стартуют быстро и одинаково, без зависимости от внешних репозиториев в момент масштабирования. Ansible без Packer настраивает уже работающие серверы — медленнее при автоскейлинге и подвержено дрейфу.

## [middle] Что такое platform engineering и чем отличается от DevOps?
Platform engineering — дисциплина построения внутренней платформы самообслуживания (IDP) с «golden paths» для разработчиков: шаблоны сервисов, пайплайнов, инфраструктуры, наблюдаемости. Это эволюция DevOps: вместо того чтобы каждая команда разбиралась во всём стеке или ждала DevOps-инженера, платформенная команда делает продукт, снижающий когнитивную нагрузку.

# @quiz

? Что обеспечивает service mesh без изменения кода приложения?
+ mTLS, ретраи и метрики межсервисных вызовов
- Шифрование дисков
- Сборку образов
- Бэкапы БД
> Через прокси data plane и control plane.

? Что такое immutable infrastructure?
- Инфраструктура без изменений годами
+ Замена серверов новыми из свежего образа вместо обновления на месте
- Запрет на деплой
- Только read-only файловые системы
> Обновление = новый образ + замена инстансов.

? Какой инструмент собирает AMI из шаблона?
- Vagrant
+ Packer
- Consul
- Nomad
> Packer поддерживает множество платформ.

? Что нужно учитывать при написании Makefile?
+ Команды в правилах отступаются табуляцией
- Отступ — 4 пробела
- Отступы не важны
- Файл должен быть в YAML
> Иначе «missing separator».
