---
id: linux
title: Linux
icon: 🐧
order: 10
group: Фундамент
color: #f0b429
summary: Ядро, процессы, файловые системы, права, systemd, память, диски, загрузка, namespaces/cgroups — база, без которой нет DevOps.
---

# @theory

## Как устроен Linux

Linux — это **ядро** (kernel). Всё остальное — GNU-утилиты, systemd, shell, пакетный менеджер — это **user space**. Дистрибутив = ядро + user space + пакетная система + политика по умолчанию.

### Kernel space и user space
- **Ядро** работает в привилегированном режиме процессора (ring 0): управляет памятью, планирует процессы, общается с железом через драйверы, реализует файловые системы и сетевой стек.
- **Пользовательские процессы** работают в ring 3 и не могут напрямую трогать железо. Любое действие с внешним миром — через **системный вызов** (syscall): `open`, `read`, `write`, `fork`, `execve`, `mmap`, `socket`, `clone`…
- Переход user → kernel стоит денег (context switch), поэтому, например, буферизация в libc уменьшает число `write()`.

```bash
# Посмотреть, какие syscalls делает команда
strace -c ls /tmp            # сводка по количеству и времени
strace -f -e trace=openat,connect curl -s example.com >/dev/null
```

### «Всё есть файл»
Устройства (`/dev/sda`), процессы (`/proc/<pid>`), параметры ядра (`/proc/sys`, `/sys`), сокеты и пайпы — всё представлено через файловый интерфейс. Это позволяет управлять системой обычными `cat`/`echo`.

### FHS — иерархия каталогов

| Каталог | Назначение |
|---|---|
| `/etc` | Конфигурация системы и сервисов |
| `/var` | Изменяемые данные: `/var/log`, `/var/lib` (БД, docker), `/var/spool`, `/var/cache` |
| `/usr` | Программы и библиотеки (read-only по смыслу), `/usr/local` — собранное вручную |
| `/opt` | Сторонний софт «одной папкой» |
| `/home`, `/root` | Домашние каталоги |
| `/tmp` | Временные файлы (часто tmpfs, чистится при перезагрузке) |
| `/proc` | Виртуальная ФС: процессы и параметры ядра |
| `/sys` | Виртуальная ФС: устройства, драйверы, cgroups |
| `/dev` | Файлы устройств (devtmpfs, управляется udev) |
| `/boot` | Ядро, initramfs, загрузчик |
| `/run` | Runtime-данные с момента загрузки (pid-файлы, сокеты), tmpfs |

> [!interview]
> «Что такое системный вызов и зачем он?» — способ для user-space процесса попросить ядро выполнить привилегированную операцию. Хорошо упомянуть `strace` как инструмент, чтобы их увидеть.

## Файловая система, inode и ссылки

### Inode
Файл в Linux = **inode** (метаданные) + **блоки данных**. Имя файла хранится **не в inode**, а в каталоге: каталог — это таблица «имя → номер inode».

В inode хранится: тип, права, владелец (UID/GID), размер, временные метки (atime/mtime/ctime), число жёстких ссылок, указатели на блоки данных. **Нет имени.**

```bash
ls -li file.txt           # номер inode в первой колонке
stat file.txt             # все метаданные
df -i                     # использование inode по ФС
```

> [!warn] Кончились inode
> На ФС может быть свободно 50% места, но запись падает с `No space left on device`, потому что исчерпаны inode (миллионы мелких файлов: кэши сессий, очереди почты). Проверка — `df -i`.

### Жёсткие и символические ссылки

| | Hard link | Symlink |
|---|---|---|
| Что это | Ещё одно имя для того же inode | Отдельный файл, содержащий путь |
| Между ФС | Нельзя | Можно |
| На каталог | Нельзя (кроме `.` и `..`) | Можно |
| Удалили оригинал | Данные живы, пока есть хотя бы одна ссылка | Ссылка «битая» (dangling) |
| inode | Тот же | Свой |

```bash
ln file.txt hard.txt        # hard link, счётчик ссылок станет 2
ln -s /etc/nginx/nginx.conf conf   # symlink
readlink -f conf            # куда реально указывает
find / -xdev -type l ! -exec test -e {} \; -print   # битые симлинки
```

### Удаление файла и открытые дескрипторы
`rm` удаляет **имя** (запись в каталоге) и уменьшает счётчик ссылок. Данные освобождаются, только когда счётчик = 0 **и** файл не открыт ни одним процессом. Отсюда классика: удалили 20 ГБ лог, а `df` не изменился — процесс держит файл открытым.

```bash
lsof +L1                    # открытые, но удалённые файлы
lsof | grep deleted
# Освободить место без рестарта процесса — обнулить через fd:
: > /proc/<PID>/fd/<FD>
```

### Монтирование
```bash
mount | column -t           # что смонтировано
findmnt                     # дерево точек монтирования
mount -o remount,rw /       # перемонтировать в rw
lsblk -f                    # блочные устройства, ФС, UUID
blkid                       # UUID и типы ФС
```

`/etc/fstab` — что монтировать при загрузке:
```conf /etc/fstab
# <device>                                 <mount>  <type> <options>         <dump> <fsck>
UUID=3f1c...-a1                            /        ext4   defaults,noatime  0      1
UUID=9a2b...-c4                            /data    xfs    defaults,nofail   0      2
//nas/share                                /mnt/nas cifs   credentials=/root/.smb,_netdev 0 0
```

> [!danger] Ошибка в fstab = система не загрузится
> Всегда проверяйте `mount -a` (или `findmnt --verify`) после правки fstab, используйте UUID вместо `/dev/sdX`, а для некритичных дисков — опцию `nofail`.

### Типы файловых систем
- **ext4** — стандарт по умолчанию, надёжная, умеет shrink.
- **XFS** — дефолт в RHEL, отлично для больших файлов и параллельной записи, **нельзя уменьшить**.
- **Btrfs / ZFS** — copy-on-write, снапшоты, контрольные суммы, сжатие.
- **tmpfs** — в памяти; **overlayfs** — слоёная ФС, на ней работают Docker-образы.

## Права доступа

### Классическая модель
Три субъекта — **u**ser (владелец), **g**roup, **o**thers; три права — **r**ead (4), **w**rite (2), e**x**ecute (1).

| Право | Для файла | Для каталога |
|---|---|---|
| r | читать содержимое | получить список имён (`ls`) |
| w | изменять содержимое | создавать/удалять/переименовывать файлы внутри |
| x | исполнять | «входить» (`cd`) и обращаться к файлам по имени |

> [!info] Удаление файла зависит от прав на **каталог**
> Чтобы удалить файл, нужно `w`+`x` на каталог, права на сам файл не важны (если не стоит sticky bit).

```bash
chmod 640 app.conf          # rw- r-- ---
chmod u+x,g-w script.sh
chmod -R u=rwX,go=rX dir/   # X — исполнение только для каталогов и уже исполняемых
chown -R app:app /srv/app
umask                       # 0022 → файлы 644, каталоги 755
```

