---
id: ansible
title: Ansible
icon: 🅰️
order: 100
group: Оркестрация и IaC
color: #ee0000
summary: Inventory, playbooks, модули и идемпотентность, переменные и их приоритет, Jinja2, роли и коллекции, handlers, Vault, производительность и отладка.
---

# @theory

## Как работает Ansible

- **Agentless**: на управляемых хостах нужен только SSH и Python (для Windows — WinRM/SSH + PowerShell).
- **Push-модель**: control node подключается к хостам и выполняет задачи. (Pull-режим — `ansible-pull`.)
- Каждая задача: Ansible генерирует Python-скрипт модуля → копирует по SSH во временный каталог хоста → выполняет → получает JSON-результат → удаляет.
- **Идемпотентность**: модули описывают **желаемое состояние** (`state: present`) и ничего не меняют, если оно уже достигнуто. Повторный прогон должен дать `changed=0`.

| Понятие | Что это |
|---|---|
| **Inventory** | список хостов и групп + переменные |
| **Module** | единица работы (`apt`, `copy`, `template`, `service`, `user`...) |
| **Task** | вызов модуля с параметрами |
| **Play** | набор задач, применяемых к группе хостов |
| **Playbook** | YAML-файл с одним или несколькими play |
| **Role** | переиспользуемая структура задач, шаблонов, переменных, handlers |
| **Collection** | пакет ролей, модулей и плагинов (`community.general`, `amazon.aws`) |
| **Handler** | задача, выполняемая по уведомлению (`notify`) в конце play |
| **Facts** | собранная информация о хосте (`ansible_facts`) |

## Inventory

```ini inventory/prod/hosts.ini
[web]
web1.example.com
web2.example.com ansible_host=10.0.1.12

[db]
db1.example.com ansible_user=admin ansible_port=2222

[prod:children]
web
db

[web:vars]
nginx_worker_processes=4
```

```yaml inventory/prod/hosts.yml
all:
  vars:
    ansible_user: deploy
    ansible_ssh_common_args: "-o ProxyJump=bastion.example.com"
  children:
    web:
      hosts:
        web[1:3].example.com:
    db:
      hosts:
        db1.example.com:
          postgres_role: primary
```

- Переменные лучше выносить в `group_vars/<group>.yml` и `host_vars/<host>.yml` рядом с inventory.
- **Динамический inventory** — плагины `amazon.aws.aws_ec2`, `gcp_compute`, `kubernetes.core.k8s`: хосты берутся из API облака по тегам.

```bash
ansible-inventory -i inventory/prod --graph
ansible-inventory -i inventory/prod --host web1.example.com
```

## Ad-hoc команды

```bash
ansible all -i inventory -m ping
ansible web -m shell -a "uptime" -o
ansible web -b -m apt -a "name=htop state=present update_cache=yes"
ansible db -b -m service -a "name=postgresql state=restarted"
ansible all -m setup -a "filter=ansible_distribution*"
ansible web -m copy -a "src=./motd dest=/etc/motd" -b --check --diff
ansible all -m command -a "df -h /" --limit 'web1*'
```
`-b` (become) — sudo, `-K` — спросить пароль sudo, `-f 20` — число параллельных хостов (forks), `-l` — ограничить хосты.

## Playbook

```yaml site.yml
- name: Настройка веб-серверов
  hosts: web
  become: true
  vars:
    app_port: 8080
  pre_tasks:
    - name: Обновить кэш apt
      ansible.builtin.apt:
        update_cache: true
        cache_valid_time: 3600

  tasks:
    - name: Установить nginx
      ansible.builtin.apt:
        name: nginx
        state: present

    - name: Конфиг сайта
      ansible.builtin.template:
        src: templates/site.conf.j2
        dest: /etc/nginx/conf.d/site.conf
        owner: root
        mode: "0644"
        validate: nginx -t -c %s
      notify: Reload nginx

    - name: Пользователи
      ansible.builtin.user:
        name: "{{ item.name }}"
        groups: "{{ item.groups | default([]) }}"
        shell: /bin/bash
      loop: "{{ users }}"
      loop_control:
        label: "{{ item.name }}"

    - name: Проверить версию приложения
      ansible.builtin.command: /opt/app/bin/app --version
      register: app_version
      changed_when: false

    - name: Мигрировать, если версия старая
      ansible.builtin.command: /opt/app/bin/migrate
      when: "'2.0' not in app_version.stdout"

    - name: Nginx запущен и в автозагрузке
      ansible.builtin.service:
        name: nginx
        state: started
        enabled: true

  handlers:
    - name: Reload nginx
      ansible.builtin.service:
        name: nginx
        state: reloaded
```

