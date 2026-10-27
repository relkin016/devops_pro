---
id: networking
title: Сети
icon: 🌐
order: 40
group: Фундамент
color: #58a6ff
summary: OSI/TCP-IP, IP и подсети, TCP/UDP, DNS, HTTP/HTTPS/TLS, маршрутизация, NAT, iptables/nftables, балансировка, VPN и инструменты диагностики.
---

# @theory

## Модели OSI и TCP/IP

| # | OSI | Что там | Протоколы / сущности | TCP/IP |
|---|---|---|---|---|
| 7 | Прикладной | данные приложения | HTTP, DNS, SSH, SMTP, gRPC | Application |
| 6 | Представления | кодирование, шифрование | TLS (условно), JSON, gzip | Application |
| 5 | Сеансовый | сессии | (RPC, TLS-сессии) | Application |
| 4 | Транспортный | сегменты, порты | **TCP, UDP**, QUIC | Transport |
| 3 | Сетевой | пакеты, IP-адреса, маршрутизация | **IP**, ICMP, IPsec | Internet |
| 2 | Канальный | кадры, MAC-адреса | Ethernet, ARP, VLAN (802.1Q), Wi-Fi | Link |
| 1 | Физический | биты, сигналы | кабели, оптика, радио | Link |

**Инкапсуляция:** HTTP-данные → TCP-сегмент (порты) → IP-пакет (адреса) → Ethernet-кадр (MAC) → биты.

Привязка к инфраструктуре: **L4-балансировщик** (AWS NLB, IPVS, HAProxy в режиме tcp) видит только IP:порт; **L7** (nginx, ALB, Ingress, Envoy) понимает HTTP — хосты, пути, заголовки, куки.

> [!interview]
> Типичный вопрос: «На каком уровне работает свитч / роутер / балансировщик?» — свитч L2 (MAC), роутер L3 (IP), балансировщик L4 или L7. Ping — ICMP, уровень 3, портов не имеет.

## IP-адресация и подсети

IPv4-адрес — 32 бита: `192.168.10.25`. Маска определяет, какая часть — сеть, а какая — хост. CIDR-нотация: `/24` = первые 24 бита — сеть.

| CIDR | Маска | Адресов | Хостов (−2) |
|---|---|---|---|
| /32 | 255.255.255.255 | 1 | 1 (один хост) |
| /30 | 255.255.255.252 | 4 | 2 |
| /28 | 255.255.255.240 | 16 | 14 |
| /24 | 255.255.255.0 | 256 | 254 |
| /22 | 255.255.252.0 | 1024 | 1022 |
| /16 | 255.255.0.0 | 65 536 | 65 534 |
| /8 | 255.0.0.0 | 16 777 216 | |

Формула: адресов = 2^(32 − префикс). Первый адрес — адрес сети, последний — broadcast. В AWS в каждой подсети резервируется **5** адресов (сеть, роутер, DNS, резерв, broadcast).

### Пример расчёта: 10.20.30.77/27
- /27 → блок 32 адреса, границы кратны 32: 0, 32, 64, 96…
- 77 попадает в 64–95 → сеть `10.20.30.64`, broadcast `10.20.30.95`, хосты `.65–.94` (30 шт.), маска `255.255.255.224`.

### Специальные диапазоны
| Диапазон | Назначение |
|---|---|
| `10.0.0.0/8`, `172.16.0.0/12`, `192.168.0.0/16` | частные (RFC 1918) |
| `100.64.0.0/10` | CGNAT (провайдеры, иногда K8s/Tailscale) |
| `127.0.0.0/8` | loopback |
| `169.254.0.0/16` | link-local; `169.254.169.254` — metadata service в облаках |
| `0.0.0.0/0` | «весь интернет», маршрут по умолчанию |
| `224.0.0.0/4` | multicast |

> [!tip] Планируйте CIDR заранее
> VPC, подсети, Pod CIDR и Service CIDR Kubernetes, Docker bridge (`172.17.0.0/16`) и офисные VPN-сети не должны пересекаться, иначе пиринг и VPN не заработают. Это частая проблема «docker сломал доступ к корпоративной сети».

### IPv6 вкратце
128 бит, запись `2001:db8::1`, нет NAT как необходимости, `/64` — стандартная подсеть, SLAAC для автоконфигурации, `::1` — loopback, `fe80::/10` — link-local. NDP вместо ARP.

## L2: MAC, ARP, VLAN

- **MAC-адрес** — 48 бит, адрес сетевой карты в пределах сегмента L2.
- **ARP** — «у кого IP 10.0.0.1? Сообщите MAC». Ответ кэшируется: `ip neigh`.
- Если адресат в **другой** подсети, хост отправляет кадр на MAC **шлюза** (default gateway), а IP-адрес назначения остаётся конечным.
- **Свитч** учит MAC-адреса по портам (CAM-таблица) и пересылает кадры только нужному порту.
- **VLAN** (802.1Q) — логическое разделение одного физического свитча на несколько L2-доменов по тегу.

```bash
ip link; ip -br addr
ip neigh                     # ARP-таблица
arping -I eth0 10.0.0.1      # L2 доступность
bridge link; bridge fdb      # Linux bridge (Docker, KVM)
```

## TCP и UDP

### TCP
Надёжный, упорядоченный поток байт с установлением соединения, контролем потока (окно) и перегрузки (congestion control: CUBIC, BBR).

