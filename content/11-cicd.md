---
id: cicd
title: CI/CD
icon: 🔁
order: 110
group: Контейнеры и доставка
color: #fc6d26
summary: Принципы CI/CD, GitLab CI, GitHub Actions, Jenkins, артефакты и кэш, стратегии деплоя (rolling, blue-green, canary), безопасность пайплайнов, DORA-метрики.
---

# @theory

## Принципы CI/CD

- **Continuous Integration** — каждый коммит интегрируется в общую ветку и автоматически проверяется: сборка, линтеры, тесты, сканирование. Цель — ловить проблемы рано, ветки живут недолго.
- **Continuous Delivery** — каждое изменение, прошедшее пайплайн, **готово** к выкатке в прод; выкатка — по кнопке.
- **Continuous Deployment** — выкатка в прод тоже автоматическая, без ручного шага.

### Типичный пайплайн
```text
commit → lint/format → unit-тесты → сборка артефакта (образ) → сканирование (SAST, зависимости, образ)
       → push в реестр → деплой в dev/staging → интеграционные/e2e/smoke тесты
       → (approve) → деплой в prod (canary/blue-green) → проверка метрик → полный rollout / откат
```

### Принципы хорошего пайплайна
1. **Build once, deploy many** — один артефакт (образ с неизменяемым тегом/digest) продвигается по окружениям; конфигурация окружения — снаружи (12-factor).
2. **Быстрая обратная связь**: быстрые проверки первыми, параллелизм, кэш, fail fast. Цель — до 10 минут на PR.
3. **Воспроизводимость**: закреплённые версии образов раннеров, инструментов, зависимостей (lock-файлы).
4. **Пайплайн как код** в репозитории, ревью изменений пайплайна.
5. **Безопасность**: минимальные права, секреты не в коде, OIDC вместо статических ключей, защищённые ветки/окружения.
6. **Наблюдаемость**: длительность, частота падений, flaky-тесты.

## GitLab CI

```yaml .gitlab-ci.yml
stages: [lint, test, build, deploy]

variables:
  IMAGE: $CI_REGISTRY_IMAGE:$CI_COMMIT_SHORT_SHA
  DOCKER_TLS_CERTDIR: "/certs"

default:
  image: python:3.12-slim
  interruptible: true

workflow:
  rules:
    - if: $CI_PIPELINE_SOURCE == "merge_request_event"
    - if: $CI_COMMIT_BRANCH == $CI_DEFAULT_BRANCH
    - if: $CI_COMMIT_TAG

lint:
  stage: lint
  script:
    - pip install ruff
    - ruff check .

test:
  stage: test
  cache:
    key:
      files: [requirements.txt]
    paths: [.cache/pip]
  variables:
    PIP_CACHE_DIR: $CI_PROJECT_DIR/.cache/pip
  services:
    - name: postgres:16
      alias: db
  script:
    - pip install -r requirements.txt
    - pytest --junitxml=report.xml --cov
  coverage: '/TOTAL.*\s(\d+%)$/'
  artifacts:
    reports:
      junit: report.xml

build:
  stage: build
  image: docker:27
  services: [docker:27-dind]
  script:
    - echo "$CI_REGISTRY_PASSWORD" | docker login -u "$CI_REGISTRY_USER" --password-stdin $CI_REGISTRY
    - docker build --cache-from $CI_REGISTRY_IMAGE:latest -t $IMAGE .
    - docker push $IMAGE
  rules:
    - if: $CI_COMMIT_BRANCH == $CI_DEFAULT_BRANCH

.deploy:
  stage: deploy
  image: alpine/helm:3.16
  script:
    - helm upgrade --install api ./chart -n $NS --set image.tag=$CI_COMMIT_SHORT_SHA --atomic --timeout 5m

deploy_staging:
  extends: .deploy
  variables: { NS: api-staging }
  environment: { name: staging, url: https://staging.example.com }
  rules:
    - if: $CI_COMMIT_BRANCH == $CI_DEFAULT_BRANCH

deploy_prod:
  extends: .deploy
  variables: { NS: api-prod }
  environment: { name: production, url: https://example.com }
  resource_group: production        # не более одного деплоя в prod одновременно
  rules:
    - if: $CI_COMMIT_BRANCH == $CI_DEFAULT_BRANCH
      when: manual
```