```bash
ansible-playbook -i inventory/prod site.yml
ansible-playbook site.yml --check --diff         # dry-run с показом изменений
ansible-playbook site.yml --limit web1 --tags nginx
ansible-playbook site.yml --start-at-task "Конфиг сайта"
ansible-playbook site.yml --syntax-check
ansible-playbook site.yml -e "app_version=1.4.2" -vvv
ansible-playbook site.yml --list-tasks --list-hosts
```

### Важные ключевые слова задач
| Ключ | Назначение |
|---|---|
| `when` | условие |
| `loop` / `with_*` | цикл |
| `register` | сохранить результат задачи в переменную |
| `notify` | уведомить handler (выполнится один раз в конце play, только если задача `changed`) |
| `changed_when` / `failed_when` | своё определение изменения/ошибки |
| `ignore_errors` | не падать (лучше `failed_when` с условием) |
| `tags` | выборочный запуск |
| `delegate_to` | выполнить на другом хосте (например, убрать из балансировщика) |
| `run_once` | один раз для группы |
| `become` / `become_user` | повышение привилегий |
| `block` / `rescue` / `always` | обработка ошибок (try/catch/finally) |
| `async` / `poll` | долгие задачи в фоне |
| `no_log: true` | не выводить секреты в лог |

### command vs shell vs специализированные модули
- `command` — без shell: нет пайпов, перенаправлений, переменных окружения. Безопаснее.
- `shell` — через `/bin/sh`: пайпы и т.п.
- Оба **не идемпотентны** — Ansible всегда считает их `changed`. Используйте `creates:`/`removes:`, `changed_when`, а лучше — специализированный модуль (`apt`, `lineinfile`, `systemd`, `get_url`, `unarchive`, `postgresql_db`...).

## Переменные и приоритеты

Переменные можно задать в 20+ местах. Упрощённо по **возрастанию** приоритета:

1. defaults роли (`roles/x/defaults/main.yml`) — самый низкий, для переопределения
2. inventory vars, `group_vars/all`, `group_vars/<group>`
3. `host_vars/<host>`
4. facts хоста
5. `vars:` в play, `vars_files`
6. vars роли (`roles/x/vars/main.yml`)
7. `set_fact`, `register`
8. параметры роли/include
9. **`-e` extra vars — самый высокий**, перекрывает всё

> [!tip]
> Правило: значения по умолчанию — в `defaults/` роли; окружение-специфичное — в `group_vars`; `vars/` роли — для внутренних констант; `-e` — только для разовых переопределений.

### Магические переменные
`hostvars['db1']['ansible_host']`, `groups['web']`, `inventory_hostname`, `ansible_play_hosts`, `ansible_facts['distribution']`, `ansible_check_mode`.

## Jinja2 шаблоны

```jinja templates/site.conf.j2
# {{ ansible_managed }}
upstream app {
{% for host in groups['app'] %}
    server {{ hostvars[host]['ansible_host'] | default(host) }}:{{ app_port }};
{% endfor %}
}

server {
    listen 80;
    server_name {{ server_name }};
{% if enable_gzip | default(true) %}
    gzip on;
{% endif %}
    location / {
        proxy_pass http://app;
    }
}
```