**Трёхстороннее рукопожатие:**
1. Клиент → `SYN` (seq = x)
2. Сервер → `SYN-ACK` (seq = y, ack = x+1)
3. Клиент → `ACK` (ack = y+1) — соединение ESTABLISHED.

**Завершение (4 шага):** `FIN` → `ACK` → `FIN` → `ACK`. Сторона, закрывшая первой, уходит в **TIME_WAIT** на 2×MSL (в Linux 60 с), чтобы поздние пакеты старого соединения не попали в новое. `RST` — немедленный обрыв.

| Состояние | Значение |
|---|---|
| LISTEN | сервер ждёт соединений |
| SYN_SENT | клиент отправил SYN, ждёт ответа (висит — файрвол/недоступен) |
| SYN_RECV | сервер получил SYN (много — SYN flood или переполнена очередь accept) |
| ESTABLISHED | установлено |
| FIN_WAIT_1/2 | мы закрыли, ждём другую сторону |
| CLOSE_WAIT | **другая сторона закрыла, а наше приложение — нет** (много = баг/утечка в приложении) |
| TIME_WAIT | закрыто, выжидаем (много = много коротких исходящих соединений) |
| LAST_ACK | ждём последний ACK |

```bash
ss -tan state time-wait | wc -l
ss -tan | awk 'NR>1 {print $1}' | sort | uniq -c
ss -tnp state close-wait
```

### UDP
Без соединения, без гарантий доставки и порядка, минимальный оверхед. Используется: DNS, NTP, DHCP, syslog, VoIP, видео, **QUIC/HTTP3**, WireGuard, VXLAN.

| | TCP | UDP |
|---|---|---|
| Соединение | есть (handshake) | нет |
| Надёжность | ретрансмиты, подтверждения | нет |
| Порядок | гарантирован | нет |
| Скорость/латентность | выше накладные расходы | минимальные |
| Примеры | HTTP/1-2, SSH, БД | DNS, QUIC, NTP, стриминг |

### Порты, которые надо знать
| Порт | Сервис | Порт | Сервис |
|---|---|---|---|
| 22 | SSH | 443 | HTTPS |
| 25/587/465 | SMTP | 3306 | MySQL |
| 53 | DNS (UDP+TCP) | 5432 | PostgreSQL |
| 67/68 | DHCP | 6379 | Redis |
| 80 | HTTP | 9090 | Prometheus |
| 123 | NTP (UDP) | 2379/2380 | etcd |
| 161 | SNMP | 6443 | Kubernetes API |
| 389/636 | LDAP/LDAPS | 10250 | kubelet |
| 1194 | OpenVPN | 51820 | WireGuard |
| 2375/2376 | Docker API | 30000–32767 | NodePort K8s |

Эфемерные (исходящие) порты: `net.ipv4.ip_local_port_range` (по умолчанию 32768–60999).

## DNS

DNS переводит имена в адреса. Иерархия: корень `.` → TLD (`.com`) → авторитетные серверы домена (`example.com`).

### Как работает резолвинг
1. Приложение вызывает `getaddrinfo()` → libc смотрит `/etc/nsswitch.conf` (порядок: `files dns`) → `/etc/hosts`.
2. Запрос уходит на резолвер из `/etc/resolv.conf` (локальный stub `127.0.0.53` systemd-resolved, или DNS провайдера/облака).
3. **Рекурсивный резолвер** (1.1.1.1, 8.8.8.8, корпоративный), если нет в кэше, идёт **итеративно**: корневой сервер → «спроси у .com» → сервер .com → «спроси у ns1.example.com» → авторитетный сервер → ответ.
4. Ответ кэшируется на время **TTL** на каждом уровне.

### Типы записей
| Тип | Назначение |
|---|---|
| A / AAAA | имя → IPv4 / IPv6 |
| CNAME | алиас на другое имя (нельзя на корне зоны и вместе с другими записями) |
| MX | почтовые серверы с приоритетом |
| TXT | произвольный текст: SPF, DKIM, DMARC, верификация домена |
| NS | авторитетные серверы зоны |
| SOA | параметры зоны (серийный номер, refresh, TTL отрицательного кэша) |
| PTR | обратная зона: IP → имя |
| SRV | сервис: `_sip._tcp.example.com` → хост:порт (используется в K8s) |
| CAA | какие CA могут выпускать сертификаты |
| ALIAS/ANAME | нестандарт (Route 53 alias) — «CNAME на корне» |

```bash
dig example.com                     # A
dig +short example.com AAAA
dig example.com MX +noall +answer
dig @8.8.8.8 example.com            # через конкретный сервер
dig +trace example.com              # весь путь от корня
dig -x 8.8.8.8                      # PTR
dig example.com NS; dig example.com SOA
nslookup example.com; host example.com
resolvectl query example.com; resolvectl statistics
getent ahosts example.com           # как увидит приложение
```

> [!warn] DNS и TTL при миграциях
> Перед переездом снижайте TTL записи (например, до 60 с) **заранее** — за время старого TTL. Иначе клиенты будут ходить на старый IP часами. Учтите негативное кэширование (NXDOMAIN кэшируется по SOA minimum).