### Специальные биты
- **SUID (4000)** на исполняемом файле — процесс запускается с правами **владельца файла**. Пример: `/usr/bin/passwd` (владелец root) может писать в `/etc/shadow`. Потенциальная дыра безопасности.
- **SGID (2000)** на файле — с правами группы; **на каталоге** — новые файлы наследуют группу каталога (удобно для общих папок команды).
- **Sticky bit (1000)** на каталоге — удалять файл может только его владелец. Пример: `/tmp` (`drwxrwxrwt`).

```bash
chmod u+s /usr/local/bin/tool   # SUID
chmod g+s /srv/shared           # SGID на каталог
chmod +t /srv/dropbox           # sticky
find / -perm -4000 -type f 2>/dev/null   # аудит SUID-файлов
```

### ACL и атрибуты
```bash
setfacl -m u:deploy:rwx /srv/app      # дать права конкретному пользователю
setfacl -d -m g:dev:rwX /srv/app      # ACL по умолчанию для новых файлов
getfacl /srv/app
chattr +i /etc/resolv.conf            # immutable: даже root не изменит, пока не снимет
lsattr /etc/resolv.conf
```

> [!tip] «Permission denied», хотя права 777?
> Проверьте: права на **все** родительские каталоги (`namei -l /path/to/file`), атрибут `i` (`lsattr`), SELinux/AppArmor (`ls -Z`, `ausearch -m avc`), опции монтирования `noexec`/`ro`.

### Capabilities
Root-права разбиты на ~40 отдельных capabilities. Можно дать процессу только нужную, например слушать порт < 1024 без root:
```bash
setcap 'cap_net_bind_service=+ep' /usr/local/bin/myserver
getcap /usr/local/bin/myserver
grep Cap /proc/$$/status && capsh --decode=0000003fffffffff
```

## Пользователи, группы, sudo

```bash
id deploy                     # uid, gid, группы
useradd -m -s /bin/bash -G sudo deploy
usermod -aG docker deploy     # -a обязательно, иначе группы перезапишутся!
passwd -l deploy              # заблокировать пароль
chage -l deploy               # срок действия пароля
getent passwd deploy          # учитывает LDAP/SSSD, а не только /etc/passwd
```

| Файл | Содержимое |
|---|---|
| `/etc/passwd` | пользователи: `name:x:UID:GID:comment:home:shell` |
| `/etc/shadow` | хэши паролей (читает только root) |
| `/etc/group` | группы и их члены |
| `/etc/sudoers`, `/etc/sudoers.d/` | правила sudo |

```conf /etc/sudoers.d/deploy
# Разрешить перезапуск только одного сервиса без пароля
deploy ALL=(root) NOPASSWD: /usr/bin/systemctl restart myapp
```

> [!warn]
> Редактируйте sudoers только через `visudo` (или `visudo -cf file` для проверки) — синтаксическая ошибка сломает sudo полностью.

UID 0 — root. UID 1–999 — системные пользователи (сервисы), с 1000 — люди. Новые группы применяются только к **новым** сессиям (`newgrp docker` или перелогин).

## Процессы и сигналы

### Жизненный цикл
- Новый процесс создаётся через **fork()** (копия родителя, copy-on-write) и затем **execve()** заменяет образ на новую программу.
- У каждого процесса есть PID, PPID, UID, окружение, таблица файловых дескрипторов (0 stdin, 1 stdout, 2 stderr), рабочий каталог, cgroup и namespaces.
- PID 1 — init (systemd). Он «усыновляет» сирот и собирает их статус.

### Состояния процесса (колонка STAT в ps)

| Код | Состояние |
|---|---|
| R | Running / runnable — выполняется или ждёт CPU |
| S | Interruptible sleep — ждёт события (сокет, таймер) |
| D | **Uninterruptible sleep** — ждёт I/O (диск, NFS). Не убивается даже `kill -9` |
| Z | **Zombie** — завершился, но родитель не вызвал `wait()` |
| T | Stopped (Ctrl+Z, SIGSTOP) или трассируется |
| I | Idle kernel thread |

**Зомби** не потребляют память/CPU, только запись в таблице процессов (PID). Убить зомби нельзя — он уже мёртв; нужно чтобы родитель сделал `wait()` или умер сам (тогда зомби усыновит init и приберёт). **Сирота** (orphan) — живой процесс, родитель которого умер; его усыновляет PID 1.

```bash
ps -eo pid,ppid,stat,%cpu,%mem,etime,cmd --sort=-%cpu | head
ps -eo stat,pid,ppid,cmd | awk '$1 ~ /^Z/'     # зомби и их родители
ps -eo stat,pid,cmd | awk '$1 ~ /^D/'          # процессы в D-state
pstree -p                                       # дерево процессов
cat /proc/<PID>/status                          # память, потоки, capabilities
ls -l /proc/<PID>/fd | wc -l                    # число открытых дескрипторов
cat /proc/<PID>/limits                          # лимиты процесса
```

### Сигналы

| Сигнал | № | Смысл | Можно перехватить? |
|---|---|---|---|
| SIGHUP | 1 | Обрыв терминала; демоны часто перечитывают конфиг | да |
| SIGINT | 2 | Ctrl+C | да |
| SIGQUIT | 3 | Ctrl+\, + core dump | да |
| SIGKILL | 9 | Немедленное убийство ядром | **нет** |
| SIGTERM | 15 | Вежливая просьба завершиться (по умолчанию у `kill`) | да |
| SIGSTOP | 19 | Пауза | **нет** |
| SIGCONT | 18 | Продолжить | да |
| SIGCHLD | 17 | Дочерний процесс завершился | да |
| SIGUSR1/2 | 10/12 | Пользовательские (nginx: переоткрыть логи) | да |

> [!interview] Почему не стоит сразу делать `kill -9`?
> SIGKILL не даёт процессу корректно завершиться: не сбросятся буферы, не закроются транзакции, останутся lock-файлы, временные файлы, «грязные» данные. Правильно: SIGTERM → подождать → только потом SIGKILL. Так же делает Kubernetes (terminationGracePeriodSeconds) и systemd (TimeoutStopSec).

### Приоритеты
```bash
nice -n 10 ./backup.sh       # ниже приоритет (от -20 до 19)
renice -n 5 -p 1234
ionice -c3 -p 1234           # idle-класс для дискового I/O
chrt -p 1234                 # real-time политика
taskset -cp 0,1 1234         # привязка к CPU
```

### Фон и сессии
```bash
cmd &                 # в фоне
jobs; fg %1; bg %1
nohup cmd > out.log 2>&1 &    # переживёт закрытие терминала (SIGHUP игнорируется)
setsid cmd                    # новая сессия
tmux new -s work              # лучший вариант для долгих задач по SSH
```

## systemd и сервисы

systemd — PID 1 в большинстве дистрибутивов. Управляет **юнитами**: `.service`, `.socket`, `.timer`, `.mount`, `.target`, `.path`, `.slice`.