Полезные фильтры: `default()`, `mandatory`, `bool`, `int`, `lower`, `join(',')`, `to_nice_yaml`, `to_json`, `from_json`, `regex_replace`, `selectattr('x','equalto','y')`, `map(attribute='name')`, `combine`, `dict2items`, `b64encode`, `password_hash('sha512')`, `ipaddr`.

## Роли и коллекции

```text Структура роли
roles/nginx/
├── defaults/main.yml     # переменные по умолчанию (низкий приоритет)
├── vars/main.yml         # константы роли (высокий приоритет)
├── tasks/main.yml        # задачи
├── handlers/main.yml
├── templates/            # .j2
├── files/                # статичные файлы
├── meta/main.yml         # зависимости, платформы
└── molecule/default/     # тесты
```

```bash
ansible-galaxy role init roles/nginx
ansible-galaxy install -r requirements.yml
ansible-galaxy collection install community.general amazon.aws
```

```yaml requirements.yml
collections:
  - name: community.general
    version: ">=9.0.0"
  - name: kubernetes.core
roles:
  - name: geerlingguy.docker
    version: 7.4.1
```

- `import_role` / `import_tasks` — **статически** при разборе (теги и `when` применяются ко всем задачам).
- `include_role` / `include_tasks` — **динамически** во время выполнения (можно в циклах, по условию).
- Используйте FQCN (`ansible.builtin.copy`) — однозначно и требуется линтером.

## Ansible Vault и секреты

```bash
ansible-vault create group_vars/prod/vault.yml
ansible-vault edit group_vars/prod/vault.yml
ansible-vault encrypt_string 's3cr3t' --name 'db_password'
ansible-playbook site.yml --ask-vault-pass
ansible-playbook site.yml --vault-password-file ~/.vault_pass     # в CI — из секрета
ansible-vault rekey file.yml
```
Практика: `group_vars/prod/vars.yml` — `db_password: "{{ vault_db_password }}"`, а `vault.yml` (зашифрованный) — `vault_db_password: ...`. Так видно, какие переменные есть, без расшифровки. Альтернативы — lookup из HashiCorp Vault (`community.hashi_vault`), AWS SSM/Secrets Manager. `no_log: true` для задач с секретами.

## Стратегии, rolling update, производительность

```yaml
- hosts: web
  serial: "25%"                  # катить батчами по 25% хостов
  max_fail_percentage: 10
  strategy: linear               # или free — каждый хост независимо
  tasks:
    - name: Убрать из балансировщика
      community.general.haproxy:
        state: disabled
        host: "{{ inventory_hostname }}"
      delegate_to: "{{ item }}"
      loop: "{{ groups['lb'] }}"
    # ... деплой, проверка health ...
    - name: Вернуть в балансировщик
      community.general.haproxy:
        state: enabled
        host: "{{ inventory_hostname }}"
      delegate_to: "{{ item }}"
      loop: "{{ groups['lb'] }}"
```

```ini ansible.cfg
[defaults]
inventory = inventory/prod
forks = 30
host_key_checking = True
gathering = smart
fact_caching = jsonfile
fact_caching_connection = .facts_cache
fact_caching_timeout = 3600
callbacks_enabled = profile_tasks, timer
stdout_callback = yaml

[ssh_connection]
pipelining = True
ssh_args = -o ControlMaster=auto -o ControlPersist=60s
```
Ускорение: `pipelining` (меньше SSH-операций; требует отключения `requiretty` в sudoers), ControlPersist, увеличить `forks`, `gather_facts: false` где не нужно или кэш фактов, `strategy: free`, Mitogen (сторонний).

## Тестирование и качество

- **ansible-lint** — линтер (FQCN, идемпотентность, имена задач, `command` вместо модулей).
- `--syntax-check`, `--check --diff` — dry-run (не все модули поддерживают check mode).
- **Molecule** — тестирование ролей: поднимает контейнер/ВМ (драйвер docker/podman), применяет роль, проверяет **идемпотентность** (второй прогон без changed) и запускает verify (Ansible/Testinfra).
- **AWX / Ansible Automation Platform / Semaphore** — веб-интерфейс, RBAC, расписания, хранение кредов, аудит запусков.