### В Kubernetes
`/etc/resolv.conf` пода содержит `search ns.svc.cluster.local svc.cluster.local cluster.local` и `options ndots:5` — имена с меньше чем 5 точками сначала пробуются с суффиксами. Из-за этого запрос `api.example.com` порождает до 4–5 лишних запросов. Лечится FQDN с точкой на конце (`api.example.com.`) или `dnsConfig.options ndots: 2`.

## HTTP

### Запрос и ответ
```text HTTP/1.1
GET /api/users?id=5 HTTP/1.1
Host: api.example.com
User-Agent: curl/8.5
Accept: application/json
Authorization: Bearer eyJ...

HTTP/1.1 200 OK
Content-Type: application/json
Content-Length: 42
Cache-Control: no-store

{"id":5,"name":"Ann"}
```

### Методы
`GET` (чтение, идемпотентный, безопасный), `POST` (создание, не идемпотентный), `PUT` (замена, идемпотентный), `PATCH` (частичное изменение), `DELETE` (идемпотентный), `HEAD` (только заголовки), `OPTIONS` (CORS preflight).

### Коды ответа
| Код | Значение | Типичная причина в эксплуатации |
|---|---|---|
| 200 / 201 / 204 | OK / Created / No Content | |
| 301 / 302 / 307 / 308 | редиректы (постоянный / временный; 307/308 сохраняют метод) | HTTP→HTTPS |
| 304 | Not Modified | кэш |
| 400 | Bad Request | кривой запрос, слишком большой заголовок/кука |
| 401 | Unauthorized — нет/неверная аутентификация | |
| 403 | Forbidden — аутентифицирован, но нет прав | права на файлы у nginx, WAF, IP-фильтр |
| 404 | Not Found | неверный путь/роут Ingress |
| 405 | Method Not Allowed | |
| 408 | Request Timeout | |
| 413 | Payload Too Large | `client_max_body_size` в nginx |
| 429 | Too Many Requests | rate limit |
| 499 | (nginx) клиент закрыл соединение | клиент не дождался |
| **500** | Internal Server Error | исключение в приложении |
| **502** | Bad Gateway — прокси получил неверный ответ / не смог соединиться с upstream | upstream упал, не слушает порт, сбросил соединение |
| **503** | Service Unavailable | нет живых бэкендов, перегрузка, maintenance |
| **504** | Gateway Timeout — upstream не ответил вовремя | медленный бэкенд/БД, `proxy_read_timeout` |

> [!interview] 502 vs 504
> 502 — прокси **не смог получить нормальный ответ** (соединение отклонено/сброшено, бэкенд упал). 504 — соединение установлено, но ответ **не пришёл за таймаут**. Диагностика: логи прокси (`upstream prematurely closed`, `connect() failed (111: Connection refused)`, `upstream timed out`), состояние бэкендов.

### Версии
- **HTTP/1.1** — keep-alive, но один запрос за раз на соединение (head-of-line blocking), браузеры открывают ~6 соединений.
- **HTTP/2** — бинарный, мультиплексирование потоков в одном TCP-соединении, сжатие заголовков HPACK. Нужен для gRPC.
- **HTTP/3** — поверх **QUIC (UDP)**, нет HOL-блокировки на уровне TCP, быстрый handshake (0-RTT), миграция соединений.

### Важные заголовки
`Host`, `X-Forwarded-For` / `X-Real-IP` (реальный IP клиента за прокси), `X-Forwarded-Proto`, `Connection: keep-alive`, `Cache-Control`, `ETag`, `Set-Cookie` (`Secure; HttpOnly; SameSite`), `Strict-Transport-Security`, `Access-Control-Allow-Origin` (CORS), `Content-Security-Policy`.

## TLS и HTTPS

TLS обеспечивает **конфиденциальность** (шифрование), **целостность** и **аутентификацию сервера** (сертификат).

### TLS 1.3 handshake (упрощённо)
1. **ClientHello**: поддерживаемые версии и шифры, ключевая доля (key share, ECDHE), **SNI** — имя хоста.
2. **ServerHello**: выбранный шифр + своя key share. С этого момента обе стороны вычисляют общий секрет (Diffie-Hellman) и дальше всё шифруется.
3. Сервер отправляет **сертификат** и подпись (CertificateVerify), Finished.
4. Клиент проверяет цепочку сертификатов до доверенного корневого CA, имя (SAN), срок. Finished. 1-RTT (TLS 1.2 — 2-RTT).

Асимметричная криптография используется для обмена ключами и аутентификации, сами данные шифруются **симметрично** (AES-GCM, ChaCha20). ECDHE даёт **forward secrecy**: утечка приватного ключа сервера не позволит расшифровать записанный ранее трафик.

### Сертификаты
- Цепочка: **leaf** (сертификат сайта) → **intermediate CA** → **root CA** (в хранилище ОС/браузера). Сервер должен отдавать leaf + intermediate (fullchain).
- Имя проверяется по **SAN** (Subject Alternative Name), CN устарел. Wildcard `*.example.com` покрывает один уровень.
- **mTLS** — клиент тоже предъявляет сертификат (service mesh, внутренние API).
- Let's Encrypt — бесплатные сертификаты на 90 дней через ACME (certbot, cert-manager), проверки HTTP-01 / DNS-01.