```bash
systemctl status nginx
systemctl start|stop|restart|reload nginx
systemctl enable --now nginx        # автозапуск + сразу запустить
systemctl is-enabled nginx; systemctl is-active nginx
systemctl list-units --failed
systemctl list-unit-files --state=enabled
systemctl cat nginx                 # итоговый unit со всеми drop-in
systemctl edit nginx                # создать override (drop-in)
systemctl daemon-reload             # после изменения unit-файлов
systemctl mask nginx                # запретить запуск совсем (симлинк в /dev/null)
systemd-analyze blame               # что тормозит загрузку
systemd-analyze critical-chain
```

### Свой сервис
```ini /etc/systemd/system/myapp.service
[Unit]
Description=My Go API
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=myapp
Group=myapp
WorkingDirectory=/opt/myapp
EnvironmentFile=/etc/myapp/env
ExecStart=/opt/myapp/bin/api --port 8080
ExecReload=/bin/kill -HUP $MAINPID
Restart=on-failure
RestartSec=5
# Лимиты и изоляция
LimitNOFILE=65536
MemoryMax=512M
CPUQuota=150%
NoNewPrivileges=true
ProtectSystem=strict
ReadWritePaths=/var/lib/myapp
PrivateTmp=true

[Install]
WantedBy=multi-user.target
```

| Type | Когда использовать |
|---|---|
| `simple` | процесс не форкается, запущен = готов (по умолчанию) |
| `exec` | как simple, но успехом считается удачный `execve` |
| `forking` | классический демон, который форкается; нужен `PIDFile` |
| `oneshot` | скрипт, который отработал и вышел (часто с `RemainAfterExit=yes`) |
| `notify` | сервис сам сообщает о готовности через `sd_notify` |

- `Requires=` — жёсткая зависимость, `Wants=` — мягкая. **Порядок** задаётся отдельно: `After=`/`Before=`.
- Drop-in: `/etc/systemd/system/nginx.service.d/override.conf` — не трогаем пакетный unit в `/lib/systemd/system`.
- Targets заменили runlevels: `multi-user.target` (3), `graphical.target` (5), `rescue.target` (1), `emergency.target`.

### journald
```bash
journalctl -u nginx -f                  # follow по юниту
journalctl -u nginx --since "1 hour ago" -p err
journalctl -b -1 -p warning             # предыдущая загрузка
journalctl -k                           # сообщения ядра (как dmesg)
journalctl _PID=1234
journalctl --disk-usage
journalctl --vacuum-size=500M           # почистить журнал
journalctl -o json-pretty -n 5
```
Чтобы журнал переживал ребут: `Storage=persistent` в `/etc/systemd/journald.conf` (или существование `/var/log/journal`).

## Загрузка системы

Последовательность, которую любят спрашивать:

1. **BIOS/UEFI** — POST, инициализация железа, выбор загрузочного устройства. UEFI читает EFI System Partition (FAT32, `/boot/efi`), BIOS — MBR (первые 512 байт).
2. **Загрузчик GRUB2** — показывает меню, загружает **ядро** (`vmlinuz`) и **initramfs** в память, передаёт параметры ядра (`root=UUID=...`, `ro`, `quiet`).
3. **Ядро** — распаковывается, инициализирует CPU, память, драйверы, монтирует initramfs как временный корень.
4. **initramfs** — минимальная среда с драйверами (RAID, LVM, LUKS, NVMe), чтобы найти и смонтировать настоящий root. Затем `switch_root`.
5. **init (systemd, PID 1)** — читает units, параллельно поднимает сервисы до `default.target`.
6. **Login** — getty / display manager / sshd.

```bash
cat /proc/cmdline                 # с какими параметрами загружено ядро
dmesg -T | less                   # лог ядра с человеческим временем
systemctl get-default
ls /boot; lsinitramfs /boot/initrd.img-$(uname -r) | head   # Debian/Ubuntu
update-grub || grub2-mkconfig -o /boot/grub2/grub.cfg
update-initramfs -u || dracut -f
```

> [!tip]
> Ремонт незагружающейся системы (GRUB rescue, fsck, сброс пароля root, chroot с LiveCD) разобран в теме **Linux: траблшутинг**.

## Память

```bash
free -h
#               total   used   free   shared  buff/cache  available
# Mem:           15Gi   4.1Gi  1.2Gi  300Mi   10Gi        10Gi
```

- **used** — память процессов.
- **buff/cache** — page cache (кэш файлов) и буферы. Ядро отдаёт её приложениям по требованию.
- **available** — сколько реально можно выделить, не уходя в swap. **Смотреть надо на неё**, а не на `free`.

> [!interview] «Linux съел всю память»
> Свободная память — потраченная впустую. Ядро использует её под page cache. Если `available` большой — проблемы нет. См. linuxatemyram.com.

### Виртуальная память
- Каждый процесс видит своё виртуальное адресное пространство; MMU переводит его в физические страницы (обычно 4 KiB, бывают HugePages 2 MiB/1 GiB).
- **VSZ** — сколько виртуальной памяти зарезервировано (может быть огромным и ничего не значить), **RSS** — сколько физической памяти реально занято (включая разделяемые библиотеки), **PSS** — RSS с долями разделяемых страниц.
- **Overcommit**: `vm.overcommit_memory` = 0 (эвристика, по умолчанию), 1 (всегда разрешать), 2 (строго, по `overcommit_ratio`).
- **Swap** — выгрузка анонимных страниц на диск. `vm.swappiness` (0–200) — насколько охотно ядро свопит по сравнению со сбросом page cache.

### OOM Killer
Когда памяти не хватает и освободить нечего, ядро выбирает процесс-жертву по `oom_score` (в основном — размер RSS) и убивает его SIGKILL.
```bash
dmesg -T | grep -i -E "killed process|out of memory"
journalctl -k | grep -i oom
cat /proc/<PID>/oom_score
echo -1000 > /proc/<PID>/oom_score_adj     # защитить процесс (-1000 = никогда)
```
В контейнерах OOM срабатывает на уровне cgroup (лимит памяти контейнера), а не всей машины — отсюда `OOMKilled` в Kubernetes.

```bash
vmstat 1                 # si/so — swap in/out, должны быть ~0
smem -rs pss | head      # реальное потребление с учётом shared
cat /proc/meminfo
slabtop                  # память ядра (dentry/inode кэши)
echo 3 > /proc/sys/vm/drop_caches   # сбросить кэш (только для тестов!)
```

## Диски, LVM, RAID

```bash
lsblk                         # дерево дисков и разделов
df -hT                        # место по ФС
du -xh --max-depth=1 / | sort -h | tail     # кто занимает
ncdu -x /                     # интерактивно
fdisk -l; parted -l
smartctl -a /dev/sda          # здоровье диска
iostat -xz 1                  # нагрузка на диски: %util, await, r/s, w/s
iotop -o                      # кто пишет/читает
```

### LVM
Слои: **PV** (physical volume, диск/раздел) → **VG** (volume group, пул) → **LV** (logical volume, «раздел», на котором ФС).