# @interview

## [junior] Что такое Ansible и чем он отличается от Chef/Puppet?
Инструмент управления конфигурацией и автоматизации без агентов: работает по SSH, push-модель, YAML-плейбуки. Chef/Puppet — агентские pull-модели с собственным сервером, DSL на Ruby. Ansible проще порог входа и не требует установки агентов.

## [junior] Что такое идемпотентность и почему она важна?
Повторное выполнение даёт тот же результат и не вносит изменений, если система уже в нужном состоянии. Позволяет безопасно перезапускать плейбуки, использовать их для обнаружения дрейфа (`--check`), не ломать работающие сервисы лишними рестартами.

## [junior] Чем command отличается от shell?
`command` выполняет программу напрямую, без интерпретатора — нет пайпов, перенаправлений, подстановок переменных окружения; безопаснее. `shell` выполняет через `/bin/sh` и поддерживает всё это. Оба не идемпотентны — нужно `creates`/`changed_when` или специализированный модуль.

## [junior] Что такое handlers?
Задачи, которые запускаются по уведомлению `notify` от других задач и только если те завершились со статусом changed. Выполняются один раз в конце play (или при `meta: flush_handlers`), даже если уведомлений было несколько. Типично — reload/restart сервиса после изменения конфига.

## [middle] Каков приоритет переменных в Ansible?
От низшего к высшему (упрощённо): defaults роли → inventory/group_vars/all → group_vars групп → host_vars → facts → vars плея и vars_files → vars роли → set_fact/register → параметры include/role → extra vars (`-e`) — наивысший.

## [middle] Чем import_* отличается от include_*?
`import_*` — статический: подстановка при парсинге плейбука, теги и условия наследуются всеми задачами, нельзя использовать в loop, имя должно быть известно заранее. `include_*` — динамический: выполняется в рантайме, можно в циклах и с переменными в имени, но `--list-tasks` их не видит, и теги не наследуются по умолчанию.

## [middle] Как хранить секреты в Ansible?
Ansible Vault (шифрование AES256 файлов или отдельных строк), пароль к vault — в менеджере секретов CI. Или внешние хранилища через lookup-плагины (HashiCorp Vault, AWS Secrets Manager). Задачи с секретами помечать `no_log: true`.

## [middle] Как сделать rolling update приложения на 50 серверах без простоя?
`serial` (батчами), `max_fail_percentage`, перед обновлением хоста — вывод из балансировщика (`delegate_to` на LB), деплой, проверка health (`uri` с retries/until), возврат в балансировщик. `any_errors_fatal` для остановки при ошибке.

## [middle] Как ускорить выполнение плейбуков на большом количестве хостов?
Увеличить `forks`, включить `pipelining` и SSH ControlPersist, кэшировать или отключать сбор фактов, `strategy: free`, избегать лишних циклов по `command` (использовать модули, принимающие списки — `apt: name: [a, b]`), async для долгих задач, разбивать на теги.

## [middle] Что такое facts? Как их отключить?
Информация о хосте (ОС, IP, CPU, память, диски), собираемая модулем setup в начале play. Отключается `gather_facts: false`; можно собирать выборочно (`gather_subset`) и кэшировать (fact_caching).

## [middle] Как тестировать Ansible-роли?
ansible-lint, `--syntax-check`, `--check --diff`, Molecule: создание тестового окружения в контейнерах/ВМ, converge, проверка идемпотентности, verify (Testinfra/Ansible assert), destroy — в CI на каждый PR.

## [senior] Ansible или Terraform для создания инфраструктуры в облаке?
Terraform: декларативный, state, граф зависимостей, план изменений, удаление ресурсов при удалении из кода — лучше для провижининга. Ansible может создавать облачные ресурсы, но без state сложно отслеживать удаление и дрейф. Типичная связка: Terraform/Packer создают инфраструктуру и образы, Ansible конфигурирует ОС и приложения (или используется для операций — патчинг, ротация).

