---
id: security
title: Безопасность и DevSecOps
icon: 🔐
order: 160
group: Эксплуатация
color: #a371f7
summary: Принципы безопасности, hardening Linux, управление секретами и Vault, PKI и сертификаты, безопасность контейнеров и Kubernetes, supply chain, OWASP, реагирование.
---

# @theory

## Принципы

- **Least privilege** — минимально необходимые права, на минимальное время.
- **Defense in depth** — несколько независимых слоёв защиты (сеть, ОС, приложение, данные, мониторинг).
- **Zero Trust** — «никогда не доверяй, всегда проверяй»: нет доверенной внутренней сети, каждая сессия аутентифицируется и авторизуется (mTLS, identity-aware proxy, BeyondCorp).
- **Secure by default** — безопасная конфигурация по умолчанию, открытие — осознанно.
- **Shift left** — проверки безопасности как можно раньше (IDE, pre-commit, PR).
- **Аудит и трассируемость** — кто, что, когда сделал (журналы, неизменяемое хранение).
- **CIA**: Confidentiality, Integrity, Availability.

### Аутентификация vs авторизация
- **AuthN** — кто ты? (пароль, ключ, сертификат, OIDC-токен, MFA).
- **AuthZ** — что тебе можно? (RBAC, ABAC, политики).
- **SSO**: **SAML** (XML, enterprise), **OIDC** (поверх OAuth 2.0, JWT ID token). **OAuth 2.0** — делегирование доступа (access token), сам по себе не аутентификация.
- **JWT** — подписанный (не зашифрованный!) токен: header.payload.signature. Проверять подпись, `exp`, `aud`, `iss`; не класть секреты в payload.

## Hardening Linux-сервера

```bash
# Обновления безопасности автоматически
apt install unattended-upgrades && dpkg-reconfigure -plow unattended-upgrades
# SSH: только ключи, без root
# /etc/ssh/sshd_config.d/10-hardening.conf → PermitRootLogin no, PasswordAuthentication no
# Файрвол: deny по умолчанию
ufw default deny incoming && ufw allow 22/tcp && ufw enable
# Защита от брутфорса
apt install fail2ban
# Минимум сервисов
systemctl list-unit-files --state=enabled
ss -tulpn
# Аудит
apt install auditd; auditctl -w /etc/passwd -p wa -k passwd_changes
lynis audit system                 # аудит конфигурации
```

Чеклист:
1. Минимальная установка, удалить ненужные пакеты и сервисы.
2. Регулярные патчи (ядро — с перезагрузкой или livepatch).
3. SSH: ключи, без root, без паролей, `AllowGroups`, при необходимости — bastion/VPN/SSM вместо открытого 22.
4. Файрвол с default deny; в облаке — SG по принципу минимальных портов.
5. sudo с логированием, без `NOPASSWD: ALL` для людей.
6. SELinux/AppArmor в режиме enforcing.
7. sysctl: `kernel.kptr_restrict=2`, `net.ipv4.conf.all.rp_filter=1`, `net.ipv4.conf.all.accept_redirects=0`, `kernel.unprivileged_bpf_disabled=1`, `fs.protected_symlinks=1`.
8. Монтирование `/tmp` с `noexec,nosuid,nodev`.
9. Централизованные логи (злоумышленник не сотрёт), auditd, мониторинг входов.
10. Бенчмарки **CIS** как основа, автоматизация через Ansible-роли (dev-sec.io).

## Управление секретами

> [!danger] Где секретов быть не должно
> В Git (даже в приватном, даже «временно»), в Docker-образах, в переменных Dockerfile, в логах, в тикетах и чатах, в CI-конфигурации в открытом виде, в state без шифрования.

### Иерархия решений
1. **Не иметь секрета вовсе**: IAM-роли, OIDC-федерация, Workload Identity, IAM-аутентификация к БД, mTLS через service mesh.
2. **Короткоживущие динамические секреты** (Vault dynamic secrets: учётка БД создаётся на час и удаляется).
3. **Секрет-менеджер** с ротацией и аудитом: HashiCorp Vault/OpenBao, AWS Secrets Manager, GCP Secret Manager, Azure Key Vault.
4. Шифрованные файлы в Git (SOPS, Sealed Secrets, ansible-vault) — для GitOps.