```bash
openssl s_client -connect example.com:443 -servername example.com -showcerts </dev/null
echo | openssl s_client -connect host:443 2>/dev/null | openssl x509 -noout -subject -issuer -dates -ext subjectAltName
openssl x509 -in cert.pem -noout -text
openssl verify -CAfile chain.pem cert.pem
openssl req -x509 -newkey rsa:2048 -nodes -keyout key.pem -out cert.pem -days 365 -subj "/CN=test.local"
# Проверить, что ключ соответствует сертификату
openssl x509 -noout -modulus -in cert.pem | md5sum; openssl rsa -noout -modulus -in key.pem | md5sum
curl -vI https://example.com 2>&1 | grep -E "SSL|subject|expire|issuer"
```

## Маршрутизация и NAT

### Как хост решает, куда отправить пакет
Таблица маршрутизации: выбирается маршрут с **самым длинным совпадающим префиксом** (longest prefix match). Если ничего не подошло — `default`.
```bash
ip route
# default via 10.0.0.1 dev eth0
# 10.0.0.0/24 dev eth0 proto kernel scope link src 10.0.0.15
# 172.17.0.0/16 dev docker0
ip route get 8.8.8.8            # какой маршрут будет выбран
ip route add 192.168.50.0/24 via 10.0.0.254
ip rule                          # policy routing
```

### NAT
- **SNAT / Masquerade** — подмена адреса источника: частные адреса выходят в интернет под публичным IP (домашний роутер, AWS NAT Gateway, Docker для контейнеров).
- **DNAT** — подмена адреса назначения: проброс портов (`docker run -p 8080:80`, kube-proxy для Service).
- Conntrack хранит таблицу трансляций: `conntrack -L`, `conntrack -S`. Переполнение `nf_conntrack_max` → `nf_conntrack: table full, dropping packet`.

### Маршрутизация в интернете
**BGP** — протокол обмена маршрутами между автономными системами (AS) провайдеров. Внутри сетей — OSPF, IS-IS. В Kubernetes BGP используют Calico и MetalLB.

## Файрвол: iptables и nftables

### Netfilter: таблицы и цепочки
Таблицы: `filter` (разрешить/запретить), `nat`, `mangle` (изменение пакетов), `raw` (до conntrack).

Цепочки:
- **PREROUTING** — сразу при входе (DNAT здесь)
- **INPUT** — пакеты для локальных процессов
- **FORWARD** — транзитные пакеты (роутер, Docker, K8s)
- **OUTPUT** — сгенерированные локально
- **POSTROUTING** — перед выходом (SNAT/MASQUERADE здесь)

Путь входящего пакета: `PREROUTING → (решение о маршруте) → INPUT` (если нам) или `→ FORWARD → POSTROUTING` (если транзит).

```bash
iptables -L -n -v --line-numbers
iptables -A INPUT -m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT
iptables -A INPUT -i lo -j ACCEPT
iptables -A INPUT -p tcp --dport 22 -s 10.0.0.0/8 -j ACCEPT
iptables -A INPUT -p tcp -m multiport --dports 80,443 -j ACCEPT
iptables -P INPUT DROP                         # политика по умолчанию
iptables -t nat -A PREROUTING -p tcp --dport 8080 -j DNAT --to-destination 10.0.0.5:80
iptables -t nat -A POSTROUTING -s 10.8.0.0/24 -o eth0 -j MASQUERADE
iptables-save > /etc/iptables/rules.v4         # сохранить
iptables-restore < /etc/iptables/rules.v4
```

> [!danger] Порядок правил важен
> Правила проверяются сверху вниз до первого совпадения с терминальным действием. Если поставить `-P INPUT DROP` до разрешения SSH — вы отрежете себе доступ. Правило `-A` добавляет в конец, `-I` — в начало.

- `DROP` — молча выкинуть (клиент получит timeout), `REJECT` — ответить ошибкой (клиент сразу получит connection refused).
- **nftables** — современная замена (`nft list ruleset`), iptables в новых дистрибутивах — обёртка `iptables-nft`.
- Обёртки: **ufw** (Ubuntu), **firewalld** (RHEL, зоны).
- В облаках поверх — **Security Groups** (stateful, на уровне инстанса) и **NACL** (stateless, на подсеть).

## Балансировка нагрузки

### Уровни
| | L4 | L7 |
|---|---|---|
| Видит | IP, порт, протокол | HTTP: хост, путь, заголовки, куки |
| Примеры | AWS NLB, IPVS, HAProxy tcp, MetalLB | nginx, HAProxy http, Envoy, Traefik, AWS ALB, Ingress |
| TLS | обычно проходит насквозь | терминирует, может перешифровывать |
| Скорость | выше | ниже, но умнее (роутинг, ретраи, rate limit) |

### Алгоритмы
- **Round Robin** (по кругу), **Weighted RR**
- **Least connections** — на бэкенд с наименьшим числом активных соединений
- **IP hash / consistent hashing** — один клиент → один бэкенд (sticky без кук; консистентное хэширование минимизирует перераспределение при изменении пула)
- **Random with two choices (P2C)**, **EWMA / least latency** (Envoy, Linkerd)

### Health checks
Активные (балансировщик сам опрашивает `/health`) и пассивные (выключать бэкенд после N ошибок — `max_fails` в nginx, outlier detection в Envoy).

### Сохранение IP клиента
За L7-прокси приложение видит IP прокси — реальный передаётся в `X-Forwarded-For`. За L4 — **PROXY protocol** или `externalTrafficPolicy: Local` в K8s.

### Высокая доступность самого балансировщика
VRRP (**keepalived**) с плавающим (virtual) IP, DNS round robin, anycast (BGP), облачные managed LB.