```bash
pvcreate /dev/sdb
vgcreate data /dev/sdb
lvcreate -n pg -L 50G data
mkfs.xfs /dev/data/pg
# Расширение «на горячую»:
vgextend data /dev/sdc
lvextend -r -L +20G /dev/data/pg     # -r сразу расширяет ФС (resize2fs / xfs_growfs)
pvs; vgs; lvs
lvcreate -s -n pg-snap -L 5G /dev/data/pg   # снапшот
```

### Расширение диска в облаке/VM (частая задача)
```bash
# 1. Увеличили диск в консоли облака
growpart /dev/sda 1            # расширить раздел (cloud-guest-utils)
resize2fs /dev/sda1            # ext4
xfs_growfs /                   # xfs (указывается точка монтирования)
```

### RAID
| Уровень | Суть | Выдерживает | Полезный объём |
|---|---|---|---|
| RAID 0 | striping | 0 дисков | 100% |
| RAID 1 | зеркало | n-1 | 50% |
| RAID 5 | striping + parity | 1 диск | (n-1)/n |
| RAID 6 | двойная parity | 2 диска | (n-2)/n |
| RAID 10 | зеркала + striping | по 1 в каждой паре | 50% |

`cat /proc/mdstat`, `mdadm --detail /dev/md0`. **RAID — не бэкап**: он не спасёт от `rm -rf` и шифровальщика.

## Производительность и нагрузка

### Load Average
Три числа (1, 5, 15 минут) — среднее количество процессов в состоянии **R** (выполняются/ждут CPU) **и D** (ждут I/O). Поэтому высокий LA при простаивающем CPU — почти всегда дисковый/NFS I/O.

Интерпретация: сравнивать с числом ядер (`nproc`). LA = 8 на 8 ядрах — полная загрузка; на 2 ядрах — очередь.

### Метод USE (Brendan Gregg)
Для каждого ресурса (CPU, память, диск, сеть) проверить **U**tilization, **S**aturation, **E**rrors.

| Ресурс | Utilization | Saturation | Errors |
|---|---|---|---|
| CPU | `mpstat -P ALL 1`, `top` (us/sy) | LA > ядер, `vmstat` r | — |
| Память | `free -h` | `vmstat` si/so, OOM в dmesg | `dmesg` |
| Диск | `iostat -x` %util | `iostat` aqu-sz, await | `smartctl`, dmesg |
| Сеть | `sar -n DEV 1` | `ss -s`, drops в `ip -s link` | `ip -s link`, `netstat -s` |

### 60-секундный чеклист
```bash
uptime                  # LA
dmesg -T | tail         # OOM, ошибки диска, сети
vmstat 1 5              # r, b, si/so, us/sy/id/wa/st
mpstat -P ALL 1 3       # перекос по ядрам
pidstat 1 3             # CPU по процессам
iostat -xz 1 3          # диски
free -h                 # память
sar -n DEV 1 3          # сеть
sar -n TCP,ETCP 1 3     # TCP ретрансмиты
top / htop              # общая картина
```

Поля CPU в `top`: **us** (user), **sy** (kernel), **ni** (nice), **id** (idle), **wa** (ждёт I/O), **hi/si** (прерывания), **st** (steal — гипервизор отдал CPU другим ВМ; признак перегруженного хоста в облаке).

### Глубже
```bash
perf top                       # горячие функции по всей системе
perf record -g -p PID; perf report
strace -p PID -f -tt -T        # что процесс делает прямо сейчас
ltrace -p PID                  # вызовы библиотек
cat /proc/PID/stack            # где висит процесс в ядре (D-state)
bpftrace / bcc-tools: execsnoop, opensnoop, biolatency, tcpconnect
```

## Namespaces и cgroups

Это два кирпича, из которых сделаны **все** контейнеры (Docker, containerd, Kubernetes).

### Namespaces — изоляция «что процесс видит»
| Namespace | Изолирует |
|---|---|
| `pid` | дерево процессов (в контейнере свой PID 1) |
| `net` | сетевые интерфейсы, маршруты, iptables, порты |
| `mnt` | точки монтирования |
| `uts` | hostname |
| `ipc` | System V IPC, POSIX очереди |
| `user` | UID/GID (root в контейнере ≠ root на хосте) |
| `cgroup` | вид иерархии cgroups |
| `time` | смещение часов |

```bash
lsns                                  # все namespaces
unshare --pid --fork --mount-proc bash   # bash в новом PID ns: ps покажет PID 1
nsenter -t <PID> -n ip addr           # зайти в сетевой ns процесса (контейнера)
ip netns add test; ip netns exec test ip a
```

### cgroups — ограничение «сколько процесс может потребить»
cgroups (v2 — единая иерархия в `/sys/fs/cgroup`) ограничивают и учитывают CPU, память, I/O, количество PID.

```bash
cat /sys/fs/cgroup/system.slice/nginx.service/memory.max
cat /sys/fs/cgroup/system.slice/nginx.service/cpu.stat
systemd-cgtop                         # top по cgroups
systemd-run --scope -p MemoryMax=200M -p CPUQuota=50% ./heavy.sh
```

- `cpu.max` = `quota period` (например `50000 100000` = 0.5 CPU) → это и есть CPU limits в Kubernetes, при превышении — **throttling**.
- `memory.max` → при превышении — OOM kill внутри cgroup.
- `pids.max` → защита от fork-бомбы.

> [!interview] Контейнер — это виртуальная машина?
> Нет. Контейнер — обычный процесс хоста, изолированный namespaces и ограниченный cgroups, с отдельной корневой ФС (overlayfs). Ядро — общее с хостом. ВМ имеет своё ядро и виртуализированное железо (гипервизор).

## Ядро: sysctl, модули, лимиты

### sysctl
```bash
sysctl -a | grep somaxconn
sysctl -w net.ipv4.ip_forward=1        # до перезагрузки
echo "net.ipv4.ip_forward=1" > /etc/sysctl.d/99-forward.conf
sysctl --system                        # применить все файлы
```

Часто тюнингуемые параметры:

| Параметр | Зачем |
|---|---|
| `net.ipv4.ip_forward` | маршрутизация (нужно для Docker/K8s) |
| `net.core.somaxconn` | размер очереди принятых соединений (backlog listen) |
| `net.ipv4.tcp_max_syn_backlog` | очередь полуоткрытых соединений |
| `net.ipv4.ip_local_port_range` | диапазон эфемерных портов для исходящих |
| `net.ipv4.tcp_tw_reuse` | переиспользовать TIME_WAIT для исходящих |
| `fs.file-max`, `fs.nr_open` | системный лимит дескрипторов |
| `fs.inotify.max_user_watches` | для IDE, filebeat, kubelet |
| `vm.swappiness` | склонность к swap |
| `vm.max_map_count` | нужен Elasticsearch (262144) |
| `kernel.pid_max` | максимальный PID |

### ulimit и лимиты дескрипторов
```bash
ulimit -n                       # soft лимит открытых файлов текущего shell
ulimit -Hn                      # hard лимит
cat /proc/<PID>/limits          # реальные лимиты процесса
```
- Для логин-сессий — `/etc/security/limits.conf` (через PAM).
- Для **systemd-сервисов** limits.conf **не работает** — нужно `LimitNOFILE=` в unit-файле.
- В Docker — `--ulimit nofile=65536:65536`.