| Понятие | Суть |
|---|---|
| `stages` | этапы; jobs одного stage идут параллельно |
| `needs` | DAG: job стартует сразу после указанных, не дожидаясь всего stage |
| `rules` / `only/except` (устар.) | когда запускать job |
| `cache` | ускорение между пайплайнами (зависимости), **не гарантирован** |
| `artifacts` | результаты job для следующих job и скачивания (бинарники, отчёты), гарантированно передаются |
| `services` | вспомогательные контейнеры (БД, dind) |
| `environment` | окружение: история деплоев, откат, защита |
| `extends`, `!reference`, YAML anchors, `include` | переиспользование |
| `trigger` | дочерние/мульти-проектные пайплайны |
| Runner | агент выполнения: shell, docker, kubernetes executor; теги для выбора |
| Protected variables/branches | секреты доступны только в защищённых ветках/тегах |

## GitHub Actions

```yaml .github/workflows/ci.yml
name: ci
on:
  pull_request:
  push:
    branches: [main]
    tags: ["v*"]

permissions:
  contents: read

concurrency:
  group: ${{ github.workflow }}-${{ github.ref }}
  cancel-in-progress: true

jobs:
  test:
    runs-on: ubuntu-latest
    strategy:
      matrix:
        python: ["3.11", "3.12"]
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-python@v5
        with:
          python-version: ${{ matrix.python }}
          cache: pip
      - run: pip install -r requirements.txt
      - run: pytest -q

  build:
    needs: test
    if: github.ref == 'refs/heads/main'
    runs-on: ubuntu-latest
    permissions:
      contents: read
      packages: write
      id-token: write          # для OIDC
    steps:
      - uses: actions/checkout@v4
      - uses: docker/setup-buildx-action@v3
      - uses: docker/login-action@v3
        with:
          registry: ghcr.io
          username: ${{ github.actor }}
          password: ${{ secrets.GITHUB_TOKEN }}
      - uses: docker/build-push-action@v6
        with:
          push: true
          tags: ghcr.io/${{ github.repository }}:${{ github.sha }}
          cache-from: type=gha
          cache-to: type=gha,mode=max

  deploy:
    needs: build
    runs-on: ubuntu-latest
    environment: production         # правила защиты: required reviewers
    permissions:
      id-token: write
      contents: read
    steps:
      - uses: aws-actions/configure-aws-credentials@v4
        with:
          role-to-assume: arn:aws:iam::123456789012:role/gha-deploy
          aws-region: eu-central-1
      - run: aws eks update-kubeconfig --name prod && kubectl set image deploy/api api=ghcr.io/${{ github.repository }}:${{ github.sha }}
```

- **Workflow** → **jobs** (параллельно, `needs` для зависимостей) → **steps** (`uses` — action, `run` — команда).
- Триггеры: `push`, `pull_request`, `schedule`, `workflow_dispatch` (ручной), `workflow_call` (переиспользуемые workflow), `release`.
- `secrets.*`, `vars.*`, `env`, `outputs` между jobs, **environments** с защитой и секретами окружений.
- **Безопасность**: пиннинг actions по SHA (`uses: actions/checkout@<sha>`), минимальные `permissions`, осторожно с `pull_request_target` (секреты доступны для кода из форков!), не подставлять `${{ github.event.* }}` прямо в `run` (инъекция команд) — передавайте через `env`.

## Jenkins

```groovy Jenkinsfile
pipeline {
  agent { kubernetes { yamlFile 'ci/pod.yaml' } }
  options {
    timeout(time: 30, unit: 'MINUTES')
    disableConcurrentBuilds()
    buildDiscarder(logRotator(numToKeepStr: '30'))
  }
  environment {
    REGISTRY = 'registry.example.com'
    IMAGE    = "${REGISTRY}/api:${env.GIT_COMMIT.take(8)}"
  }
  stages {
    stage('Test') {
      steps { container('python') { sh 'pip install -r requirements.txt && pytest' } }
    }
    stage('Build') {
      when { branch 'main' }
      steps {
        container('kaniko') {
          sh "/kaniko/executor --destination=${IMAGE} --cache=true"
        }
      }
    }
    stage('Deploy prod') {
      when { branch 'main' }
      input { message 'Деплоим в prod?' }
      steps {
        withCredentials([file(credentialsId: 'kubeconfig-prod', variable: 'KUBECONFIG')]) {
          sh "helm upgrade --install api ./chart --set image.tag=${env.GIT_COMMIT.take(8)} --atomic"
        }
      }
    }
  }
  post {
    failure { slackSend channel: '#ci', message: "Упал ${env.JOB_NAME} #${env.BUILD_NUMBER}" }
    always  { junit allowEmptyResults: true, testResults: 'report.xml' }
  }
}
```