## VPN и туннели

- **WireGuard** — современный, быстрый, простой (UDP, ключи как у SSH), встроен в ядро.
- **OpenVPN** — TLS-based, гибкий, медленнее.
- **IPsec** — стандарт для site-to-site (облака: AWS Site-to-Site VPN).
- Оверлеи: **VXLAN** (L2 поверх UDP 4789 — Flannel, Calico VXLAN), **GRE**, **Geneve**.
- **MTU**: туннели добавляют заголовки (WireGuard ~60–80 байт, VXLAN 50). Если MTU не уменьшить, большие пакеты теряются: «ping работает, а HTTPS/SSH зависает после handshake». Решение — уменьшить MTU или включить MSS clamping.

```ini /etc/wireguard/wg0.conf
[Interface]
Address = 10.8.0.1/24
ListenPort = 51820
PrivateKey = <server-private>

[Peer]
PublicKey = <client-public>
AllowedIPs = 10.8.0.2/32
```

## Инструменты диагностики

| Задача | Команда |
|---|---|
| Адреса, интерфейсы | `ip -br a`, `ip link`, `ethtool eth0` |
| Маршруты | `ip route`, `ip route get IP` |
| Доступность хоста | `ping`, `arping` |
| Путь пакета | `traceroute -T -p 443 host`, `mtr -rwc 100 host`, `tracepath` |
| Слушающие порты | `ss -tulpn` |
| Соединения | `ss -tanp`, `ss -s`, `conntrack -L` |
| Проверка порта | `nc -zv host 443`, `telnet host 443`, `bash -c '</dev/tcp/host/443'` |
| HTTP | `curl -v`, `curl -w`, `httpie` |
| DNS | `dig`, `host`, `resolvectl` |
| Пакеты | `tcpdump`, `tshark`, Wireshark |
| Пропускная способность | `iperf3 -s` / `iperf3 -c host` |
| Сканирование | `nmap -sT -p 1-1000 host` |
| Статистика | `ip -s link`, `nstat`, `netstat -s`, `sar -n DEV,TCP,ETCP 1` |

### curl для диагностики
```bash
curl -sv https://api.example.com/health
curl -o /dev/null -s -w 'dns=%{time_namelookup} connect=%{time_connect} tls=%{time_appconnect} ttfb=%{time_starttransfer} total=%{time_total} code=%{http_code}\n' https://example.com
curl --resolve api.example.com:443:10.0.0.5 https://api.example.com/   # обойти DNS, проверить конкретный бэкенд
curl -H "Host: site.local" http://10.0.0.5/                             # виртуальный хост
curl -k                      # игнорировать ошибку сертификата (только для диагностики!)
curl --http2 / --http3
```

### tcpdump
```bash
tcpdump -ni eth0 host 10.0.0.5 and port 5432
tcpdump -ni any 'tcp[tcpflags] & (tcp-syn|tcp-rst) != 0'      # только SYN и RST
tcpdump -ni eth0 -w dump.pcap -s0 port 443                     # записать для Wireshark
tcpdump -ni any -A port 80 | grep -i host:                     # посмотреть HTTP-заголовки
tcpdump -ni eth0 udp port 53                                   # DNS-запросы
```

## Что происходит, когда вводишь URL в браузер

Классический вопрос, хороший ответ охватывает все уровни:

1. **Парсинг URL**: схема, хост, порт, путь. HSTS-список может сразу заменить http на https.
2. **DNS**: кэш браузера → кэш ОС → `/etc/hosts` → резолвер → рекурсивный поиск (корень → TLD → авторитетный) → IP.
3. **TCP**: ARP для MAC шлюза → трёхстороннее рукопожатие с сервером (через NAT, маршрутизаторы, возможно CDN/anycast).
4. **TLS**: ClientHello с SNI → сертификат → проверка цепочки → общий ключ. (HTTP/3 — QUIC сразу поверх UDP.)
5. **HTTP-запрос**: GET с заголовками, куками.
6. **Сервер**: CDN / L4-балансировщик → L7 (nginx/Ingress) → приложение → кэш/БД → ответ.
7. **Ответ**: код, заголовки, тело; браузер парсит HTML, строит DOM/CSSOM, загружает ресурсы (часто по тому же соединению в HTTP/2), выполняет JS, рендерит.
8. Соединение остаётся для keep-alive или закрывается.

# @interview

## [junior] Чем TCP отличается от UDP? Приведите примеры использования.
TCP — с установлением соединения, гарантией доставки, порядка и контролем перегрузки (HTTP/1-2, SSH, БД). UDP — без соединения и гарантий, минимальная задержка (DNS, NTP, стриминг, VoIP, QUIC/HTTP3, WireGuard, VXLAN).

## [junior] Опишите TCP three-way handshake.
Клиент отправляет SYN со своим начальным sequence number, сервер отвечает SYN-ACK (свой seq + подтверждение клиентского), клиент отвечает ACK. После этого соединение ESTABLISHED, можно передавать данные.

## [middle] Что такое TIME_WAIT и почему много таких соединений — проблема?
Состояние стороны, закрывшей соединение первой: держится 2×MSL (60 с в Linux), чтобы задержавшиеся пакеты не попали в новое соединение с той же четвёркой адресов/портов. Много TIME_WAIT на клиенте (например, приложение открывает новое соединение к БД/API на каждый запрос) может исчерпать эфемерные порты → `Cannot assign requested address`. Решения: keep-alive и пулы соединений, расширить `ip_local_port_range`, `tcp_tw_reuse=1`.