### Модули ядра
```bash
lsmod; modinfo overlay
modprobe br_netfilter            # загрузить (нужно для K8s)
echo br_netfilter > /etc/modules-load.d/k8s.conf
uname -r                         # версия ядра
```

## Логи и logrotate

- **journald** — бинарный журнал systemd (`journalctl`).
- **rsyslog** — классический syslog в `/var/log/syslog` (Debian) или `/var/log/messages` (RHEL), умеет пересылать логи на удалённый сервер.
- Важные файлы: `/var/log/auth.log` или `/var/log/secure` (входы, sudo), `/var/log/kern.log`, `/var/log/dpkg.log`, `/var/log/apt/`, `/var/log/nginx/`.

```bash
tail -F /var/log/nginx/error.log         # -F переживает ротацию
grep -i "failed password" /var/log/auth.log | awk '{print $(NF-3)}' | sort | uniq -c | sort -rn | head
last; lastb; who; w                      # кто входил
```

### logrotate
```conf /etc/logrotate.d/myapp
/var/log/myapp/*.log {
    daily
    rotate 14
    compress
    delaycompress
    missingok
    notifempty
    create 0640 myapp myapp
    sharedscripts
    postrotate
        systemctl kill -s HUP myapp.service >/dev/null 2>&1 || true
    endscript
}
```
- `copytruncate` — если приложение не умеет переоткрывать файл по сигналу (риск потерять строки в момент копирования).
- Проверить: `logrotate -d /etc/logrotate.d/myapp` (dry-run), `logrotate -f` — принудительно.

## SSH

```bash
ssh-keygen -t ed25519 -C "me@laptop"
ssh-copy-id -i ~/.ssh/id_ed25519.pub user@host
ssh -v user@host               # отладка подключения (-vvv подробнее)
ssh -J bastion user@internal   # через jump-host
scp -r dir user@host:/tmp/; rsync -avzP dir/ user@host:/srv/dir/
```

```conf ~/.ssh/config
Host bastion
    HostName 203.0.113.10
    User ops
    IdentityFile ~/.ssh/id_ed25519

Host 10.0.*
    ProxyJump bastion
    User ubuntu
    ServerAliveInterval 30
```

### Туннели
```bash
ssh -L 5432:db.internal:5432 bastion    # локальный: localhost:5432 → db через bastion
ssh -R 8080:localhost:3000 server       # удалённый: server:8080 → мой localhost:3000
ssh -D 1080 server                      # SOCKS-прокси
ssh -N -f -L ...                        # без shell, в фоне
```

### Hardening sshd
```conf /etc/ssh/sshd_config.d/hardening.conf
PermitRootLogin no
PasswordAuthentication no
PubkeyAuthentication yes
MaxAuthTries 3
AllowGroups ssh-users
ClientAliveInterval 300
```
`sshd -t` — проверка конфига **перед** `systemctl reload sshd`. Не закрывайте текущую сессию, пока не проверили вход в новой.

Права: `~/.ssh` — 700, `authorized_keys` — 600, домашний каталог не должен быть writable для группы/всех — иначе sshd проигнорирует ключ (`StrictModes`).

## Планировщики: cron и systemd timers

```bash
crontab -e            # crontab текущего пользователя
crontab -l
ls /etc/cron.d /etc/cron.daily
```

```text crontab
# ┌ минута (0-59)
# │ ┌ час (0-23)
# │ │ ┌ день месяца (1-31)
# │ │ │ ┌ месяц (1-12)
# │ │ │ │ ┌ день недели (0-7, 0 и 7 = вс)
# │ │ │ │ │
  */5 * * * * /opt/scripts/healthcheck.sh >> /var/log/hc.log 2>&1
  0 3 * * 1-5 root /opt/backup.sh          # формат /etc/cron.d с полем пользователя
  @reboot /opt/start.sh
```

> [!warn] Почему скрипт работает руками, а в cron — нет
> У cron минимальное окружение: короткий `PATH` (`/usr/bin:/bin`), нет переменных из `.bashrc`, другой рабочий каталог, `sh` вместо `bash`. Используйте абсолютные пути, задайте `PATH=` в crontab, перенаправляйте вывод в лог. Символ `%` в crontab — перевод строки, его нужно экранировать `\%`.

### systemd timer
```ini /etc/systemd/system/backup.timer
[Unit]
Description=Nightly backup

[Timer]
OnCalendar=*-*-* 03:00:00
Persistent=true            # выполнить пропущенный запуск после простоя
RandomizedDelaySec=10m

[Install]
WantedBy=timers.target
```
Плюс `backup.service` с `Type=oneshot`. Преимущества перед cron: логи в journald, зависимости, лимиты ресурсов, `Persistent`. `systemctl list-timers`.

## Пакетные менеджеры

| Задача | Debian/Ubuntu | RHEL/Rocky/Alma/Fedora |
|---|---|---|
| Обновить индекс | `apt update` | `dnf makecache` |
| Установить | `apt install nginx` | `dnf install nginx` |
| Обновить всё | `apt upgrade` / `full-upgrade` | `dnf upgrade` |
| Найти | `apt search`, `apt-cache policy pkg` | `dnf search`, `dnf info` |
| Какой пакет владеет файлом | `dpkg -S /usr/bin/curl` | `rpm -qf /usr/bin/curl` |
| Файлы пакета | `dpkg -L curl` | `rpm -ql curl` |
| Какой пакет даст команду | `apt-file search bin/dig` | `dnf provides */dig` |
| Закрепить версию | `apt-mark hold pkg` | `dnf versionlock add pkg` |
| История | `/var/log/apt/history.log` | `dnf history` / `dnf history undo N` |

```bash
# Сломанные зависимости / прерванная установка
dpkg --configure -a
apt -f install
```

## Шпаргалка: текст и поиск

```bash
grep -rnI "timeout" /etc/nginx/            # рекурсивно, номера строк, без бинарных
grep -E "5[0-9]{2} " access.log | wc -l     # 5xx ответы
awk '{print $1}' access.log | sort | uniq -c | sort -rn | head    # топ IP
awk '$9 >= 500 {print $7}' access.log | sort | uniq -c | sort -rn | head   # URL с 5xx
sed -i 's/^#\?PermitRootLogin.*/PermitRootLogin no/' /etc/ssh/sshd_config
cut -d: -f1,7 /etc/passwd
sort -k5 -n -t, data.csv
find /var/log -name "*.log" -mtime +7 -size +100M -delete
find / -xdev -newer /tmp/marker -type f       # что изменилось после маркера
xargs -P 8 -n 1                                # параллельно
tr -d '\r' < win.txt > unix.txt
jq -r '.items[].metadata.name' pods.json
watch -n 2 'ss -s'
tee -a out.log
```