### HashiCorp Vault
- **Seal/Unseal**: данные зашифрованы; при старте Vault запечатан, мастер-ключ собирается из долей (Shamir) или через **auto-unseal** (KMS/HSM).
- **Secrets engines**: KV (статические), **database** (динамические учётки), **PKI** (выпуск сертификатов), AWS/GCP (временные облачные креды), **transit** (шифрование как сервис — приложение не видит ключ).
- **Auth methods**: Kubernetes (по токену SA), AppRole, OIDC, AWS IAM, JWT (CI), LDAP.
- **Policies** (HCL) — что можно читать/писать по путям.
- **Leases** — у динамических секретов есть TTL, продление и отзыв.
- Audit device — журнал всех обращений.

```bash
vault kv put secret/api db_password=s3cr3t
vault kv get -field=db_password secret/api
vault read database/creds/app-role          # получить временную учётку БД
vault write pki/issue/web common_name=api.internal ttl=72h
```

Интеграция с K8s: Vault Agent Injector (sidecar), Vault Secrets Operator, External Secrets Operator, CSI driver.

### Ротация
Секреты должны ротироваться регулярно и **мгновенно при утечке**. Если ротация «больно» — это сигнал автоматизировать (динамические секреты, поддержка двух активных ключей на время перехода).

## PKI и сертификаты

- **Асимметричная криптография**: приватный ключ (секрет) + публичный ключ; подпись приватным, проверка публичным; шифрование публичным, расшифровка приватным.
- **Сертификат X.509** = публичный ключ + субъект (SAN) + срок + подпись CA.
- **CA** — удостоверяющий центр. Цепочка: root CA (офлайн, долгоживущий) → intermediate CA → leaf.
- **CSR** — запрос на подпись сертификата (содержит публичный ключ и данные субъекта).
- **Отзыв**: CRL, OCSP (OCSP stapling на сервере). Индустрия движется к коротким срокам сертификатов (47 дней к 2029) вместо отзыва — автоматизируйте выпуск (ACME).
- Форматы: **PEM** (base64, `-----BEGIN...`), **DER** (бинарный), **PKCS#12/PFX** (сертификат+ключ в одном файле с паролем).

```bash
openssl genrsa -out key.pem 2048                    # или: openssl genpkey -algorithm ed25519
openssl req -new -key key.pem -out req.csr -subj "/CN=api.example.com" -addext "subjectAltName=DNS:api.example.com"
openssl x509 -req -in req.csr -CA ca.pem -CAkey ca.key -CAcreateserial -out cert.pem -days 90 -copy_extensions copy
openssl x509 -in cert.pem -noout -text | grep -A1 "Subject Alternative Name"
openssl pkcs12 -export -in cert.pem -inkey key.pem -out bundle.p12
openssl x509 -enddate -noout -in cert.pem
```

Внутренний PKI: Vault PKI, step-ca (smallstep), cert-manager с CA Issuer. Мониторинг сроков: blackbox_exporter (`probe_ssl_earliest_cert_expiry`), x509-certificate-exporter.

**mTLS** — взаимная аутентификация: клиент и сервер предъявляют сертификаты. Основа zero trust между сервисами; service mesh (Istio, Linkerd) делает это прозрачно с автоматической ротацией.

## Безопасность контейнеров и Kubernetes

### Образы
- Минимальные базовые образы, регулярная пересборка.
- Сканирование (Trivy/Grype) в CI с порогом блокировки.
- SBOM, подпись (cosign), проверка подписи при допуске в кластер.
- Не root, без лишних capabilities, read-only rootfs.

### Кластер (4C: Cloud, Cluster, Container, Code)
| Область | Меры |
|---|---|
| API server | не публиковать в интернет (или ограничить IP), OIDC для людей, аудит-лог |
| RBAC | least privilege, без `cluster-admin` для людей и CI, отдельные SA на приложение, `automountServiceAccountToken: false` |
| Admission | Pod Security Admission `restricted`, Kyverno/Gatekeeper: доверенные реестры, подписи, запрет privileged/hostPath/hostNetwork, обязательные лимиты |
| Сеть | NetworkPolicy default deny, mTLS (mesh), отдельные egress-шлюзы |
| Секреты | шифрование etcd (KMS), ESO/Vault, ограничение `get secrets` |
| Ноды | минимальные ОС (Bottlerocket, Talos, Flatcar), обновления, без SSH, IMDSv2 с hop limit 1 (поды не достанут метаданные ноды) |
| Runtime | **Falco**/Tetragon — обнаружение аномалий (shell в контейнере, запись в /etc, неожиданные соединения), seccomp `RuntimeDefault`, AppArmor |
| Аудит | kube-bench (CIS), kubescape, trivy k8s |