- **Declarative** (как выше) и **Scripted** (Groovy целиком) pipeline.
- **Controller** (бывш. master) + **agents** (статические, Docker, Kubernetes plugin — агент-под на сборку).
- **Shared Libraries** — общий Groovy-код для всех пайплайнов.
- Multibranch Pipeline / Organization Folder — автоматически находит ветки и PR.
- Credentials store, плагины (основная сила и основная боль: обновления, совместимость, CVE).
- Configuration as Code (**JCasC**) — конфигурация Jenkins в YAML.

| | GitLab CI | GitHub Actions | Jenkins |
|---|---|---|---|
| Хостинг | SaaS/self-hosted | SaaS (+ self-hosted runners) | только self-hosted |
| Конфиг | YAML | YAML | Groovy |
| Расширения | include, components | Marketplace actions | 1800+ плагинов |
| Поддержка | низкая | низкая | высокая (обновления, плагины) |

## Стратегии деплоя

| Стратегия | Как | Плюсы | Минусы |
|---|---|---|---|
| **Recreate** | остановить всё старое → поднять новое | просто, нет двух версий одновременно | простой |
| **Rolling** | постепенная замена инстансов | без простоя, без доп. ресурсов (почти) | две версии одновременно, медленный откат |
| **Blue-Green** | рядом полное новое окружение (green), переключение трафика целиком | мгновенный откат, тестирование до переключения | x2 ресурсов, сложности с БД и сессиями |
| **Canary** | новая версия получает 1% → 10% → 50% → 100% трафика с анализом метрик | минимальный риск, проверка на реальном трафике | сложнее: нужна маршрутизация по весам и метрики |
| **A/B testing** | маршрутизация по признакам пользователя (заголовок, кука) | эксперименты с продуктом | нужна аналитика |
| **Shadow (mirroring)** | копия трафика идёт на новую версию, ответы выбрасываются | тест на реальной нагрузке без риска | x2 нагрузка, побочные эффекты записи |
| **Feature flags** | код выкачен, функциональность включается флагом | отделяет деплой от релиза, мгновенное выключение | технический долг флагов |

Инструменты: Kubernetes RollingUpdate, **Argo Rollouts** и **Flagger** (canary/blue-green с автоматическим анализом Prometheus-метрик и откатом), service mesh (Istio/Linkerd), Gateway API weights, LaunchDarkly/Unleash/Flagsmith (флаги).

> [!warn] Миграции БД и откат
> Откат кода не откатывает схему БД. Используйте **expand/contract**: (1) добавить новое (колонку) совместимо со старым кодом, (2) задеплоить код, работающий с обоими, (3) мигрировать данные, (4) убрать старое отдельным релизом. Никаких `DROP`/`RENAME` в одном релизе с кодом.

## Артефакты, версии, реестры

- Артефакты: Docker-образы, Helm-чарты (OCI), бинарники, пакеты (npm, PyPI, Maven, deb/rpm).
- Реестры: Harbor, Nexus, Artifactory, GitLab/GitHub Packages, ECR/GCR/ACR.
- Тегирование: git SHA (уникально и трассируемо) + semver для релизов; `latest` — никогда для деплоя.
- Ретеншн: политики очистки старых образов, иммутабельные теги в реестре.
- **Supply chain security**: SBOM (Syft), подпись (cosign), провенанс (SLSA, in-toto attestations), проверка при деплое (Kyverno/Connaisseur, policy-controller).

## Безопасность пайплайна (DevSecOps)

| Проверка | Инструменты |
|---|---|
| Секреты в коде | gitleaks, trufflehog, GitHub secret scanning |
| SAST (статический анализ кода) | Semgrep, SonarQube, CodeQL |
| SCA (уязвимые зависимости) | Dependabot, Renovate, Snyk, Trivy fs, OWASP dependency-check |
| Сканирование образов | Trivy, Grype, Docker Scout |
| IaC | Checkov, tfsec/Trivy config, kube-linter, kubesec, conftest |
| DAST (динамический) | OWASP ZAP, Burp |
| Лицензии | FOSSA, ScanCode |

Принципы:
- Секреты — в хранилище CI (masked + protected) или Vault; **OIDC** к облакам вместо ключей.
- Раннеры: эфемерные (новый под/ВМ на каждую job), изолированные для prod-деплоя, без docker.sock и privileged, если можно (Kaniko/BuildKit rootless).
- Код из форков не должен получать секреты.
- Защищённые ветки и окружения, обязательные ревью, CODEOWNERS для изменений пайплайна.
- Атаки на supply chain: подмена зависимостей (typosquatting, dependency confusion), скомпрометированные actions/плагины — пиннинг по хэшу, внутренние зеркала.

## Метрики доставки (DORA)