## [middle] Много соединений в CLOSE_WAIT — что это значит?
Удалённая сторона закрыла соединение (прислала FIN), а наше приложение не вызвало `close()` на сокете. Это почти всегда баг в приложении (утечка соединений, зависшие потоки). Сам ядро их не закроет. Смотреть `ss -tnp state close-wait`, исправлять код/пулы, временно — перезапуск.

## [junior] Что такое DNS? Какие типы записей знаете?
Система преобразования имён в адреса. A/AAAA (IPv4/IPv6), CNAME (алиас), MX (почта), TXT (SPF/DKIM/верификация), NS (авторитетные серверы), SOA (параметры зоны), PTR (обратная зона), SRV (сервисы), CAA (разрешённые CA).

## [middle] Опишите процесс разрешения DNS-имени от начала до конца.
Приложение → libc (`nsswitch.conf`, `/etc/hosts`) → резолвер из `/etc/resolv.conf` (часто локальный кэш systemd-resolved) → рекурсивный резолвер. Если нет в кэше, он итеративно спрашивает корневые серверы (получает NS для TLD), затем серверы TLD (получает NS домена), затем авторитетный сервер домена — получает A-запись. Ответ кэшируется по TTL на всех уровнях.

## [junior] Почему CNAME нельзя ставить на корень домена?
CNAME не может сосуществовать с другими записями для того же имени, а на корне зоны обязательно есть SOA и NS. Решения — ALIAS/ANAME-записи у провайдеров DNS (Route 53 alias, Cloudflare CNAME flattening).

## [junior] Что такое подсеть /24? Сколько в ней хостов?
256 адресов (2^8), из них 254 для хостов (минус адрес сети и broadcast). Маска 255.255.255.0.

## [middle] Хосты 10.0.1.10/24 и 10.0.2.10/24 в одном свитче. Пингуют ли они друг друга?
Нет (без роутера): они в разных подсетях, поэтому каждый будет слать пакет на свой default gateway, а не напрямую по ARP. Если шлюза нет или он не маршрутизирует между этими сетями — связи не будет.

## [middle] В чём разница между 502, 503 и 504?
502 Bad Gateway — прокси не получил корректный ответ от upstream (соединение отклонено/сброшено, бэкенд упал). 503 — сервис недоступен: нет здоровых бэкендов, перегрузка, maintenance, rate limit в некоторых прокси. 504 Gateway Timeout — upstream не ответил вовремя. Диагностика — логи прокси и бэкенда, health checks, таймауты.

## [middle] Как работает HTTPS / TLS handshake?
Клиент отправляет ClientHello (версии, шифры, SNI, ключевую долю ECDHE). Сервер отвечает ServerHello со своей долей, сертификатом и подписью. Обе стороны вычисляют общий симметричный ключ (Diffie-Hellman), клиент проверяет сертификат: цепочка до доверенного CA, имя в SAN, срок действия, отзыв. Далее данные шифруются симметрично (AES-GCM/ChaCha20). TLS 1.3 — 1 RTT, есть 0-RTT для повторных соединений.

## [middle] Что такое SNI и зачем он нужен?
Server Name Indication — расширение TLS, в котором клиент в ClientHello указывает имя хоста. Позволяет одному IP:443 обслуживать множество доменов с разными сертификатами (виртуальные хосты, Ingress, CDN). Без SNI сервер не знает, какой сертификат отдать.

## [middle] Чем отличаются L4 и L7 балансировщики?
L4 работает с IP/портами (TCP/UDP), не смотрит внутрь — быстрый, прозрачный, TLS пропускается насквозь. L7 разбирает протокол приложения (HTTP): маршрутизация по хосту/пути/заголовкам, терминирование TLS, ретраи, rate limiting, sticky sessions по кукам, gRPC-балансировка по запросам.

## [middle] Что такое NAT? Чем SNAT отличается от DNAT?
Подмена адресов в заголовках IP. SNAT (masquerade) меняет адрес **источника** — выход частной сети в интернет под публичным IP. DNAT меняет адрес **назначения** — проброс портов, публикация сервиса. Ядро запоминает трансляции в conntrack для обратного трафика.

## [middle] Чем DROP отличается от REJECT в iptables?
DROP молча отбрасывает пакет — клиент ждёт до таймаута (`Connection timed out`). REJECT отправляет ICMP unreachable или TCP RST — клиент сразу получает ошибку (`Connection refused`). DROP скрывает наличие хоста, REJECT удобнее для внутренних сетей.

## [middle] Чем Security Group отличается от Network ACL в AWS?
SG — stateful (ответный трафик разрешён автоматически), применяется к ENI/инстансу, только allow-правила, можно ссылаться на другие SG. NACL — stateless (нужно явно разрешать ответный трафик на эфемерные порты), применяется к подсети, есть allow и deny, правила обрабатываются по номеру.