| Команда | Что делает |
|---|---|
| `lsof -i :8080` | кто слушает/использует порт |
| `lsof -p PID` | файлы и сокеты процесса |
| `fuser -vm /mnt` | кто держит точку монтирования |
| `ss -tulpn` | слушающие порты с процессами |
| `timedatectl` / `chronyc tracking` | время и синхронизация NTP |
| `hostnamectl` | имя хоста, ОС, ядро |
| `dmidecode -t system` | информация о железе |
| `lscpu`, `lspci`, `lsusb` | CPU, PCI, USB |

# @interview

## [junior] Что такое inode? Что в нём хранится, а чего нет?
Inode — структура ФС с метаданными файла: тип, права, владелец, размер, временные метки (atime/mtime/ctime), число жёстких ссылок, указатели на блоки данных. **Имени файла в inode нет** — имя хранится в каталоге (отображение имя → номер inode). Количество inode задаётся при создании ФС (ext4), поэтому они могут закончиться раньше места — `df -i`.

## [junior] Разница между hard link и symbolic link?
- **Hard link** — ещё одна запись в каталоге на тот же inode. Нельзя между ФС и на каталоги. Данные живут, пока жива хотя бы одна ссылка.
- **Symlink** — отдельный файл со своим inode, внутри которого записан путь. Работает между ФС и на каталоги; если цель удалить — ссылка «битая».

## [junior] Что означают права 755 и 644? Что такое umask?
755 = `rwxr-xr-x` (владелец всё, остальные читать и исполнять) — для каталогов и скриптов. 644 = `rw-r--r--` — для обычных файлов. **umask** — маска, которая «вычитается» из базовых прав (666 для файлов, 777 для каталогов) при создании. umask 022 → файлы 644, каталоги 755.

## [middle] Что такое SUID, SGID и sticky bit? Приведите примеры.
- **SUID** на исполняемом файле — запуск с правами владельца файла (`/usr/bin/passwd`).
- **SGID** на файле — с правами группы; на каталоге — новые файлы наследуют группу каталога.
- **Sticky** на каталоге — удалить файл может только его владелец (`/tmp`).
SUID-бинарники — частый вектор повышения привилегий, их стоит аудитить: `find / -perm -4000`.

## [junior] Как узнать, какой процесс слушает порт 80?
`ss -tulpn | grep :80`, `lsof -i :80`, `fuser 80/tcp`. Для `-p` (имя процесса) нужен root.

## [middle] Что такое Load Average и как его интерпретировать?
Среднее за 1/5/15 минут число процессов в состоянии R (на CPU или в очереди) **и D** (непрерываемое ожидание I/O). Сравнивается с количеством ядер. Высокий LA при низкой загрузке CPU указывает на I/O (диск, NFS) — проверить `vmstat` (колонка `b`, `wa`), `iostat -x`, процессы в D-state.

## [middle] Что такое zombie-процесс? Как от него избавиться?
Процесс, который завершился, но родитель ещё не прочитал его код возврата через `wait()`. Ресурсов не ест, кроме записи в таблице процессов (PID). `kill -9` на зомби бесполезен. Варианты: послать родителю SIGCHLD, исправить родителя, убить/перезапустить родителя — тогда зомби усыновит init и вычистит. Массовые зомби могут исчерпать `pid_max`. В контейнерах — классическая проблема, если PID 1 не reaper (решение — `tini`, `docker run --init`).

## [middle] Чем SIGTERM отличается от SIGKILL? Какие сигналы нельзя перехватить?
SIGTERM (15) — просьба завершиться; процесс может перехватить и корректно закрыть ресурсы. SIGKILL (9) — убийство ядром, перехватить нельзя, корректного завершения не будет. Не перехватываются SIGKILL и SIGSTOP.

## [middle] Процесс в состоянии D и не убивается kill -9. Почему и что делать?
D — uninterruptible sleep: процесс ждёт завершения I/O в ядре (часто — зависший NFS, умирающий диск, проблемы с блочным устройством). Сигналы доставятся только после выхода из syscall. Диагностика: `cat /proc/PID/stack`, `dmesg` (ошибки I/O, `task blocked for more than 120 seconds`), `iostat`. Решение — устранить причину (вернуть NFS-сервер, `umount -f -l`), в крайнем случае — перезагрузка.

## [junior] Как посмотреть свободное место и что занимает диск?
`df -h` (по ФС), `df -i` (inode), `du -sh /var/* | sort -h`, `du -xh --max-depth=1 /`, `ncdu -x /`. Если `df` и `du` расходятся — ищем удалённые, но открытые файлы: `lsof +L1`.

## [middle] df показывает, что диск заполнен, а du — что занято мало. Почему?
1) Удалённые файлы, которые держит открытыми процесс (`lsof +L1`) — место освободится после закрытия fd или рестарта процесса. 2) Данные «под» точкой монтирования: файлы писались в `/data` до того, как туда смонтировали диск (проверить через `mount --bind / /mnt/root`). 3) Зарезервированные блоки для root (5% на ext4, `tune2fs -m`). 4) Снапшоты/метаданные на CoW-ФС.

## [middle] Чем отличается buff/cache от used? Почему free показывает мало свободной памяти?
Linux использует свободную память под page cache, чтобы ускорять чтение файлов; при запросе приложения кэш вытесняется. Ориентироваться нужно на колонку **available**. Проблема — когда растёт swap-активность (`vmstat` si/so) и `available` стремится к нулю.

## [middle] Как работает OOM Killer? Как защитить важный процесс?
При нехватке памяти ядро вычисляет `oom_score` (в основном пропорционально RSS + корректировка `oom_score_adj`) и убивает процесс с максимальным баллом через SIGKILL. Следы — в `dmesg`/`journalctl -k`. Защита: `oom_score_adj=-1000` (или `OOMScoreAdjust=` в systemd), лимиты памяти через cgroups для «шумных» соседей, правильные requests/limits в K8s.

## [middle] Опишите процесс загрузки Linux.
BIOS/UEFI (POST, выбор устройства) → загрузчик GRUB (меню, загрузка ядра и initramfs, параметры ядра) → ядро (инициализация, драйверы, монтирование initramfs) → initramfs (модули для дисков, LVM/RAID/LUKS, монтирование настоящего root, switch_root) → systemd PID 1 (юниты до default.target) → getty/sshd/логин.

## [middle] Что такое initramfs и зачем он нужен?
Временная корневая ФС в памяти, которую загрузчик передаёт ядру. Содержит минимальный набор утилит и модулей, нужных, чтобы найти и смонтировать настоящий корень (драйверы контроллеров, LVM, mdraid, расшифровка LUKS, сетевой root). Пересобирается `update-initramfs -u` / `dracut -f`.

## [junior] Как создать свой systemd-сервис с автоперезапуском?
Unit-файл в `/etc/systemd/system/app.service` с секциями `[Unit]` (Description, After), `[Service]` (ExecStart, User, Restart=on-failure, RestartSec), `[Install]` (WantedBy=multi-user.target). Затем `systemctl daemon-reload && systemctl enable --now app`. Логи — `journalctl -u app -f`.