### Опасные настройки пода
`privileged: true`, `hostPID`, `hostNetwork`, `hostPath: /`, `CAP_SYS_ADMIN`, монтирование `docker.sock`/`containerd.sock` — любое из этого практически равно root на ноде.

## Supply chain security

Атаки через цепочку поставки: подмена зависимостей (typosquatting, **dependency confusion**), компрометация мейнтейнера (xz-utils backdoor 2024), заражение сборочной системы (SolarWinds), вредоносные GitHub Actions.

Защита:
- **Lock-файлы** и пиннинг версий/хэшей (`npm ci`, `pip --require-hashes`, actions по SHA).
- Внутренние прокси-реестры (Nexus/Artifactory) и явный приоритет внутренних пакетов.
- **SCA** (Dependabot/Renovate + Trivy/Snyk), **SBOM** (CycloneDX/SPDX).
- **SLSA** — уровни зрелости защиты сборки; provenance-аттестации (кто, где, из какого коммита собрал).
- **Sigstore**: cosign (подпись образов, keyless через OIDC), Rekor (журнал прозрачности).
- Эфемерные изолированные сборочные агенты, минимальные права CI-токенов.

## Безопасность веб-приложений (OWASP Top 10)

| Риск | Суть | Защита на уровне инфраструктуры/кода |
|---|---|---|
| Broken Access Control | доступ к чужим данным/функциям (IDOR) | проверка прав на сервере для каждого запроса |
| Cryptographic Failures | слабое/отсутствующее шифрование | TLS везде, шифрование at rest, без самописной криптографии |
| Injection (SQL, команды) | данные пользователя исполняются как код | параметризованные запросы, валидация, без `shell=True` |
| Insecure Design | уязвимость архитектуры | threat modeling |
| Security Misconfiguration | дефолтные пароли, открытые админки, debug в проде, публичные бакеты | hardening, IaC-сканирование, CSPM |
| Vulnerable Components | уязвимые зависимости | SCA, обновления |
| Auth Failures | слабые пароли, нет MFA, утечка сессий | MFA, rate limit на логин, безопасные куки |
| Software & Data Integrity | неподписанные обновления, CI/CD | подписи, защищённые пайплайны |
| Logging & Monitoring Failures | атаку не заметили | централизованные логи, алерты |
| **SSRF** | сервер делает запрос по URL атакующего (например, к `169.254.169.254`) | allowlist URL, IMDSv2, egress-фильтрация |

**WAF** (ModSecurity/Coraza + OWASP CRS, AWS WAF, Cloudflare) — дополнительный слой, не замена исправлению кода. **DDoS**-защита: CDN/anycast (Cloudflare, AWS Shield), rate limiting, автоскейлинг.

## Реагирование на инциденты безопасности

Фазы (NIST): **Preparation** → **Detection & Analysis** → **Containment** → **Eradication** → **Recovery** → **Lessons Learned**.

1. Подтвердить инцидент, оценить масштаб, назначить ответственного, вести хронологию.
2. **Сдержать**: изолировать хост (SG без правил, отключение от сети), отозвать скомпрометированные креды/токены, заблокировать учётки. **Не уничтожать улики**: снапшоты дисков, дамп памяти, сохранить логи до перезапуска.
3. Найти вектор проникновения и всё, что затронуто (CloudTrail, логи доступа, аудит K8s).
4. Устранить: пересоздать системы из доверенных образов, закрыть уязвимость, ротировать **все** секреты, к которым был доступ.
5. Восстановить сервис, усиленно мониторить.
6. Postmortem, улучшения, при необходимости — уведомления (регуляторы, клиенты).

# @interview

## [junior] Чем аутентификация отличается от авторизации?
Аутентификация — проверка личности (кто ты: пароль, ключ, токен, MFA). Авторизация — проверка прав (что тебе разрешено: роли, политики). Сначала AuthN, потом AuthZ.