## [senior] Ping до сервера проходит, SSH подключается, но при выводе большого файла или HTTPS-загрузке всё зависает. Что это?
Классический симптом проблем с **MTU / Path MTU Discovery**: маленькие пакеты проходят, большие — нет, потому что где-то в пути (VPN, туннель, оверлей) MTU меньше, а ICMP «Fragmentation needed» блокируется файрволом. Проверка: `ping -M do -s 1472 host` (уменьшать размер), `tracepath`. Решение: уменьшить MTU интерфейса, MSS clamping (`iptables -t mangle -A FORWARD -p tcp --tcp-flags SYN,RST SYN -j TCPMSS --clamp-mss-to-pmtu`), разрешить ICMP type 3 code 4.

## [middle] Что произойдёт, когда вы введёте google.com в браузере?
См. раздел теории: URL → HSTS → DNS (кэши, рекурсия) → ARP до шлюза → TCP handshake → TLS (SNI, сертификат, ключ) → HTTP-запрос → CDN/балансировщик → приложение → ответ → рендеринг. Хороший ответ показывает понимание всех слоёв и где может сломаться.

## [junior] Как проверить, открыт ли порт на удалённом хосте?
`nc -zv host 443`, `telnet host 443`, `nmap -p 443 host`, `curl -v telnet://host:443`, `timeout 2 bash -c '</dev/tcp/host/443'`. Локально — `ss -tlpn`.

## [senior] Что такое conntrack и какие проблемы с ним бывают?
Модуль netfilter, отслеживающий состояние соединений (нужен для stateful-файрвола и NAT). Проблемы: переполнение таблицы `nf_conntrack_max` при большом числе соединений (`table full, dropping packet` — характерно для нод K8s с kube-proxy iptables, DNS через UDP); гонки при DNAT UDP (известная проблема с DNS-таймаутами 5 с в K8s). Решения: увеличить `nf_conntrack_max` и уменьшить таймауты, NodeLocal DNSCache, IPVS/eBPF (Cilium).

## [middle] Что такое anycast?
Один IP-адрес анонсируется по BGP из многих точек, и маршрутизация сама доставляет клиента к ближайшей. Используется публичными DNS (1.1.1.1, 8.8.8.8), CDN, DDoS-защитой.

## [middle] Как узнать реальный IP клиента за балансировщиком?
L7-прокси добавляет `X-Forwarded-For` / `X-Real-IP` (в nginx — `real_ip_header` + `set_real_ip_from` для доверенных прокси). Для L4 — PROXY protocol (поддерживают nginx, HAProxy, AWS NLB) или сохранение source IP (`externalTrafficPolicy: Local` в K8s, NLB с IP-таргетами).

## [middle] Что такое VLAN и зачем?
Логическое разделение L2-сети на изолированные широковещательные домены на одном физическом оборудовании с помощью тегов 802.1Q. Позволяет разделить трафик (управление, хранилище, пользователи), уменьшить broadcast-домен, повысить безопасность. Между VLAN трафик идёт только через маршрутизатор/L3-свитч.

# @troubleshooting

## [high] Connection refused vs Connection timed out
**Как различать:**
- **refused** — пакет дошёл, но в ответ RST: на порту никто не слушает, или слушает на другом интерфейсе (`127.0.0.1` вместо `0.0.0.0`), или REJECT в файрволе.
- **timed out** — ответа нет совсем: DROP в файрволе/SG/NACL, нет маршрута, хост выключен, асимметричная маршрутизация.

**Диагностика:**
```bash
# на сервере
ss -tlpn | grep 8080            # 127.0.0.1:8080 → снаружи не достучаться!
iptables -L INPUT -n -v | head; nft list ruleset | head -50
# на клиенте
nc -zv host 8080
traceroute -T -p 8080 host
tcpdump -ni any port 8080       # на сервере: доходят ли SYN?
```
**Частая причина в Docker/K8s:** приложение слушает `localhost` внутри контейнера — нужно `0.0.0.0`.

## [high] Медленные ответы: где теряется время
**Диагностика:**
```bash
curl -o /dev/null -s -w 'dns:%{time_namelookup} tcp:%{time_connect} tls:%{time_appconnect} ttfb:%{time_starttransfer} total:%{time_total}\n' https://site
```
- Большой `dns` → проблемы резолвера (таймауты, ndots в K8s, недоступен первый nameserver — смотрите на ровно 5 с).
- Большой `tcp` → сеть/потери (`mtr`), перегруженный балансировщик, SYN backlog.
- Большой `tls` → медленный handshake, OCSP, CPU на терминаторе.
- Большой `ttfb − tls` → медленное приложение/БД.

## [high] DNS-таймауты по 5 секунд
**Симптомы:** периодически запросы тормозят ровно на 5 с (или кратно 5).

**Причина:** таймаут резолвера по умолчанию 5 с: первый nameserver недоступен, потерянный UDP-пакет, гонка conntrack при одновременных A и AAAA запросах с одного сокета (известная проблема в K8s).

**Решение:** убрать мёртвый nameserver, `options timeout:1 attempts:2`, `options single-request-reopen` (glibc), в K8s — NodeLocal DNSCache, уменьшить `ndots`.

## [high] Cannot assign requested address — кончились эфемерные порты
**Симптомы:** исходящие соединения падают с `EADDRNOTAVAIL`, в `ss -s` десятки тысяч TIME_WAIT.

**Решение:**
```bash
ss -tan state time-wait | awk '{print $4}' | cut -d: -f1 | sort | uniq -c | sort -rn | head
sysctl net.ipv4.ip_local_port_range
sysctl -w net.ipv4.ip_local_port_range="10240 65535"
sysctl -w net.ipv4.tcp_tw_reuse=1
```
Главное — включить keep-alive / пул соединений в приложении (HTTP-клиент, драйвер БД), чтобы не открывать соединение на каждый запрос.