## [middle] Разница между Requires/Wants и After в systemd?
`Requires`/`Wants` задают **зависимость** (что ещё нужно запустить; Requires — если зависимость упала, юнит тоже остановится; Wants — мягко). `After`/`Before` задают **порядок** запуска. Они независимы: `Wants=network-online.target` без `After=` не гарантирует, что сеть поднимется раньше.

## [senior] Что такое namespaces и cgroups? Как из них получается контейнер?
Namespaces изолируют то, что видит процесс (pid, net, mnt, uts, ipc, user, cgroup, time). cgroups ограничивают и учитывают ресурсы (CPU, память, I/O, pids). Контейнер = процесс, запущенный через `clone()` с новыми namespaces, помещённый в cgroup с лимитами, с корневой ФС из слоёв образа (overlayfs + `pivot_root`), с урезанными capabilities и seccomp-профилем. Ядро — общее с хостом.

## [middle] Что такое capabilities?
Разбиение привилегий root на отдельные права: `CAP_NET_BIND_SERVICE` (порты < 1024), `CAP_NET_ADMIN` (сеть), `CAP_SYS_ADMIN` (почти всё), `CAP_CHOWN` и т.д. Позволяют давать процессу минимум прав вместо полного root: `setcap`, `AmbientCapabilities=` в systemd, `cap_add/cap_drop` в Docker/K8s.

## [junior] Как добавить пользователя в группу, и почему права не применились?
`usermod -aG docker user` (без `-a` все остальные группы будут заменены). Членство в группах вычисляется при логине, поэтому нужно перелогиниться или `newgrp docker`. Для сервисов — перезапуск сервиса.

## [middle] Скрипт работает вручную, но не работает из cron. Причины?
Другое окружение: урезанный PATH, нет переменных из профиля, другой shell (`/bin/sh`), другой рабочий каталог, другой пользователь, нет TTY. Символ `%` в crontab — спецсимвол. Решение: абсолютные пути, `PATH=` в crontab, `cd` в скрипте, перенаправление stdout/stderr в лог, проверить `grep CRON /var/log/syslog` или `journalctl -u cron`.

## [middle] Как увеличить лимит открытых файлов для сервиса?
Для systemd-сервиса — `LimitNOFILE=65536` в unit (через `systemctl edit`), затем `daemon-reload` и рестарт. Для интерактивных сессий — `/etc/security/limits.conf`. Системный потолок — `fs.file-max`/`fs.nr_open`. Проверка — `cat /proc/PID/limits`.

## [middle] Что такое swap и swappiness? Нужен ли swap на серверах?
Swap — область на диске для выгрузки редко используемых анонимных страниц памяти. `vm.swappiness` определяет, насколько охотно ядро свопит, а не сбрасывает page cache. На серверах небольшой swap даёт «подушку» перед OOM, но активный swapping убивает латентность. Kubernetes исторически требовал отключать swap (с 1.28 есть бета-поддержка).

## [junior] Как посмотреть логи сервиса за последний час?
`journalctl -u nginx --since "1 hour ago"`, с фильтром уровня `-p err`, в реальном времени `-f`. Для логов в файлах — `tail -F`, `less +F`, `grep`.

## [middle] Что такое LVM и как расширить логический том на лету?
LVM — слой абстракции над дисками: PV → VG → LV. Позволяет объединять диски, расширять тома без остановки, делать снапшоты. Расширение: добавить PV (`pvcreate`, `vgextend`), затем `lvextend -r -L +20G /dev/vg/lv` (`-r` расширит и ФС). XFS можно только увеличивать.

## [senior] Что такое page cache, dirty pages и как это влияет на запись?
Запись по умолчанию попадает в page cache (dirty pages) и сбрасывается на диск фоново потоками writeback (`vm.dirty_background_ratio`, `vm.dirty_ratio`, `dirty_expire_centisecs`). Это ускоряет запись, но при сбое питания данные без `fsync()` теряются. При достижении `dirty_ratio` процессы блокируются на записи — отсюда «фризы» при копировании больших файлов. СУБД используют `fsync`/`O_DIRECT`.

## [senior] Как найти, что вызывает высокий system time (sy) в top?
Высокий `sy` — много времени в ядре: syscalls, прерывания, работа с памятью, сеть. Инструменты: `perf top` (горячие функции ядра), `pidstat -u 1` (у кого высокий %system), `strace -c -p PID` (какие syscalls), `vmstat` (cs — context switches, in — interrupts), `/proc/interrupts`, `mpstat` (%soft — softirq от сети).

## [middle] Что такое steal time?
Время, когда виртуальная машина готова выполняться, но гипервизор отдал физический CPU другим ВМ. Высокий `st` в top/vmstat — признак перегруженного хоста или исчерпания CPU-кредитов (AWS t-инстансы). Решение — сменить тип инстанса/хост.

## [junior] Как работает SSH-аутентификация по ключу?
Клиент генерирует пару ключей; публичный кладётся в `~/.ssh/authorized_keys` на сервере. При подключении сервер проверяет, что клиент владеет приватным ключом (клиент подписывает данные сессии, сервер проверяет подпись публичным ключом). Приватный ключ никогда не передаётся.

## [middle] Как сделать SSH-туннель к базе, доступной только из внутренней сети?
`ssh -L 5432:db.internal:5432 user@bastion` — локальный порт 5432 пробрасывается через bastion к db.internal:5432. Далее `psql -h localhost`. Обратный туннель — `-R`, динамический SOCKS — `-D`.

## [senior] Чем отличаются fork(), exec() и clone()?
`fork()` создаёт копию процесса (с copy-on-write страницами), `execve()` заменяет образ текущего процесса новой программой (PID сохраняется), `clone()` — обобщённый вызов, позволяющий выбрать, что разделять с родителем (память — потоки; флаги `CLONE_NEW*` — новые namespaces, так создаются контейнеры).

## [middle] Что такое файловый дескриптор? Что такое 2>&1?
Целое число — индекс в таблице открытых файлов процесса. 0 — stdin, 1 — stdout, 2 — stderr. `2>&1` перенаправляет stderr туда же, куда сейчас указывает stdout. Порядок важен: `cmd > out.log 2>&1` — оба в файл; `cmd 2>&1 > out.log` — stderr в терминал, stdout в файл.

## [middle] Как узнать, какой процесс пишет на диск сильнее всех?
`iotop -o`, `pidstat -d 1`, `iostat -x 1` (какое устройство), `/proc/PID/io`, `biotop` (bcc). Для файлов — `lsof -p PID`, `fatrace`, `inotifywait`.

## [senior] Как ядро решает, какой процесс запускать? Что такое CFS/EEVDF?
Планировщик ядра (CFS до 6.6, затем EEVDF) распределяет время CPU пропорционально весам (nice), стремясь к справедливости и малой латентности. Есть real-time классы (SCHED_FIFO, SCHED_RR) с приоритетом над обычными. cgroup `cpu.weight` и `cpu.max` поверх этого ограничивают группы процессов — так работают CPU requests/limits контейнеров.