## [middle] Как вы храните и передаёте секреты в инфраструктуре?
Предпочтительно — избегать статических секретов (IAM-роли, OIDC, Workload Identity). Остальное — в секрет-менеджере (Vault, AWS SM) с аудитом и ротацией; доставка в приложения через ESO/CSI/Vault Agent; в Git только зашифрованное (SOPS/Sealed Secrets). Никогда — в коде, образах, логах. Ротация регулярно и при утечке.

## [middle] Что такое динамические секреты в Vault?
Секреты, генерируемые по запросу с ограниченным TTL: например, Vault создаёт пользователя БД с нужными правами на час и автоматически удаляет его по истечении lease. Утечка такого секрета ограничена во времени, у каждого потребителя своя учётка — аудит и отзыв.

## [middle] Как работает TLS-сертификат и цепочка доверия?
Сертификат связывает публичный ключ с именем (SAN) и подписан CA. Клиент проверяет подпись leaf-сертификата публичным ключом intermediate CA, тот — корневым CA, который есть в доверенном хранилище ОС/браузера; также проверяет срок, имя и отзыв. Сервер должен отдавать leaf + intermediate.

## [middle] Что такое mTLS и где применяется?
Взаимный TLS: обе стороны предъявляют и проверяют сертификаты. Используется для межсервисной аутентификации (service mesh, zero trust), доступа к API для партнёров, Kubernetes (компоненты control plane, kubelet), etcd.

## [middle] Какие меры безопасности для Kubernetes вы бы внедрили?
RBAC с минимальными правами, Pod Security Admission restricted, admission-политики (доверенные реестры, подписи, запрет privileged), NetworkPolicy default deny, шифрование секретов в etcd и внешние секрет-менеджеры, приватный API endpoint и OIDC, сканирование образов и манифестов в CI, runtime-защита (Falco), регулярные обновления кластера и нод, аудит-лог, CIS-бенчмарк (kube-bench).

## [middle] Что такое SSRF и как от него защититься в облаке?
Server-Side Request Forgery: атакующий заставляет сервер сделать запрос на выбранный адрес — например, к metadata-сервису `169.254.169.254` и получить креды IAM-роли. Защита: валидация/allowlist URL в приложении, IMDSv2 (и hop limit 1 для контейнеров), egress-фильтрация, минимальные права роли.

## [senior] Что такое атака на supply chain? Как защитить сборку?
Компрометация не самого приложения, а того, из чего и чем оно собирается: зависимости (typosquatting, dependency confusion, захват мейнтейнера), инструменты сборки, CI-системы, базовые образы. Защита: пиннинг и lock-файлы, внутренние зеркала, SCA и SBOM, подпись артефактов и provenance (SLSA, Sigstore), проверка подписи при деплое, изолированные эфемерные раннеры, минимальные права токенов, ревью изменений CI.

## [middle] Что такое принцип наименьших привилегий? Пример применения.
Каждому субъекту — только необходимые права на необходимое время. Примеры: отдельная IAM-роль на сервис с доступом только к своему бакету; CI-роль для plan — read-only, для apply — отдельная с approve; ServiceAccount пода без доступа к API; sudo только на конкретные команды; just-in-time доступ к проду.

## [middle] Как защитить SSH-доступ к серверам?
Только ключи (ed25519), без паролей и root-логина, MFA или SSH-сертификаты с коротким сроком (Vault SSH, Teleport, step-ca), bastion/VPN или SSM вместо публичного 22 порта, `AllowGroups`, fail2ban, аудит сессий, централизованные логи, своевременный отзыв доступа.

## [middle] Что такое Zero Trust?
Модель, в которой нет неявного доверия на основе расположения в сети: каждый запрос пользователя и сервиса аутентифицируется, авторизуется и шифруется, учитывается контекст (устройство, identity, риск). Реализация: SSO+MFA, identity-aware proxy, mTLS между сервисами, микросегментация, минимальные права, непрерывный мониторинг.

## [senior] Обнаружили, что сервер скомпрометирован. Ваши действия?
Изолировать (сетевые правила, не выключать сразу, чтобы сохранить память), снять снапшоты дисков и памяти, сохранить логи, оценить масштаб (какие креды/данные были доступны, боковое перемещение), отозвать и ротировать все затронутые секреты и ключи, найти вектор атаки, пересоздать системы из чистых образов, закрыть уязвимость, усилить мониторинг, провести postmortem и выполнить обязательные уведомления.