## [critical] nf_conntrack: table full, dropping packet
**Симптомы:** случайные потери пакетов и таймауты под нагрузкой, сообщение в `dmesg`.

**Решение:**
```bash
sysctl net.netfilter.nf_conntrack_count net.netfilter.nf_conntrack_max
sysctl -w net.netfilter.nf_conntrack_max=1048576
sysctl -w net.netfilter.nf_conntrack_tcp_timeout_established=86400
conntrack -S
```
Сохранить в `/etc/sysctl.d/`. Для высоконагруженных балансировщиков — исключить трафик из conntrack (`-t raw ... -j NOTRACK`).

## [high] Большие пакеты теряются (MTU)
**Симптомы:** ping работает, SSH логинится, но `cat` большого файла, `git clone`, TLS к некоторым сайтам или `docker pull` внутри VPN/оверлея виснут.

**Диагностика:**
```bash
ping -M do -s 1472 host      # 1472 + 28 = 1500; уменьшаем, пока не пройдёт
tracepath host               # покажет pmtu
ip link show | grep mtu
```
**Решение:** выставить MTU туннеля/интерфейса (например, 1420 для WireGuard, 1450 для VXLAN; в Docker — `"mtu": 1400` в daemon.json), MSS clamping на шлюзе, не блокировать ICMP «fragmentation needed».

## [medium] После установки Docker пропал доступ к сети офиса/VPN
**Причина:** диапазон Docker bridge (`172.17.0.0/16`) или сетей compose (`172.18+.0.0/16`) пересёкся с корпоративной сетью — маршрут в docker0 перехватывает трафик.

**Решение:** в `/etc/docker/daemon.json` задать `"bip": "10.200.0.1/24"` и `"default-address-pools": [{"base":"10.201.0.0/16","size":24}]`, перезапустить Docker, пересоздать сети.

## [medium] Сертификат: unable to get local issuer certificate
**Причина:** сервер отдаёт только leaf-сертификат без intermediate, или у клиента нет корневого CA (корпоративный CA, самоподписанный, старый ca-certificates в образе).

**Решение:**
```bash
openssl s_client -connect host:443 -servername host -showcerts </dev/null   # сколько сертификатов в цепочке
```
На сервере — использовать `fullchain.pem`. На клиенте — добавить CA: `cp ca.crt /usr/local/share/ca-certificates/ && update-ca-certificates` (Debian) или `/etc/pki/ca-trust/source/anchors/` + `update-ca-trust` (RHEL); в Docker-образе — установить `ca-certificates`.

# @quiz

? Сколько адресов для хостов в подсети /27?
- 32
+ 30
- 62
- 14
> 2^5 = 32, минус адрес сети и broadcast.

? В какую подсеть входит 10.20.30.77/26?
- 10.20.30.0/26
+ 10.20.30.64/26
- 10.20.30.76/26
- 10.20.30.128/26
> Блок /26 = 64 адреса: 0–63, 64–127, ...

? Какой статус означает, что прокси не дождался ответа от бэкенда?
- 502
- 503
+ 504
- 499
> 504 Gateway Timeout.

? На каком уровне OSI работает ARP?
- L1
+ L2 (на стыке с L3)
- L4
- L7
> ARP сопоставляет IP-адреса и MAC-адреса в пределах L2-сегмента.

? Много соединений в CLOSE_WAIT на сервере обычно говорит о:
- SYN flood
+ Приложение не закрывает сокеты после FIN от удалённой стороны
- Проблемах с DNS
- Нехватке эфемерных портов
> CLOSE_WAIT ждёт вызова close() от нашего приложения.

? Какая запись DNS используется для проверки владения доменом и SPF?
- MX
- PTR
+ TXT
- SRV
> TXT хранит произвольный текст, в т.ч. SPF/DKIM/DMARC.

? Что делает SNI?
- Шифрует имя хоста
+ Передаёт имя хоста в ClientHello, чтобы сервер выбрал сертификат
- Проверяет отзыв сертификата
- Сжимает заголовки
> SNI позволяет много HTTPS-сайтов на одном IP.

? Какой протокол лежит в основе HTTP/3?
- TCP
- SCTP
+ QUIC поверх UDP
- WebSocket
> QUIC реализует надёжность и шифрование поверх UDP.

? В какой цепочке iptables делается SNAT/MASQUERADE?
- PREROUTING
- INPUT
+ POSTROUTING
- FORWARD
> Адрес источника меняется перед выходом пакета.

? Security Group в AWS:
+ Stateful, только allow-правила
- Stateless, allow и deny
- Stateful, только deny
- Работает на уровне подсети
> NACL — stateless и на уровне подсети.

? Ping работает, но HTTPS через VPN зависает после handshake. Скорее всего:
- Неверный DNS
+ Проблема с MTU / PMTUD
- Истёк сертификат
- Закрыт порт 443
> Маленькие пакеты проходят, большие — нет.

? Какой адрес используется для metadata-сервиса в облаках?
- 127.0.0.53
+ 169.254.169.254
- 10.0.0.2
- 100.64.0.1
> Link-local адрес metadata (AWS, GCP, Azure, OpenStack).
