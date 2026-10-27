---
id: nginx
title: Nginx и прокси
icon: 🟩
order: 120
group: Контейнеры и доставка
color: #009639
summary: Архитектура nginx, location и приоритеты, reverse proxy, upstream и балансировка, TLS, кэш, rate limiting, HAProxy, разбор 502/504/413.
---

# @theory

## Архитектура nginx

- **Master-процесс** (root): читает конфиг, открывает порты, управляет воркерами.
- **Worker-процессы** (непривилегированный пользователь): обрабатывают соединения. Каждый воркер — однопоточный **event loop** (epoll), обслуживает тысячи соединений неблокирующе.
- Максимум соединений ≈ `worker_processes × worker_connections` (при проксировании каждое клиентское соединение использует ещё одно к upstream).

```nginx /etc/nginx/nginx.conf
user www-data;
worker_processes auto;            # по числу ядер
worker_rlimit_nofile 65535;

events {
    worker_connections 4096;
}

http {
    include       mime.types;
    sendfile      on;
    tcp_nopush    on;
    keepalive_timeout 65;
    server_tokens off;
    client_max_body_size 20m;

    log_format main '$remote_addr - $request_id [$time_local] "$request" $status $body_bytes_sent '
                    '"$http_referer" "$http_user_agent" rt=$request_time uct=$upstream_connect_time '
                    'urt=$upstream_response_time ua="$upstream_addr" us=$upstream_status';
    access_log /var/log/nginx/access.log main;
    error_log  /var/log/nginx/error.log warn;

    gzip on;
    gzip_types text/css application/javascript application/json image/svg+xml;

    include /etc/nginx/conf.d/*.conf;
}
```

```bash
nginx -t                      # проверить конфиг (всегда перед reload!)
nginx -T                      # показать итоговый конфиг со всеми include
nginx -s reload               # плавная перезагрузка: новые воркеры, старые доделывают запросы
systemctl reload nginx
nginx -V                      # версия и модули сборки
```

Reload без потери соединений: master перечитывает конфиг, запускает новых воркеров, старым посылает команду graceful shutdown. Если конфиг невалиден — продолжают работать старые воркеры.

## server и location

### Выбор server
1. По `listen` (адрес:порт).
2. По `server_name` (Host / SNI): точное имя → wildcard в начале `*.example.com` → wildcard в конце → regex `~^...` → `default_server` (или первый в списке).

### Выбор location (важно для собеса)
| Модификатор | Тип | Приоритет |
|---|---|---|
| `= /path` | точное совпадение | 1 — сразу выбирается |
| `^~ /path` | префикс, отключающий проверку regex | 2 — если это самый длинный префикс |
| `~ regex` / `~* regex` | регулярка (с учётом / без учёта регистра) | 3 — первая подошедшая **по порядку в файле** |
| `/path` | обычный префикс | 4 — самый длинный, если не нашлась регулярка |

Алгоритм: nginx находит **самый длинный префикс**, запоминает его; если он с `^~` — берёт его; иначе проверяет регулярки по порядку, первая совпавшая побеждает; если ни одна — берёт запомненный префикс.

```nginx site.conf
server {
    listen 80;
    server_name example.com www.example.com;
    return 301 https://example.com$request_uri;
}

server {
    listen 443 ssl;
    http2 on;
    server_name example.com;

    root /var/www/app/public;
    index index.html;

    location = /health { access_log off; return 200 "ok\n"; }

    location ^~ /static/ {
        expires 30d;
        add_header Cache-Control "public, immutable";
    }

    location ~* \.(png|jpg|svg|woff2)$ {
        expires 7d;
    }

    location /api/ {
        proxy_pass http://api_backend;     # см. раздел про proxy_pass и слеш
    }

    location / {
        try_files $uri $uri/ /index.html;  # SPA: всё неизвестное → index.html
    }
}
```

### root vs alias
- `root /var/www;` + `location /img/` → файл `/var/www/img/a.png` (путь location **добавляется**).
- `alias /data/images/;` + `location /img/` → файл `/data/images/a.png` (путь location **заменяется**). Слеши в alias и location должны совпадать.

## Reverse proxy