## [junior] Что делает команда chmod -R 777 и почему это плохо?
Даёт всем пользователям полный доступ ко всему дереву: любой может изменить или подменить файлы, в т.ч. исполняемые; SSH откажется работать с такими ключами; веб-сервер может начать отдавать/исполнять чужие файлы. Правильно — минимальные права и правильный владелец.

## [middle] Как перечитать конфиг сервиса без перезапуска?
`systemctl reload service` (выполняет `ExecReload`, часто — посылает SIGHUP). nginx: `nginx -t && nginx -s reload`. Не все сервисы поддерживают reload — смотреть документацию.

## [senior] Чем отличаются cgroups v1 и v2?
v1 — отдельные иерархии на каждый контроллер (cpu, memory, blkio...), процесс мог быть в разных местах разных деревьев; сложная и противоречивая семантика. v2 — единая иерархия, единый интерфейс файлов (`cpu.max`, `memory.max`, `io.max`), корректный учёт buffered writeback I/O, PSI (pressure stall information: `/proc/pressure/*`), делегирование непривилегированным. Современные systemd, Docker, K8s ≥1.25 используют v2.

## [senior] Что такое PSI (Pressure Stall Information)?
Метрики ядра в `/proc/pressure/{cpu,memory,io}` (и в каждой cgroup v2): доля времени, когда задачи стояли из-за нехватки ресурса (`some` — хотя бы одна задача, `full` — все). Лучше LA показывают реальное «голодание». Используются systemd-oomd и kubelet.

# @troubleshooting

## [high] Сервис не стартует после изменения конфига
**Симптомы:** `systemctl start myapp` → `Job for myapp.service failed`.

**Диагностика:**
```bash
systemctl status myapp -l --no-pager    # последние строки лога и код выхода
journalctl -u myapp -b --no-pager | tail -50
systemctl cat myapp                      # итоговый unit + drop-ins
# Запустить ExecStart руками от того же пользователя:
sudo -u myapp /opt/myapp/bin/api --port 8080
```
**Частые причины:** синтаксис конфига приложения; порт занят (`ss -tlpn`); нет прав на файлы/каталоги (`namei -l`); не сделали `daemon-reload` после правки unit; `status=203/EXEC` — неверный путь или нет `+x`/шебанга; `status=217/USER` — пользователь не существует; сервис упирается в `StartLimitBurst` (`systemctl reset-failed myapp`).

## [medium] Изменения в unit-файле не применяются
**Симптомы:** поправили `/etc/systemd/system/x.service`, перезапустили — поведение старое. В статусе: `Warning: The unit file changed on disk`.

**Решение:** `systemctl daemon-reload` и рестарт. Проверить, не перекрывает ли drop-in в `x.service.d/` ваши настройки: `systemctl cat x`. Пустое `ExecStart=` в override нужно, чтобы сбросить исходную команду перед новой.

## [medium] Новые группы пользователя «не работают»
**Симптомы:** `usermod -aG docker user`, но `docker ps` → `permission denied ... docker.sock`.

**Причина:** группы процесса фиксируются при логине. **Решение:** перелогиниться, `newgrp docker`, или `su - user`. Проверить: `id` (текущая сессия) vs `id user` (база).

# @quiz

? Что хранится в inode?
- Имя файла и его права
+ Метаданные файла и указатели на блоки, но не имя
- Только содержимое маленьких файлов
- Путь к файлу от корня
> Имя хранится в записи каталога, которая указывает на номер inode.

? Load Average учитывает процессы в каких состояниях?
- Только R
+ R и D
- R, S и D
- Только D
> LA — среднее число runnable (R) и uninterruptible sleep (D) процессов, поэтому растёт и при I/O-проблемах.

? Какой сигнал отправляет `kill PID` по умолчанию?
- SIGKILL
- SIGHUP
+ SIGTERM
- SIGINT
> По умолчанию kill посылает SIGTERM (15), который процесс может обработать.

? Удалили 10 ГБ лог, но df не изменился. Наиболее вероятная причина?
- Нужно выполнить sync
+ Файл всё ещё открыт процессом
- ФС не поддерживает удаление больших файлов
- Кончились inode
> Данные освобождаются, только когда счётчик ссылок 0 и файл никто не держит открытым. Проверка: `lsof +L1`.

? На какую колонку `free -h` смотреть, чтобы понять, сколько памяти реально доступно приложениям?
- free
- used
- buff/cache
+ available
> available учитывает, что page cache можно освободить.

? Что делает sticky bit на каталоге?
- Файлы наследуют группу каталога
+ Удалять файл может только его владелец (и root)
- Файлы в каталоге запускаются от владельца каталога
- Запрещает изменять каталог
> Классический пример — `/tmp`.

? Где задать лимит открытых файлов для systemd-сервиса?
- /etc/security/limits.conf
+ LimitNOFILE= в unit-файле
- ulimit -n в /etc/profile
- sysctl fs.file-max
> limits.conf применяется через PAM к сессиям, а systemd-сервисы не проходят PAM.

? Какой namespace отвечает за изоляцию сетевых интерфейсов и маршрутов?
- uts
- ipc
+ net
- mnt
> net namespace даёт свой набор интерфейсов, маршрутов, правил iptables и портов.

? Процесс в состоянии Z — это:
- Процесс, ожидающий диска
+ Завершившийся процесс, код возврата которого не прочитал родитель
- Остановленный процесс
- Процесс без родителя
> Зомби исчезнет, когда родитель вызовет wait() или сам завершится.

? Чем `systemctl mask` отличается от `disable`?
- Ничем
+ mask запрещает запуск юнита даже вручную и как зависимости
- mask удаляет пакет
- disable останавливает сервис немедленно
> mask создаёт симлинк unit → /dev/null.

? Что покажет высокий `wa` в top?
- Процессор занят ядром
+ CPU простаивает в ожидании I/O
- Гипервизор забирает время CPU
- Много прерываний
> iowait — время простоя при наличии незавершённого дискового I/O.

? Какая команда расширит LV и файловую систему за один шаг?
- lvresize --fs
+ lvextend -r -L +10G /dev/vg/lv
- resize2fs -L +10G
- vgextend -r
> Флаг `-r` (`--resizefs`) вызывает fsadm для расширения ФС.

? Что делает `2>&1` в `cmd > out.log 2>&1`?
- Отправляет stdout в stderr
+ Перенаправляет stderr туда же, куда stdout (в файл)
- Создаёт два файла
- Подавляет ошибки
> Дескриптор 2 становится копией дескриптора 1.

? Какой шаг загрузки отвечает за монтирование root, лежащего на LVM поверх LUKS?
- GRUB
- BIOS
+ initramfs
- systemd-logind
> В initramfs есть модули и утилиты для LVM/LUKS, он монтирует корень и делает switch_root.

? Что означает высокий steal time (st)?
- Процесс крадёт память у других
+ Гипервизор отдаёт физический CPU другим ВМ
- Ядро тратит время на прерывания
- Включён swap
> Признак перегруженного хоста виртуализации или исчерпанных CPU-кредитов.