| Метрика | Что измеряет | Elite |
|---|---|---|
| **Deployment Frequency** | как часто деплоим в прод | по требованию, много раз в день |
| **Lead Time for Changes** | от коммита до прода | < 1 дня (часы) |
| **Change Failure Rate** | доля деплоев, вызвавших инцидент/откат | 0–15% |
| **Time to Restore (MTTR)** | время восстановления после сбоя | < 1 часа |

Первые две — скорость, вторые две — стабильность. Исследования DORA показывают, что они не противоречат друг другу: лучшие команды быстрые **и** стабильные.

# @interview

## [junior] Чем Continuous Delivery отличается от Continuous Deployment?
В Continuous Delivery каждое изменение автоматически доводится до состояния «готово к релизу», но выкатка в прод — по решению человека. В Continuous Deployment прошедшее все проверки изменение автоматически уходит в прод.

## [junior] Из каких этапов состоит типичный CI/CD пайплайн?
Линтеры и статический анализ → юнит-тесты → сборка артефакта/образа → сканирование безопасности → публикация в реестр → деплой в тестовое окружение → интеграционные/e2e тесты → (одобрение) → деплой в прод с прогрессивной стратегией → пост-деплой проверки и мониторинг.

## [middle] Чем cache отличается от artifacts в GitLab CI?
Cache — для ускорения (зависимости), переиспользуется между пайплайнами, хранится на раннере/в S3, не гарантирован. Artifacts — результаты job (бинарники, отчёты), гарантированно передаются последующим job в пайплайне и доступны для скачивания, имеют срок хранения.

## [middle] Что такое blue-green деплой? Плюсы и минусы.
Два идентичных окружения: текущее (blue) обслуживает трафик, новое (green) разворачивается и тестируется, затем трафик переключается целиком (DNS, балансировщик, Service selector). Плюсы: мгновенный откат обратным переключением, тестирование до релиза. Минусы: двойные ресурсы, сложность со схемой БД и stateful-частями, долгоживущие соединения.

## [middle] Что такое canary-релиз и как автоматизировать решение о продвижении?
Новая версия получает небольшую долю трафика, по метрикам (error rate, latency p99, бизнес-метрики) сравнивается со стабильной; при хороших показателях доля увеличивается, при плохих — автоматический откат. Автоматизация — Argo Rollouts/Flagger с AnalysisTemplate на Prometheus-запросах, Kayenta.

## [middle] Как сделать деплой, чтобы откат был быстрым и безопасным?
Неизменяемые версионированные артефакты, хранение предыдущих версий, декларативный деплой (Helm history, GitOps revert), обратно совместимые миграции БД (expand/contract), feature flags для отключения функциональности без деплоя, автоматический откат по health/метрикам, отработанная процедура.

## [middle] Как хранить секреты в CI/CD?
В защищённых переменных CI (masked, protected — только для защищённых веток), во внешних менеджерах (Vault, AWS SM) с короткоживущим доступом, OIDC-федерация для облаков вместо статических ключей. Не выводить в логи, не передавать в форки, ограничить права токенов (`permissions` в GHA), ротация.

## [middle] Что такое OIDC в CI и зачем?
CI-платформа выдаёт job подписанный JWT с claims (репозиторий, ветка, окружение). Облако (AWS IAM, GCP, Azure, Vault) доверяет этому OIDC-провайдеру и по условиям в trust policy выдаёт временные креды. Никаких долгоживущих ключей в настройках CI, доступ привязан к конкретному репо/ветке.

## [middle] Что значит «build once, deploy many»?
Один и тот же собранный артефакт (образ с конкретным digest) продвигается через все окружения, а различия окружений задаются конфигурацией (переменные, ConfigMap, секреты). Гарантирует, что в проде ровно то, что протестировано, и экономит время сборки.

## [senior] Как ускорить медленный пайплайн?
Измерить, где время. Параллелизация (matrix, DAG `needs`, шардинг тестов), кэш зависимостей и слоёв Docker (registry cache), инкрементальные сборки и запуск только затронутых частей в монорепо (`rules:changes`, Nx/Bazel/Turborepo), более мощные/тёплые раннеры, предсобранные образы с инструментами, fail-fast порядок, вынос долгих e2e в ночные/параллельные пайплайны, борьба с flaky-тестами.

## [middle] Какие метрики DORA вы знаете?
Deployment frequency, lead time for changes, change failure rate, time to restore service (с 2024 добавлен rework rate). Отражают скорость и стабильность поставки.

## [middle] Как безопасно собирать Docker-образы в CI внутри Kubernetes?
Без docker.sock и privileged DinD: Kaniko, BuildKit (rootless, buildkitd как сервис), Buildah/Podman. Отдельные изолированные раннеры, кэш в реестре.