```nginx
upstream api_backend {
    least_conn;
    server 10.0.1.10:8080 max_fails=3 fail_timeout=10s;
    server 10.0.1.11:8080 max_fails=3 fail_timeout=10s;
    server 10.0.1.12:8080 backup;
    keepalive 64;                         # пул keep-alive соединений к upstream
}

location /api/ {
    proxy_pass http://api_backend;
    proxy_http_version 1.1;
    proxy_set_header Connection "";       # нужно для keepalive к upstream
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_set_header X-Request-ID $request_id;
    proxy_connect_timeout 5s;
    proxy_send_timeout 60s;
    proxy_read_timeout 60s;
    proxy_next_upstream error timeout http_502 http_503;
    proxy_next_upstream_tries 2;
}

# WebSocket
location /ws/ {
    proxy_pass http://api_backend;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
    proxy_read_timeout 3600s;
}
```

### Слеш в proxy_pass — классическая ловушка
| location | proxy_pass | Запрос `/api/users` уходит как |
|---|---|---|
| `/api/` | `http://b` | `/api/users` (URI без изменений) |
| `/api/` | `http://b/` | `/users` (часть location **заменяется** на `/`) |
| `/api/` | `http://b/v2/` | `/v2/users` |

Правило: если в `proxy_pass` указан URI (хотя бы `/`), совпавшая часть location заменяется им; если нет — URI передаётся как есть.

### Алгоритмы балансировки
`round-robin` (по умолчанию, с `weight`), `least_conn`, `ip_hash` (липкость по IP), `hash $key consistent` (консистентное хэширование), `random two least_conn`. Активные health checks — только в NGINX Plus (или модули/OpenResty); в OSS — пассивные (`max_fails`, `fail_timeout`).

### Реальный IP за другим прокси/CDN
```nginx
set_real_ip_from 10.0.0.0/8;        # доверенные прокси
set_real_ip_from 173.245.48.0/20;   # диапазоны Cloudflare
real_ip_header X-Forwarded-For;     # или CF-Connecting-IP / proxy_protocol
real_ip_recursive on;
```

## TLS в nginx

```nginx
server {
    listen 443 ssl;
    http2 on;
    server_name example.com;

    ssl_certificate     /etc/letsencrypt/live/example.com/fullchain.pem;   # leaf + intermediate!
    ssl_certificate_key /etc/letsencrypt/live/example.com/privkey.pem;
    ssl_protocols TLSv1.2 TLSv1.3;
    ssl_prefer_server_ciphers off;
    ssl_session_cache shared:SSL:10m;
    ssl_session_timeout 1d;
    ssl_stapling on;
    ssl_stapling_verify on;

    add_header Strict-Transport-Security "max-age=63072000; includeSubDomains" always;
}
```

```bash
certbot --nginx -d example.com -d www.example.com
certbot renew --dry-run
systemctl list-timers | grep certbot
```
Проверка конфигурации TLS — `testssl.sh example.com`, SSL Labs.

## Кэширование, лимиты, безопасность

### Proxy cache
```nginx
proxy_cache_path /var/cache/nginx levels=1:2 keys_zone=api:50m max_size=5g inactive=60m use_temp_path=off;

location /api/catalog/ {
    proxy_cache api;
    proxy_cache_valid 200 10m;
    proxy_cache_valid 404 1m;
    proxy_cache_use_stale error timeout updating http_500 http_502 http_503;
    proxy_cache_lock on;                         # защита от «стада» на холодный кэш
    add_header X-Cache-Status $upstream_cache_status;
    proxy_pass http://api_backend;
}
```

### Rate limiting
```nginx
limit_req_zone $binary_remote_addr zone=perip:10m rate=10r/s;
limit_conn_zone $binary_remote_addr zone=conns:10m;

location /login {
    limit_req zone=perip burst=20 nodelay;
    limit_req_status 429;
    limit_conn conns 10;
    proxy_pass http://api_backend;
}
```
Алгоритм — leaky bucket: `rate` — скорость «утекания», `burst` — размер очереди, `nodelay` — обслуживать burst сразу, а не растягивать.

### Базовая защита
```nginx
server_tokens off;
add_header X-Content-Type-Options nosniff always;
add_header X-Frame-Options DENY always;
add_header Referrer-Policy strict-origin-when-cross-origin always;
location ~ /\.(git|env|ht) { deny all; }
allow 10.0.0.0/8; deny all;              # доступ к админке только из внутренней сети
auth_basic "Restricted"; auth_basic_user_file /etc/nginx/.htpasswd;
```

> [!warn] add_header и наследование
> Директивы `add_header` наследуются с верхнего уровня **только если** на текущем уровне нет ни одной своей `add_header`. Добавили один заголовок в location — все заголовки из server в нём пропали.