## [middle] Что делает delegate_to и run_once?
`delegate_to` выполняет задачу на другом хосте (LB, localhost, БД), сохраняя контекст текущего хоста (переменные). `run_once` выполняет задачу один раз для всего батча (например, миграцию БД), результат доступен всем хостам.

## [middle] Как обработать ошибки в плейбуке?
`block`/`rescue`/`always`, `failed_when` с конкретным условием, `ignore_errors` (осторожно), `ignore_unreachable`, `any_errors_fatal`, `max_fail_percentage`, `until`/`retries`/`delay` для повторов.

# @troubleshooting

## [high] UNREACHABLE: Failed to connect to the host via ssh
**Диагностика:**
```bash
ansible web1 -m ping -vvvv            # точная ssh-команда и ошибка
ssh -v deploy@web1                    # проверить вручную тем же пользователем/ключом
ansible-inventory --host web1         # какие ansible_host/user/port реально применяются
```
**Причины:** неверный `ansible_user`/ключ, host key не принят (`Host key verification failed` — добавить в known_hosts, а не отключать проверку глобально), bastion не настроен (`ansible_ssh_common_args`), DNS/файрвол.

## [medium] MODULE FAILURE: /usr/bin/python: not found
**Причина:** на хосте нет Python или он в другом месте (минимальные образы, старые системы).

**Решение:** `ansible_python_interpreter=/usr/bin/python3` в inventory; или bootstrap через `raw`: `ansible host -m raw -a "apt-get install -y python3"`.

## [medium] Missing sudo password / sudo: a password is required
**Решение:** `-K` (`--ask-become-pass`), `ansible_become_password` из Vault, или NOPASSWD для пользователя деплоя в `/etc/sudoers.d/`. При `pipelining` — убедиться, что в sudoers нет `requiretty`.

## [medium] Задача всегда changed (не идемпотентна)
**Причины:** `command`/`shell` без `changed_when`/`creates`; шаблон, содержащий меняющиеся данные (время в `ansible_managed`, неотсортированный словарь); `lineinfile` с регуляркой, которая не находит строку после изменения.

**Решение:** заменить на специализированный модуль, `changed_when: false` для информационных команд, `creates:`, стабильные шаблоны. Проверка — второй прогон должен дать `changed=0` (Molecule idempotence).

## [medium] Переменная имеет «не то» значение
**Диагностика:**
```yaml
- ansible.builtin.debug:
    var: hostvars[inventory_hostname]['my_var']
```
`ansible-inventory --host x --vars`, `-vvv`. Почти всегда это приоритет переменных (значение из `vars/` роли перекрывает `group_vars`, или `-e` в CI) или одинаковое имя в разных группах, где хост состоит в нескольких группах (побеждает группа, идущая позже по алфавиту, или по `ansible_group_priority`).

# @quiz

? На управляемом Linux-хосте для работы Ansible нужно:
- Агент Ansible
+ SSH и Python
- Docker
- Puppet agent
> Ansible — agentless.

? Когда выполняются handlers?
- Сразу после notify
+ Один раз в конце play, если уведомившая задача changed
- Перед каждой задачей
- Только при ошибке
> Можно форсировать meta: flush_handlers.

? Какой источник переменных имеет наивысший приоритет?
- group_vars
- defaults роли
+ extra vars (-e)
- host_vars
> -e перекрывает всё.

? Как запустить плейбук без изменений, показав, что было бы изменено?
- --dry
+ --check --diff
- --simulate
- --plan
> check mode поддерживают не все модули.

? Что делает `serial: 2` в play?
+ Выполняет play батчами по 2 хоста
- Выполняет задачи последовательно на всех хостах
- Повторяет play 2 раза
- Ограничивает forks до 2
> Используется для rolling update.

? Какой модуль безопаснее для запуска бинарника без shell-конструкций?
+ ansible.builtin.command
- ansible.builtin.shell
- ansible.builtin.raw
- ansible.builtin.script
> command не интерпретирует пайпы и переменные окружения.