## [senior] Какие атаки на CI/CD (supply chain) вы знаете и как защищаться?
Компрометация зависимостей (typosquatting, dependency confusion, вредоносные обновления), скомпрометированные actions/плагины, утечка секретов через логи или PR из форков, poisoned pipeline execution (изменение конфигурации пайплайна в PR), компрометация раннеров. Защита: пиннинг по хэшу и lock-файлы, внутренние зеркала, сканирование, минимальные права токенов, эфемерные раннеры, защищённые ветки и ревью CODEOWNERS для CI-файлов, подпись артефактов и проверка провенанса (SLSA), OIDC.

## [middle] Что такое GitOps и как он соотносится с CI/CD?
GitOps — способ реализации CD: CI собирает и тестирует артефакт, обновляет версию в Git-репозитории конфигурации, а агент в кластере (Argo CD/Flux) применяет изменения. Разделяет ответственность CI (сборка) и CD (синхронизация состояния).

# @troubleshooting

## [medium] Пайплайн «зелёный» локально, падает в CI
**Причины:** разные версии инструментов/рантайма, не закоммичен lock-файл, зависимость от локальных файлов/переменных, разный часовой пояс/локаль, тесты зависят от порядка или сети, кэш CI содержит устаревшие зависимости.

**Решение:** запускать CI-джобы в тех же контейнерах локально (`gitlab-runner exec`, `act` для GHA, devcontainer), закрепить версии, очистить кэш, сделать тесты изолированными.

## [medium] Job висит в pending / stuck
**Причины (GitLab):** нет раннера с нужными `tags`, раннеры заняты/офлайн, джоба для protected-ветки, а раннер только для protected (или наоборот), превышена квота минут.

**Решение:** проверить теги job и раннеров, статус раннеров в настройках, логи `gitlab-runner`, `concurrent` в config.toml, автоскейлинг раннеров.

## [medium] Flaky-тесты: то проходят, то нет
**Решение:** собрать статистику (отчёты JUnit, retries), выделить нестабильные тесты в карантин с задачей на починку, убрать зависимости от времени/порядка/внешней сети/общего состояния, ожидания вместо `sleep`. Автоматический `retry` — только как временная мера.

## [high] Секрет утёк в лог пайплайна
**Решение:** немедленно ротировать секрет, удалить лог/артефакты джобы, разобраться, как произошло (`set -x`, echo, вывод инструмента), включить маскирование переменных, `no_log`/`::add-mask::`, не использовать `set -x` в шагах с секретами.

## [medium] Deploy в prod прошёл, но новая версия не применилась
**Причины:** тот же тег образа (`latest`, перезаписанный тег) + `imagePullPolicy: IfNotPresent` — нода использует закэшированный образ; Helm не увидел изменений в манифесте; деплой в другой namespace/кластер (не тот kubecontext).

**Решение:** уникальные теги (git SHA) или digest, проверка `kubectl get deploy -o yaml | grep image`, `rollout status` в пайплайне, явный `--kube-context`.

# @quiz

? Чем artifacts отличаются от cache в GitLab CI?
+ Artifacts гарантированно передаются следующим job; cache — оптимизация без гарантий
- Ничем
- Cache хранится вечно
- Artifacts доступны только в текущей job
> Cache — для зависимостей, artifacts — для результатов.

? Какая стратегия деплоя требует двойных ресурсов, но даёт мгновенный откат?
- Rolling
- Recreate
+ Blue-Green
- Canary
> Переключение трафика между двумя окружениями.

? Что такое OIDC в контексте CI?
- Протокол передачи артефактов
+ Обмен подписанного токена job на временные облачные креды без статических ключей
- Формат отчётов тестов
- Способ кэширования
> Trust policy ограничивает репо/ветку/окружение.

? Какой из вариантов — метрика DORA?
- Покрытие кода тестами
+ Change failure rate
- Количество микросервисов
- Время сборки образа
> Ещё: deployment frequency, lead time, time to restore.

? Почему опасен `pull_request_target` в GitHub Actions?
+ Workflow запускается с секретами и правами базового репозитория, даже для PR из форков
- Он не поддерживает matrix
- Он медленный
- Он не видит код PR
> Если при этом выполнить код из PR — секреты утекут.

? Как правильно менять схему БД, чтобы не сломать откат?
- Переименовать колонку вместе с релизом кода
+ Expand/contract: сначала совместимое расширение, удаление — отдельным релизом
- Делать миграции только вручную
- Откатывать БД из бэкапа при откате кода
> Код N и N-1 должен работать с текущей схемой.