## HAProxy и альтернативы

```text haproxy.cfg
global
    maxconn 50000
defaults
    mode http
    timeout connect 5s
    timeout client  60s
    timeout server  60s
    option httplog
frontend fe_https
    bind :443 ssl crt /etc/haproxy/certs/
    http-request set-header X-Forwarded-Proto https
    default_backend be_api
backend be_api
    balance leastconn
    option httpchk GET /health
    http-check expect status 200
    server api1 10.0.1.10:8080 check inter 2s fall 3 rise 2
    server api2 10.0.1.11:8080 check inter 2s fall 3 rise 2
frontend stats
    bind :8404
    stats enable
    stats uri /stats
```

| | nginx | HAProxy | Envoy | Traefik | Caddy |
|---|---|---|---|---|---|
| Сильная сторона | веб-сервер + прокси, статика, кэш | чистый балансировщик L4/L7, health checks, статистика | динамическая конфигурация (xDS), service mesh, gRPC | авто-конфиг из Docker/K8s, Let's Encrypt | авто-HTTPS, простота |

# @interview

## [junior] Чем nginx отличается от Apache?
nginx — событийная асинхронная архитектура (несколько воркеров, каждый обслуживает тысячи соединений), эффективен по памяти, отлично раздаёт статику и проксирует. Apache — процессная/потоковая модель (prefork/worker/event MPM), `.htaccess`, встроенные модули вроде mod_php. Часто nginx стоит перед приложениями как reverse proxy.

## [middle] Как nginx выбирает location?
Сначала точное `=` (если совпало — сразу). Иначе ищет самый длинный префиксный; если он с `^~` — берёт его. Иначе проверяет регулярки (`~`, `~*`) в порядке объявления, первая совпавшая побеждает. Если регулярки не совпали — используется запомненный самый длинный префикс.

## [middle] Чем отличается proxy_pass http://backend; от proxy_pass http://backend/;?
Без URI запрос передаётся на upstream с исходным путём. С URI (даже `/`) часть пути, совпавшая с location, заменяется на этот URI: `location /api/` + `proxy_pass http://b/` превращает `/api/users` в `/users`.

## [middle] Чем root отличается от alias?
`root` добавляет полный URI к пути: `root /var/www` + `/img/a.png` → `/var/www/img/a.png`. `alias` заменяет часть URI, совпавшую с location: `location /img/ { alias /data/pics/; }` → `/data/pics/a.png`.

## [middle] nginx отдаёт 502. Где искать причину?
error.log nginx: `connect() failed (111: Connection refused)` — бэкенд не слушает порт/упал; `upstream prematurely closed connection` — бэкенд закрыл соединение (упал на запросе, keep-alive таймаут бэкенда меньше чем у nginx); `no live upstreams` — все бэкенды помечены недоступными; `(13: Permission denied)` — SELinux или права на unix-socket; `upstream sent too big header` — увеличить `proxy_buffer_size`. Затем — логи и состояние бэкенда.

## [middle] Как сделать reload nginx без потери соединений?
`nginx -t && nginx -s reload` (или `systemctl reload nginx`): master запускает новые воркеры с новым конфигом, старые перестают принимать новые соединения и завершаются после обработки текущих. Для обновления бинарника — сигнал USR2 (hot upgrade).

## [middle] Как ограничить частоту запросов в nginx?
`limit_req_zone` (ключ — например, `$binary_remote_addr`, зона в памяти, rate) + `limit_req zone=... burst=N nodelay` в location; `limit_conn` для одновременных соединений; код ответа `limit_req_status 429`.

## [middle] Как передать бэкенду реальный IP клиента?
`proxy_set_header X-Real-IP $remote_addr` и `X-Forwarded-For $proxy_add_x_forwarded_for`. Если сам nginx стоит за другим прокси/LB — модуль realip: `set_real_ip_from` доверенные адреса и `real_ip_header`. Для L4-балансировщиков — PROXY protocol (`listen 443 proxy_protocol`).

## [senior] Как настроить keepalive к upstream и зачем?
В `upstream` указать `keepalive N`, в location — `proxy_http_version 1.1` и `proxy_set_header Connection ""`. Снижает задержку и нагрузку на установку TCP/TLS, избегает исчерпания эфемерных портов (TIME_WAIT). Таймаут keep-alive на бэкенде должен быть больше, чем у nginx, иначе возможны 502 из-за гонки закрытия.