## [middle] Чем шифрование at rest отличается от in transit?
In transit — защита данных при передаче по сети (TLS, mTLS, VPN, SSH). At rest — защита хранимых данных (шифрование дисков LUKS/EBS, БД TDE, S3 SSE-KMS, бэкапов). Нужны оба; плюс управление ключами (KMS, ротация, разделение доступа к ключам и данным).

# @troubleshooting

## [critical] Секрет утёк в публичный репозиторий
**Действия по порядку:**
1. **Немедленно отозвать/ротировать** секрет (ключ AWS — деактивировать и удалить, токен — отозвать).
2. Проверить использование: CloudTrail по access key ID, логи сервиса, биллинг (майнинг на GPU-инстансах в чужих регионах — классика).
3. Устранить последствия: удалить созданные злоумышленником ресурсы, проверить IAM на новые пользователи/ключи/роли.
4. Удалить из истории Git (`git filter-repo`), обратиться к платформе для очистки кэшей.
5. Предотвращение: gitleaks в pre-commit и CI, push protection, переход на OIDC и роли вместо статических ключей.

## [high] Истёк TLS-сертификат в production
**Симптомы:** клиенты получают `certificate has expired`, падают интеграции, мобильные приложения.

**Решение:** выпустить новый (certbot renew / cert-manager — посмотреть, почему не продлился: `kubectl describe certificate`, `certificaterequest`, `challenge` — часто HTTP-01 challenge не проходит из-за редиректа/WAF/изменённого DNS), установить fullchain, reload. Проверка: `openssl s_client`. Профилактика: автоматическое продление, мониторинг сроков с алертом за 14–21 день, инвентаризация всех сертификатов (включая внутренние, kubeadm, клиентские).

## [high] Аномальная активность: неизвестные процессы и исходящие соединения
См. кейс «Подозрение на взлом» в теме Linux-траблшутинга. Дополнительно в K8s: Falco-алерты, `kubectl get pods -A` на неизвестные поды (майнеры в kube-system), аудит-лог API server (кто создал), проверка RBAC (`kubectl get clusterrolebindings -o wide` — новые привязки к cluster-admin), открытые дашборды/API без аутентификации (Kubernetes Dashboard, kubelet `--anonymous-auth`, Docker API 2375).

## [medium] cert-manager не выпускает сертификат
**Диагностика:**
```bash
kubectl get certificate,certificaterequest,order,challenge -A
kubectl describe challenge <name>
kubectl logs -n cert-manager deploy/cert-manager
```
**Причины:** HTTP-01 — путь `/.well-known/acme-challenge/` не доходит до solver-пода (неверный ingressClass, редирект на HTTPS с другим хостом, WAF, DNS ещё не указывает на кластер); DNS-01 — нет прав на DNS-зону; rate limit Let's Encrypt (используйте staging для тестов); неверный Issuer/ClusterIssuer.

# @quiz

? Что из этого НЕ является аутентификацией?
- Проверка пароля
- Проверка клиентского сертификата
+ Проверка, есть ли у пользователя роль admin
- Проверка OTP-кода
> Это авторизация.

? JWT по умолчанию:
- Зашифрован
+ Подписан, но его содержимое читаемо
- Не может быть подделан без пароля пользователя
- Хранит пароль
> Payload — base64url, не шифрование.

? Лучший способ дать поду в EKS доступ к S3:
- Положить ключи в Secret
- Ключи в переменных окружения Deployment
+ IRSA / EKS Pod Identity
- Роль ноды с полным доступом к S3
> Временные креды, привязанные к конкретному ServiceAccount.

? Какая атака использует metadata-сервис 169.254.169.254?
- XSS
- CSRF
+ SSRF
- SQL injection
> Защита — IMDSv2, allowlist URL, egress-фильтрация.

? Что делает Falco?
- Сканирует образы на CVE
+ Обнаруживает подозрительное поведение в рантайме по системным вызовам
- Подписывает образы
- Шифрует etcd
> Например, запуск shell в контейнере.

? Что первым делом сделать при утечке ключа в Git?
+ Отозвать и ротировать ключ
- Переписать историю
- Удалить репозиторий
- Сделать коммит с удалением файла
> История могла быть уже скопирована.

? Что даёт подпись образов cosign с проверкой при деплое?
- Ускоряет pull
+ Гарантирует, что образ собран доверенным пайплайном и не подменён
- Удаляет уязвимости
- Шифрует слои
> Проверку делают admission-контроллеры (Kyverno, policy-controller).