## [middle] Как сделать SPA с client-side routing за nginx?
`try_files $uri $uri/ /index.html;` — существующие файлы отдаются как есть, всё остальное — index.html, роутинг обрабатывает JS. API проксировать отдельным location.

# @troubleshooting

## [high] 502 Bad Gateway
**Диагностика:**
```bash
tail -f /var/log/nginx/error.log
curl -v http://127.0.0.1:8080/health      # бэкенд с сервера nginx напрямую
ss -tlpn | grep 8080
```
| В error.log | Причина и решение |
|---|---|
| `connect() failed (111: Connection refused)` | бэкенд не запущен / другой порт / слушает другой интерфейс |
| `connect() to unix:/run/php/php-fpm.sock failed (2: No such file)` | php-fpm не запущен или путь к сокету другой |
| `(13: Permission denied) while connecting` | права на сокет; SELinux: `setsebool -P httpd_can_network_connect 1` |
| `upstream prematurely closed connection` | бэкенд упал на запросе или закрыл keep-alive соединение раньше nginx |
| `upstream sent too big header` | `proxy_buffer_size 16k; proxy_buffers 8 16k;` |
| `no live upstreams` | все серверы upstream помечены down после `max_fails` |

## [high] 504 Gateway Timeout
**Причина:** бэкенд не ответил за `proxy_read_timeout` (60 с по умолчанию): медленный запрос в БД, блокировка, перегрузка, долгая операция (отчёт, экспорт).

**Решение:** найти медленный эндпоинт в access-логе (`$upstream_response_time`), оптимизировать запрос/добавить индекс, длинные операции — асинхронно (очередь + статус). Увеличение таймаута — только осознанно и точечно для конкретного location.

## [medium] 413 Request Entity Too Large
**Решение:** `client_max_body_size 50m;` в http/server/location. В Kubernetes ingress-nginx — аннотация `nginx.ingress.kubernetes.io/proxy-body-size: "50m"`. Проверить лимиты и на следующих уровнях (бэкенд, CDN).

## [medium] 403 Forbidden на статике
**Причины:** у пользователя воркера (`www-data`/`nginx`) нет прав `r` на файл или `x` на любой каталог пути (`namei -l /var/www/app/index.html`), нет index-файла при выключенном autoindex, `deny` в конфиге, SELinux-контекст (`restorecon -Rv /var/www`).

## [medium] Изменения в конфиге не применяются
**Причины:** не сделали reload; конфиг невалиден и reload молча не применился (смотрите `error.log` или `nginx -t`); правите файл, который не подключен через include (`nginx -T | grep server_name`); другой server перехватывает запрос (default_server, порядок server_name); кэш браузера/CDN (301 кэшируется браузером навсегда!).

## [medium] Бесконечный редирект (ERR_TOO_MANY_REDIRECTS)
**Причина:** TLS терминируется на балансировщике/CDN, nginx получает HTTP и редиректит на HTTPS, который снова приходит как HTTP. Или приложение (WordPress, Django) считает, что запрос по HTTP.

**Решение:** редиректить по `$http_x_forwarded_proto`, передавать `X-Forwarded-Proto` в приложение и настроить там доверенный прокси; в Cloudflare — режим SSL Full (strict) вместо Flexible.

# @quiz

? Какой location будет выбран для `/images/logo.png`, если есть `location /images/` и `location ~* \.png$`?
- location /images/
+ location ~* \.png$
- Оба по очереди
- Ошибка конфигурации
> Регулярка побеждает обычный префикс (если у префикса нет ^~).

? `location /api/ { proxy_pass http://b/; }` — какой путь уйдёт на бэкенд для `/api/users`?
- /api/users
+ /users
- /api//users
- /b/users
> Совпавшая часть location заменяется URI из proxy_pass.

? Что означает в error.log `connect() failed (111: Connection refused) while connecting to upstream`?
+ Бэкенд не слушает указанный адрес/порт
- Бэкенд отвечает слишком долго
- Ошибка TLS
- Превышен rate limit
> Это 502.

? Как проверить конфиг nginx перед перезагрузкой?
- nginx -s check
+ nginx -t
- nginx --validate
- systemctl verify nginx
> nginx -T дополнительно печатает итоговый конфиг.

? Что нужно для keep-alive соединений nginx к upstream?
- Только keepalive в upstream
+ keepalive в upstream, proxy_http_version 1.1 и пустой заголовок Connection
- proxy_buffering off
- http2 on
> По умолчанию к upstream используется HTTP/1.0 и Connection: close.
