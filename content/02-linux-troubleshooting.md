---
id: linux-troubleshooting
title: "Linux: траблшутинг"
icon: 🚑
order: 20
group: Фундамент
color: #f85149
summary: Методика расследования, режимы восстановления, починка загрузки, ФС, паролей, сети и десятки реальных поломок с пошаговым разбором.
---

# @theory

## Методика: как расследовать любую проблему

На собеседовании за вопрос «сервер тормозит, что будете делать?» оценивают **не знание команд, а системность**. Отвечайте по алгоритму.

### Алгоритм
1. **Уточнить симптом.** Что конкретно не работает? У всех или у части пользователей? С какого времени? Что менялось (деплой, обновление, конфиг, нагрузка)? Есть ли алерты?
2. **Оценить масштаб и влияние.** Один сервер или все? Production? Нужно ли сначала **восстановить сервис** (откат, переключение, рестарт), а потом искать причину?
3. **Снизу вверх или сверху вниз.** Железо/ресурсы → ОС → сеть → сервис → приложение. Или от пользователя: DNS → сеть → балансировщик → приложение → БД.
4. **Собрать факты, а не гадать.** Логи, метрики, `dmesg`. Сравнить с нормой (графики «до»).
5. **Сформулировать гипотезу → проверить → исключить.** Меняйте одну вещь за раз.
6. **Исправить и проверить**, что симптом ушёл.
7. **Зафиксировать**: postmortem, алерт на эту ситуацию, автоматизация, runbook.

> [!interview] Сильная фраза на собесе
> «Сначала я бы стабилизировал сервис — откатил последний релиз или вывел ноду из балансировки, — а потом, сохранив артефакты (логи, дампы), разбирался с первопричиной».

### Первые 60 секунд на сервере
```bash
uptime                          # LA и аптайм: не ребутался ли недавно
w                               # кто ещё на сервере
dmesg -T | tail -30             # OOM, I/O errors, сеть, segfault
journalctl -p err -b --no-pager | tail -30
systemctl list-units --failed
df -h; df -i                    # место и inode
free -h
vmstat 1 5                      # r, b, swap, wa, st
top -o %CPU   (или htop)
iostat -xz 1 3
ss -s; ss -tulpn
last -x | head                  # перезагрузки и выключения
```

### Карта «симптом → куда смотреть»

| Симптом | Первым делом |
|---|---|
| Всё тормозит | `uptime`, `vmstat 1`, `top`, `iostat -x` |
| Высокий LA, CPU свободен | процессы в D-state, `iostat`, NFS, `dmesg` |
| Процесс внезапно умирает | `dmesg` (OOM, segfault), `journalctl -u`, coredump |
| `No space left on device` | `df -h`, `df -i`, `lsof +L1` |
| `Read-only file system` | `dmesg` (ошибки диска), `mount`, fsck |
| `Permission denied` | права на путь (`namei -l`), владелец, SELinux, `noexec` |
| `Too many open files` | `/proc/PID/limits`, `ls /proc/PID/fd \| wc -l` |
| `Connection refused` | слушает ли порт (`ss -tlpn`), на каком адресе |
| `Connection timed out` | файрвол, маршрут, Security Group |
| Не резолвится имя | `/etc/resolv.conf`, `resolvectl`, `dig` |
| Не загружается | консоль, GRUB, emergency mode, fstab |

## Инструменты диагностики

### strace — что процесс делает
```bash
strace -p PID -f -tt -T -s 200        # подключиться к живому процессу
strace -f -e trace=file ./app         # какие файлы пытается открыть (ENOENT/EACCES!)
strace -f -e trace=network curl x.io
strace -c -p PID                      # статистика syscalls (Ctrl+C)
```
Классика: приложение «молча» падает → `strace` показывает `open("/etc/app/config.yml") = -1 ENOENT`.

### lsof и /proc
```bash
lsof -p PID                    # всё, что открыто процессом
lsof -i :5432                  # кто на порту
lsof +D /var/log               # кто держит файлы в каталоге
lsof +L1                       # удалённые, но открытые
ls -l /proc/PID/cwd /proc/PID/exe
cat /proc/PID/environ | tr '\0' '\n'
cat /proc/PID/cmdline | tr '\0' ' '
cat /proc/PID/status | grep -E "State|VmRSS|Threads"
cat /proc/PID/stack            # стек ядра (почему висит в D)
```

### Coredump и падения
```bash
coredumpctl list
coredumpctl info PID
coredumpctl gdb PID
journalctl -k | grep -i segfault
```

### Сеть
```bash
ss -tanp state established '( dport = :5432 )'
tcpdump -ni any port 443 -c 50
curl -v --connect-timeout 3 https://api.local/health
nc -zv host 5432
mtr -rwc 50 8.8.8.8
```

## Режимы восстановления и консоль

Когда SSH недоступен, нужен **out-of-band доступ**: консоль гипервизора (VNC/Serial Console в AWS/GCP/Hetzner), IPMI/iDRAC/iLO на железе, KVM.

### Rescue и Emergency targets
- **rescue.target** (single-user) — смонтированы все ФС, минимум сервисов, root shell.
- **emergency.target** — смонтирован только `/` (часто read-only), почти ничего не запущено. Сюда система попадает сама, если не смогла смонтировать что-то из fstab.

### Как попасть: параметры ядра в GRUB
1. При загрузке в меню GRUB нажать `e` на нужной записи.
2. В строке, начинающейся с `linux`, дописать в конец параметр:
   - `systemd.unit=rescue.target` — rescue
   - `systemd.unit=emergency.target` — emergency
   - `init=/bin/bash` — вообще без systemd, сразу shell (для сброса пароля)
   - `rd.break` (RHEL) — остановиться в initramfs до switch_root
3. `Ctrl+X` или `F10` — загрузиться.

> [!tip] Меню GRUB не показывается
> Удерживайте `Shift` (BIOS) или жмите `Esc` (UEFI) сразу после POST. На ВМ — консоль облака должна быть открыта до загрузки. В `/etc/default/grub` полезно поставить `GRUB_TIMEOUT=5` и `GRUB_TIMEOUT_STYLE=menu`.

### Загрузка с LiveCD/rescue-образа и chroot
Когда сломан сам загрузчик или ядро — грузимся с внешнего образа (в облаках — «rescue mode» или подключить диск к другой ВМ).
```bash
lsblk -f                                  # найти разделы
mount /dev/sda2 /mnt                      # root
mount /dev/sda1 /mnt/boot/efi             # ESP (если UEFI)
# если LVM: vgchange -ay; mount /dev/vg/root /mnt
for d in dev proc sys run; do mount --rbind /$d /mnt/$d; done
chroot /mnt /bin/bash
# теперь вы «внутри» сломанной системы: можно чинить
```
После ремонта: `exit`, `umount -R /mnt`, `reboot`.

## Сброс пароля root

### Способ 1: init=/bin/bash (любой дистрибутив)
```bash
# В GRUB: e → в конце строки linux добавить:  init=/bin/bash  → Ctrl+X
mount -o remount,rw /
passwd root
# Если включён SELinux (RHEL/CentOS/Rocky) — иначе вход сломается:
touch /.autorelabel
sync
exec /sbin/init       # или: reboot -f
```

### Способ 2: rd.break (RHEL-семейство)
```bash
# В GRUB: в конец строки linux добавить:  rd.break   → Ctrl+X
mount -o remount,rw /sysroot
chroot /sysroot
passwd root
touch /.autorelabel
exit; exit
```

### Способ 3: облако
- Подключить диск к другой ВМ, `chroot`, `passwd`, или прописать ключ в `/root/.ssh/authorized_keys`.
- Использовать штатные механизмы: AWS SSM Session Manager, EC2 Serial Console, `gcloud compute reset-windows-password` / metadata `ssh-keys`, cloud-init `user-data`.

> [!warn]
> Это же означает: **физический доступ = root**. Защита — пароль на GRUB (`grub-mkpasswd-pbkdf2`), шифрование диска (LUKS), Secure Boot.

## Починка загрузки: GRUB и ядро

### Приглашение `grub rescue>`
GRUB не нашёл свои модули/конфиг (сменился UUID, удалили раздел, переразметили диск).
```bash
grub rescue> ls                       # список разделов: (hd0) (hd0,gpt1) (hd0,gpt2)
grub rescue> ls (hd0,gpt2)/boot/grub  # ищем раздел, где лежит grub
grub rescue> set prefix=(hd0,gpt2)/boot/grub
grub rescue> set root=(hd0,gpt2)
grub rescue> insmod normal
grub rescue> normal
```
После загрузки — переустановить загрузчик навсегда:
```bash
grub-install /dev/sda && update-grub                 # Debian/Ubuntu, BIOS
grub-install --target=x86_64-efi --efi-directory=/boot/efi --bootloader-id=ubuntu && update-grub   # UEFI
grub2-mkconfig -o /boot/grub2/grub.cfg               # RHEL (BIOS)
```

### Kernel panic: VFS: Unable to mount root fs
Ядро не может смонтировать root. Причины: неверный `root=` в параметрах (сменился UUID), в initramfs нет драйвера (сменили контроллер дисков, новая ВМ — virtio), битый/отсутствующий initramfs после неудачного обновления.
1. В меню GRUB выбрать **Advanced options → предыдущее ядро**.
2. Загрузившись, пересобрать initramfs для проблемного ядра: `update-initramfs -u -k <версия>` или `dracut -f /boot/initramfs-<ver>.img <ver>`.
3. Проверить `cat /etc/fstab`, `blkid` и `root=` в `/boot/grub/grub.cfg`.
4. Установить ядро по умолчанию: `grub-set-default` / `grubby --set-default`.

> [!tip] Профилактика
> Держите минимум два ядра установленными (`installonly_limit` в dnf), не удаляйте старое, пока новое не проверено, и следите, чтобы `/boot` не переполнялся (из-за этого initramfs записывается обрезанным).

## Файловые системы: fsck и read-only

### Почему ФС стала read-only
Ядро перемонтирует ext4 в `ro`, если обнаружило ошибку (опция `errors=remount-ro`) — чтобы не испортить данные сильнее. Почти всегда это либо **ошибки диска**, либо проблемы с хранилищем (SAN/облачный том отвалился), либо реальная порча ФС.
```bash
dmesg -T | grep -iE "ext4|xfs|I/O error|blk_update_request|remount"
mount | grep " / "
smartctl -a /dev/sda | grep -iE "reallocated|pending|uncorrect|health"
```

### Проверка и ремонт
fsck запускается **только на размонтированной** ФС (или смонтированной ro в emergency).
```bash
umount /data
fsck -f /dev/sdb1                  # ext*: e2fsck, -y — отвечать «да» на всё
xfs_repair /dev/sdb1               # XFS (если не монтируется: сначала xfs_repair -n для проверки)
xfs_repair -L /dev/sdb1            # крайний случай: обнулить журнал (возможна потеря данных)
# Для корня: загрузиться в rescue/LiveCD, или:
touch /forcefsck                   # старые системы
# systemd: параметр ядра fsck.mode=force fsck.repair=yes
tune2fs -l /dev/sda1 | grep -iE "state|mount count|last checked"
```

> [!danger]
> Никогда не запускайте fsck на смонтированной rw файловой системе — гарантированно испортите данные. Если диск умирает (SMART pending/reallocated sectors растут) — **сначала снимите образ/бэкап** (`ddrescue`), потом чините.

### Emergency mode из-за fstab
Сообщение: `You are in emergency mode... Give root password for maintenance`. В журнале — `Dependency failed for /data` или `Timed out waiting for device`.
```bash
# Ввести пароль root (или загрузиться с init=/bin/bash)
mount -o remount,rw /
journalctl -xb | grep -iE "failed|timed out" | head
vi /etc/fstab              # закомментировать/исправить строку, добавить nofail
systemctl daemon-reload
mount -a                   # проверить: должно пройти без ошибок
reboot
```

## Сеть, когда всё сломалось

### Проверка «снизу вверх»
```bash
ip -br link                 # интерфейс UP? есть ли carrier
ip -br addr                 # есть ли IP
ip route                    # есть ли default gateway
ping -c3 <gateway>          # L2/L3 до шлюза
ping -c3 8.8.8.8            # интернет по IP
ping -c3 google.com         # DNS
curl -I https://google.com  # HTTP/TLS
```

### Временно поднять сеть руками
```bash
ip link set eth0 up
ip addr add 10.0.0.15/24 dev eth0
ip route add default via 10.0.0.1
echo "nameserver 1.1.1.1" > /etc/resolv.conf
```

### Где постоянные настройки
| Система | Конфиг | Применить |
|---|---|---|
| Ubuntu 18+ | `/etc/netplan/*.yaml` | `netplan try` (откатится через 120 с, если связь пропала) / `netplan apply` |
| Debian | `/etc/network/interfaces` | `ifdown eth0 && ifup eth0` |
| RHEL 8+/Fedora | NetworkManager: `nmcli`, `/etc/NetworkManager/system-connections/` | `nmcli con reload; nmcli con up eth0` |
| systemd-networkd | `/etc/systemd/network/*.network` | `networkctl reload` |

> [!tip] Удалённая правка сети/файрвола без риска потерять доступ
> Запланируйте откат до изменения: `echo "cp /root/interfaces.bak /etc/network/interfaces && reboot" | at now + 5 min` или `sleep 300 && iptables-restore < /root/rules.bak &`. Если всё хорошо — отмените (`atrm`, `kill`). Для netplan есть `netplan try`.

### Файрвол
```bash
iptables -L -n -v --line-numbers; iptables -t nat -L -n -v
nft list ruleset
ufw status verbose
firewall-cmd --list-all
```

## Безопасность: признаки взлома

```bash
last -a | head; lastb | head           # входы и неудачные попытки
grep -E "Accepted|Failed" /var/log/auth.log | tail
cat /etc/passwd | awk -F: '$3==0'      # лишние пользователи с UID 0
ls -la /root/.ssh /home/*/.ssh         # подозрительные authorized_keys
crontab -l; ls -la /etc/cron.* /var/spool/cron/
systemctl list-units --type=service --state=running
ss -tanp | grep ESTAB                  # исходящие соединения к странным IP (майнинг-пулы)
ps auxf --sort=-%cpu | head            # неизвестный процесс жрёт 100% CPU
ls -la /tmp /var/tmp /dev/shm          # бинарники в tmp
find / -xdev -mtime -2 -type f -perm -u+x 2>/dev/null | grep -v proc
rpm -Va / debsums -s                   # изменённые системные файлы
```
> [!danger] Если подтвердился взлом
> Не «чистите» живую систему: изолируйте (сеть/SG), снимите снапшот диска и памяти для расследования, ротируйте все секреты и ключи, которые были на машине, пересоздайте сервер из чистого образа.

# @interview

## [middle] Сервер «тормозит». Ваши действия?
Сначала уточнить: что именно тормозит, с какого момента, что менялось. Затем по USE: `uptime` (LA), `dmesg -T | tail` (OOM, ошибки диска), `vmstat 1` (очередь r, блокированные b, swap si/so, us/sy/wa/st), `top`/`pidstat` (кто ест CPU), `free -h` (available, swap), `iostat -xz 1` (%util, await), `df -h`/`df -i`, `ss -s` (соединения). Найдя узкое место — смотреть конкретный процесс (`strace`, `perf`, логи приложения). Параллельно — графики мониторинга «до/после» и последние деплои.

## [middle] Как сбросить забытый пароль root?
Перезагрузиться, в GRUB нажать `e`, в строку `linux` добавить `init=/bin/bash` (или `rd.break` в RHEL), загрузиться, `mount -o remount,rw /`, `passwd root`, на SELinux-системах `touch /.autorelabel`, затем `exec /sbin/init` или `reboot -f`. В облаке — консоль/SSM/подключение диска к другой ВМ.

## [middle] Система загрузилась в emergency mode. Что делать?
Войти под root, посмотреть `journalctl -xb` — почти всегда это неудачное монтирование из `/etc/fstab` (диск отсутствует, неверный UUID, опечатка). Перемонтировать `/` в rw, исправить fstab (UUID, `nofail` для некритичных дисков), проверить `mount -a`, перезагрузиться. Если ФС повреждена — `fsck` на размонтированном разделе.

## [middle] Файловая система вдруг стала read-only. Причины и действия?
Ядро перемонтировало её из-за ошибок (опция `errors=remount-ro`): ошибки чтения/записи диска, отвалившийся сетевой том, повреждение ФС. Смотреть `dmesg`, SMART. Сохранить данные/сделать бэкап, затем размонтировать (или из rescue) и запустить `fsck`/`xfs_repair`. Если диск деградирует — менять диск, в облаке — восстанавливать из снапшота.

## [middle] Что делать, если вылезло `grub rescue>`?
GRUB не находит свой каталог. `ls` — найти раздел с `/boot/grub`, `set prefix=(hdX,Y)/boot/grub`, `set root=(hdX,Y)`, `insmod normal`, `normal`. После загрузки — `grub-install` на диск и `update-grub`. Если не получается — загрузка с LiveCD, chroot, переустановка GRUB.

## [junior] `No space left on device`, но df показывает свободное место. Почему?
Кончились inode (`df -i`) — обычно миллионы мелких файлов (сессии PHP, кэш, почтовая очередь). Найти каталог: `find / -xdev -type d -size +1M` или подсчётом `find /var -xdev | cut -d/ -f2,3 | sort | uniq -c | sort -n`. Также возможны: квоты, зарезервированные блоки для root, лимит размера в tmpfs.

## [middle] Процесс жрёт 100% CPU. Как разобраться, что он делает?
`top -H -p PID` — какой поток, `pidstat -t -p PID 1`, `strace -c -p PID` (крутится ли в syscalls), `perf top -p PID` (горячие функции), для JVM — `jstack` (перевести TID в hex), для Python — `py-spy dump`. Посмотреть логи приложения: часто это бесконечный цикл, регулярка с catastrophic backtracking, GC-шторм.

## [middle] Сервер самопроизвольно перезагрузился. Как выяснить почему?
`last -x reboot shutdown` (было ли штатное выключение), `journalctl --list-boots` и `journalctl -b -1 -e` (последние сообщения перед ребутом), `journalctl -b -1 -k` (kernel panic, OOM, MCE — ошибки железа), логи IPMI/iDRAC (SEL: перегрев, питание), события облачного провайдера (maintenance, host failure), `/var/crash` и kdump, watchdog. Отсутствие записей вообще — признак резкой потери питания или hard reset.

## [middle] Как удалённо изменить настройки сети/файрвола и не потерять доступ?
Запланировать автоматический откат до изменения (`at now + 5 min` с восстановлением бэкапа, `netplan try`, `firewall-cmd` без `--permanent` и затем `--runtime-to-permanent`), держать открытой вторую SSH-сессию, иметь out-of-band консоль. После проверки — отменить откат.

## [senior] Как бы вы расследовали утечку памяти в production?
Подтвердить рост RSS во времени (метрики, `ps -o rss`, `smem`), отделить от page cache. Проверить, не растёт ли tmpfs/shmem или slab ядра (`slabtop`). Для процесса — `pmap -x PID` (растущие anon-регионы), heap-профайлеры языка (pprof для Go, jmap/heap dump для JVM, tracemalloc для Python, valgrind/heaptrack для C). Временная мера — лимит памяти через cgroup + авто-рестарт, плановые рестарты, затем фикс в коде.

## [senior] Что такое kdump и зачем он нужен?
Механизм сбора дампа памяти ядра при kernel panic: резервируется память под второе «аварийное» ядро (`crashkernel=`), при панике через kexec загружается оно и сохраняет `/proc/vmcore` в `/var/crash`. Дамп анализируется `crash` с отладочными символами — позволяет найти баг драйвера/ядра.

## [junior] Какие логи смотреть при проблемах со входом по SSH?
На сервере: `journalctl -u ssh(d)`, `/var/log/auth.log` (Debian) или `/var/log/secure` (RHEL). На клиенте: `ssh -vvv`. Типичные причины: неверные права на `~/.ssh`/`authorized_keys`/домашний каталог, `PasswordAuthentication no`, `AllowUsers/AllowGroups`, пользователь заблокирован, `PermitRootLogin`, fail2ban, SELinux-контекст на `.ssh`.

## [middle] Как понять, что диск умирает?
`dmesg` (I/O error, `blk_update_request`, `ata ... failed command`, reset), `smartctl -a` (Reallocated_Sector_Ct, Current_Pending_Sector, Offline_Uncorrectable, CRC errors, статус PASSED/FAILED), растущий `await` в `iostat` без роста нагрузки, ФС уходит в read-only. Для NVMe — `nvme smart-log`. Действия — бэкап немедленно, замена диска, ресинк RAID.

## [middle] Как найти, какой процесс открыл слишком много файлов?
`for p in /proc/[0-9]*; do echo "$(ls $p/fd 2>/dev/null | wc -l) $(cat $p/comm)"; done | sort -rn | head`, затем `lsof -p PID` — что именно открыто (часто — утечка сокетов к БД или незакрытые файлы). Сравнить с `cat /proc/PID/limits`.

# @troubleshooting

## [critical] Диск заполнен на 100% (No space left on device)
**Симптомы:** приложения падают с `No space left on device`, не пишутся логи, БД встаёт в read-only, не работает автодополнение в bash.

**Диагностика:**
```bash
df -hT                                     # какая ФС заполнена
du -xh --max-depth=1 / 2>/dev/null | sort -h | tail -15
du -xh --max-depth=1 /var | sort -h | tail
ncdu -x /var                               # удобнее
find / -xdev -type f -size +500M -exec ls -lh {} \; 2>/dev/null
lsof +L1                                   # удалённые, но открытые файлы
```
**Типичные виновники:** `/var/log` (неротируемые логи, debug-уровень), `/var/lib/docker` (образы, остановленные контейнеры, логи контейнеров `*-json.log`), журнал systemd, core-дампы, бэкапы в локальной папке, `/tmp`.

**Решение (быстро освободить):**
```bash
journalctl --vacuum-size=200M
docker system df; docker system prune -af --volumes   # осторожно: удалит неиспользуемое
apt clean / dnf clean all
truncate -s 0 /var/log/app/huge.log      # обнулить, а не rm, если файл открыт
: > /proc/<PID>/fd/<FD>                  # обнулить удалённый файл через дескриптор
find /var/log -name "*.gz" -mtime +7 -delete
```
**Предотвращение:** logrotate, лимиты логов Docker (`log-opts max-size`), отдельный раздел под `/var`, алерт на 80/90% и на скорость заполнения (`predict_linear`).

## [high] Inode закончились при свободном месте
**Симптомы:** `No space left on device`, но `df -h` показывает 40% свободно.

**Диагностика:**
```bash
df -i                                      # IUse% = 100%
# Где больше всего файлов:
for d in /var/* /tmp /home/*; do echo "$(find "$d" -xdev 2>/dev/null | wc -l) $d"; done | sort -rn | head
```
**Причины:** PHP-сессии (`/var/lib/php/sessions`), почтовая очередь postfix, кэш приложения, миллионы мелких файлов от бага.

**Решение:** удалить мусор (`find /path -type f -mtime +1 -delete` — быстрее, чем `rm *`, который упрётся в «Argument list too long»), настроить очистку. Если нужно больше inode на ext4 — только пересоздание ФС с `mkfs.ext4 -i 4096` или переход на XFS (inode выделяются динамически).

## [high] Место не освобождается после удаления файла
**Симптомы:** удалили большой лог, `df` не изменился, `du` показывает меньше, чем `df`.

**Диагностика:**
```bash
lsof +L1 | sort -k7 -n | tail
# COMMAND  PID  USER  FD  TYPE  SIZE/OFF   NLINK NAME
# java    2231  app   5w  REG   21474836480  0   /var/log/app.log (deleted)
```
**Решение:** перезапустить процесс или попросить его переоткрыть логи (SIGHUP/USR1), либо обнулить файл через дескриптор: `: > /proc/2231/fd/5`. На будущее — удалять активные логи нельзя, только `truncate`, а ротацию делать через logrotate с `postrotate`/`copytruncate`.

## [high] Высокий Load Average при свободном CPU
**Симптомы:** LA = 40 на 8 ядрах, `top` показывает 90% idle, но всё медленно.

**Диагностика:**
```bash
vmstat 1                    # большая колонка b (blocked), wa > 20
ps -eo stat,pid,wchan:32,cmd | awk '$1 ~ /D/'     # процессы в D-state и где ждут
iostat -xz 1                # %util ~100, большой await
cat /proc/<PID>/stack
mount | grep nfs; dmesg | grep -i "nfs\|hung_task"
```
**Причины:** медленный/перегруженный диск, умирающий диск, зависший NFS/CIFS-сервер, исчерпание IOPS облачного диска (burst credits у gp2), своп-шторм.

**Решение:** найти процесс-источник I/O (`iotop -o`, `pidstat -d 1`), снизить нагрузку (`ionice -c3`), восстановить NFS или `umount -f -l`, увеличить IOPS/сменить тип диска; для NFS — опции `soft,timeo=` в зависимости от требований к данным.

## [high] Процесс съедает 100% CPU
**Диагностика:**
```bash
top -c                                    # кто, полная команда
top -H -p PID                             # какие потоки
pidstat -u -p PID 1
strace -c -f -p PID                       # если много sy — какие syscalls
perf top -p PID                           # горячие функции
# JVM: поток из top -H → в hex → искать в jstack
printf '%x\n' 12345; jstack PID | grep -A20 nid=0x3039
```
**Причины:** бесконечный цикл, regex backtracking, busy-wait, GC-шторм (JVM с маленьким heap), криптомайнер (неизвестный процесс в `/tmp`!).

**Решение:** временно — `renice`, ограничить через cgroup (`systemctl set-property app.service CPUQuota=50%`), собрать дамп/профиль, перезапустить. Постоянно — фикс в коде, проверка на компрометацию.

## [critical] OOM Killer убивает процесс
**Симптомы:** процесс внезапно исчезает, в логах приложения ничего; `Killed` в консоли; в K8s — `OOMKilled`, exit code 137.

**Диагностика:**
```bash
dmesg -T | grep -iE "out of memory|killed process|oom-kill"
journalctl -k --since today | grep -i oom
# В сообщении: какой процесс, сколько был его RSS, какой cgroup (constraint=CONSTRAINT_MEMCG — лимит контейнера/сервиса)
free -h; vmstat 1; ps aux --sort=-rss | head
```
**Решение:** понять — утечка или реальная нехватка (графики RSS во времени). Увеличить RAM/лимит, ограничить «соседей», настроить приложение (heap JVM `-Xmx` < лимита контейнера, `MaxRAMPercentage`), число воркеров. Защитить критичный процесс `OOMScoreAdjust=-900`. Добавить swap как буфер на VM. Мониторить `node_vmstat_oom_kill`.

## [high] Swap-шторм: всё дико тормозит
**Симптомы:** система почти не отвечает, SSH-логин минуты, `vmstat` si/so постоянно тысячи.

**Диагностика:** `vmstat 1` (si/so), `free -h` (available близко к 0), `smem -rs swap | head` или `for f in /proc/*/status; do awk '/VmSwap|Name/{printf $2" "}END{print ""}' $f; done | sort -k2 -n | tail`.

**Решение:** убить/перезапустить «прожорливый» процесс, уменьшить нагрузку, добавить RAM. После того как память освободилась — `swapoff -a && swapon -a`, чтобы вернуть страницы в RAM (только если хватает памяти!). Снизить `vm.swappiness`.

## [critical] Файловая система ушла в read-only
**Симптомы:** `Read-only file system` при любой записи, сервисы падают.

**Диагностика:**
```bash
dmesg -T | grep -iE "error|remount|I/O|EXT4-fs|XFS"
cat /proc/mounts | grep " ro,"
smartctl -H -A /dev/sda
```
**Решение:**
1. Не перезагружаться сразу — сохранить всё ценное, что ещё читается (rsync на другой хост).
2. Если это облачный диск — проверить статус тома в консоли провайдера.
3. Попробовать `mount -o remount,rw /` — если ошибка была транзиентной, сработает; но fsck всё равно нужен.
4. Перезагрузиться в rescue, `fsck -fy /dev/sdX` / `xfs_repair`.
5. При аппаратной проблеме — замена диска, восстановление из бэкапа.

## [critical] Система не загружается: emergency mode
**Симптомы:** в консоли `You are in emergency mode. After logging in, type "journalctl -xb"...`, или `Timed out waiting for device /dev/disk/by-uuid/...`.

**Решение:**
```bash
# ввести пароль root → shell
journalctl -xb | grep -iE "fail|timed out" | head -20
mount -o remount,rw /
blkid                                # реальные UUID
vi /etc/fstab                        # исправить UUID / закомментировать / добавить nofail
mount -a && systemctl daemon-reload
reboot
```
Если пароль root неизвестен (в Ubuntu root заблокирован) — грузимся с `init=/bin/bash` и правим fstab там. Частая причина в облаке: отключили/пересоздали дополнительный диск, а запись в fstab осталась без `nofail`.

## [critical] grub rescue> после изменения разделов
**Симптомы:** `error: unknown filesystem` / `error: no such partition`, приглашение `grub rescue>`.

**Решение:**
```bash
grub rescue> ls
grub rescue> ls (hd0,msdos1)/          # перебираем, пока не увидим /boot/grub
grub rescue> set prefix=(hd0,msdos1)/boot/grub
grub rescue> set root=(hd0,msdos1)
grub rescue> insmod normal
grub rescue> normal
# после загрузки:
sudo grub-install /dev/sda && sudo update-grub
```
Если GRUB не загружается и так — LiveCD → `mount` root (+ `/boot`, `/boot/efi`) → `mount --rbind` dev/proc/sys/run → `chroot` → `grub-install` + `update-grub`.

## [critical] Kernel panic после обновления ядра
**Симптомы:** `Kernel panic - not syncing: VFS: Unable to mount root fs on unknown-block(0,0)`.

**Причина:** новый initramfs не собрался (переполнен `/boot`, прервали обновление), или в нём нет нужного драйвера.

**Решение:**
1. GRUB → Advanced options → загрузить предыдущее ядро.
2. `df -h /boot` — освободить место (`apt autoremove --purge` удалит старые ядра, кроме текущего).
3. `update-initramfs -u -k <новая версия>` / `dracut -f --kver <ver>`.
4. `update-grub`, перезагрузка в новое ядро.

## [high] Забыли пароль root / потерян sudo
**Решение (локальная консоль):** GRUB → `e` → дописать `init=/bin/bash` → `Ctrl+X` → `mount -o remount,rw /` → `passwd root` (или `usermod -aG sudo user`) → на RHEL `touch /.autorelabel` → `exec /sbin/init`.

**В облаке без консоли:** остановить ВМ, отсоединить диск, подключить к временной ВМ, смонтировать, `chroot`, исправить (`passwd`, ключ в `authorized_keys`, файл в `/etc/sudoers.d/`), вернуть диск. В AWS ещё вариант — SSM Session Manager или EC2 Serial Console.

## [high] Сломали /etc/sudoers — sudo не работает
**Симптомы:** `sudo: parse error in /etc/sudoers near line 25`, `sudo: no valid sudoers sources found`.

**Решение:**
- Есть пароль root: `su -` → `visudo`.
- Нет root-пароля, но есть systemd: `pkexec visudo` (если установлен polkit и вы в группе admin).
- Иначе — rescue/`init=/bin/bash` и правка.
- На будущее: только `visudo` или `visudo -cf /etc/sudoers.d/file` перед применением.

## [high] SSH: Permission denied (publickey)
**Диагностика:**
```bash
ssh -vvv user@host                    # какие ключи пробует клиент, что отвечает сервер
# на сервере:
journalctl -u ssh -n 50 | grep -iE "authentication|bad ownership|refused"
ls -ld ~user ~user/.ssh; ls -l ~user/.ssh/authorized_keys
```
**Причины и решения:**
- Неправильные права: `chmod 700 ~/.ssh; chmod 600 ~/.ssh/authorized_keys; chmod go-w ~` (лог: `Authentication refused: bad ownership or modes`).
- Владелец файлов не пользователь: `chown -R user:user ~user/.ssh`.
- Ключ вставлен с переносами строк или не тот ключ.
- Клиент предлагает слишком много ключей → `Too many authentication failures`: `ssh -o IdentitiesOnly=yes -i key`.
- Ключ RSA SHA-1 отвергается новыми OpenSSH: сгенерировать ed25519.
- SELinux: `restorecon -Rv ~/.ssh`.
- Неверный пользователь (ubuntu/ec2-user/centos/admin).

## [high] SSH: Connection refused или timeout
**Различаем:**
- `Connection refused` — до хоста дошли, но порт закрыт: sshd не запущен, слушает другой порт/адрес, файрвол делает REJECT.
- `Connection timed out` — пакеты не доходят или отбрасываются: Security Group/файрвол (DROP), неверный IP/маршрут, хост выключен.
- `Connection closed by remote host` сразу — fail2ban/`MaxStartups`/TCP wrappers/неверный конфиг.

**Диагностика:**
```bash
nc -zv host 22; nmap -Pn -p22 host
# через консоль сервера:
systemctl status ssh; ss -tlpn | grep ssh
sshd -t                                  # ошибка в конфиге не даёт запуститься
iptables -L INPUT -n -v; fail2ban-client status sshd
```

## [high] Too many open files
**Симптомы:** в логах `EMFILE: too many open files`, `accept4: too many open files`, сервис перестаёт принимать соединения.

**Диагностика:**
```bash
cat /proc/<PID>/limits | grep "open files"
ls /proc/<PID>/fd | wc -l
lsof -p <PID> | awk '{print $5}' | sort | uniq -c | sort -rn   # сокеты? файлы?
cat /proc/sys/fs/file-nr                 # общесистемное потребление
```
**Решение:**
- Поднять лимит: systemd — `systemctl edit app` → `[Service] LimitNOFILE=65536` → `daemon-reload` → restart; Docker — `--ulimit`; nginx — `worker_rlimit_nofile`.
- Если число fd растёт линейно — **утечка** (не закрываются соединения к БД/HTTP-клиенты) — чинить в коде; лимит лишь отсрочит проблему.

## [medium] Address already in use — порт занят
**Симптомы:** `bind() to 0.0.0.0:80 failed (98: Address already in use)`.

**Диагностика и решение:**
```bash
ss -tlpn 'sport = :80'
lsof -i :80
fuser -k 80/tcp                # убить процесс на порту (осторожно)
systemctl list-units | grep -E "apache|nginx|httpd"   # часто запущен второй веб-сервер
```
Если порт занят сокетом в TIME_WAIT после рестарта — приложение должно ставить `SO_REUSEADDR`. Проверьте также, не держит ли порт systemd socket activation (`systemctl list-sockets`).

## [high] Fork: Resource temporarily unavailable
**Симптомы:** `bash: fork: retry: Resource temporarily unavailable`, нельзя запустить даже `ls`.

**Причины:** исчерпан лимит процессов пользователя (`ulimit -u`, `TasksMax` в systemd, `pids.max` cgroup), fork-бомба, утечка потоков в приложении, исчерпан `kernel.pid_max`/`threads-max`.

**Диагностика и решение:**
```bash
ps -eLf | wc -l                                   # всего потоков
ps -eLf | awk '{print $1}' | sort | uniq -c | sort -rn | head   # по пользователям
ps -o nlwp= -p PID                                 # потоков в процессе
cat /sys/fs/cgroup/user.slice/user-1000.slice/pids.max
# Из существующей сессии без fork (встроенные команды bash):
kill -9 -1         # от имени проблемного пользователя — убить все его процессы
```
Профилактика: `TasksMax=` в systemd, `pids.max`, `nproc` в limits.conf.

## [medium] Много зомби-процессов
**Диагностика:**
```bash
ps -eo stat,pid,ppid,cmd | awk '$1 ~ /Z/'
ps -o pid,cmd -p <PPID>         # кто родитель
```
**Решение:** зомби не убить. Послать родителю `kill -s SIGCHLD <PPID>`; если не помогло — перезапустить родителя (тогда init соберёт зомби). Если родитель — PID 1 контейнера (ваше приложение не умеет reap) — запускать через `tini` / `docker run --init` / `shareProcessNamespace`.

## [high] DNS не резолвит имена
**Симптомы:** `Temporary failure in name resolution`, `Could not resolve host`, но `ping 8.8.8.8` работает.

**Диагностика:**
```bash
cat /etc/resolv.conf               # nameserver? search? (часто 127.0.0.53 — systemd-resolved)
resolvectl status                  # реальные DNS-серверы
dig example.com; dig @1.1.1.1 example.com     # через другой резолвер
getent hosts example.com           # как резолвит libc (учитывает /etc/hosts, nsswitch)
grep hosts /etc/nsswitch.conf
systemctl status systemd-resolved
```
**Причины:** битый `/etc/resolv.conf` (перезаписан DHCP/NetworkManager/VPN), остановлен systemd-resolved, недоступен DNS-сервер (файрвол на UDP/TCP 53), неверная запись в `/etc/hosts`.

**Решение:** восстановить симлинк `ln -sf /run/systemd/resolve/stub-resolv.conf /etc/resolv.conf`, прописать DNS в netplan/NetworkManager, `systemctl restart systemd-resolved`, `resolvectl flush-caches`.

## [medium] Неверное время: ошибки TLS и аутентификации
**Симптомы:** `certificate is not yet valid`, `x509: certificate has expired`, Kerberos/TOTP не работают, странный порядок логов, ошибки в кластерах (etcd, Ceph) из-за clock skew.

**Диагностика и решение:**
```bash
timedatectl                         # System clock synchronized: no?
chronyc tracking; chronyc sources -v
systemctl status chronyd systemd-timesyncd
timedatectl set-ntp true
chronyc makestep                    # шагнуть сразу, а не плавно
```
Проверить, что UDP 123 разрешён наружу, и что в ВМ нет конфликта с синхронизацией времени гипервизора.

## [medium] Скрипт из cron не выполняется
**Диагностика:**
```bash
grep CRON /var/log/syslog | tail;  journalctl -u cron -u crond --since today
systemctl status cron
# Сымитировать окружение cron:
env -i HOME=$HOME PATH=/usr/bin:/bin SHELL=/bin/sh /bin/sh -c '/opt/script.sh'
```
**Причины:** не тот `PATH`, относительные пути, нет `+x`, в `/etc/cron.d/` файл с точкой в имени или без перевода строки в конце (тогда cron его игнорирует), неэкранированный `%`, неверный формат (в `/etc/cron.d` нужно поле пользователя), вывод уходит в почту, а не в лог.

## [high] apt/dpkg сломан: lock или прерванная установка
**Симптомы:** `Could not get lock /var/lib/dpkg/lock-frontend`, `dpkg was interrupted, you must manually run 'dpkg --configure -a'`, `unmet dependencies`.

**Решение:**
```bash
ps aux | grep -E "apt|dpkg|unattended"   # не идёт ли установка прямо сейчас (unattended-upgrades!)
# Если процесса нет:
dpkg --configure -a
apt -f install
apt update && apt full-upgrade
```
> [!danger]
> Не удаляйте lock-файлы, пока не убедились, что apt/dpkg реально не работает — можно получить полусломанную систему.

## [high] Сломаны права после chmod/chown -R на системные каталоги
**Симптомы:** после `chmod -R 777 /` или `chown -R user /usr` не работает sudo (`sudo: /usr/bin/sudo must be owned by uid 0 and have the setuid bit set`), SSH отказывает в ключах.

**Решение:**
- RHEL: `rpm --setperms -a` и `rpm --setugids -a` восстановят права всех пакетных файлов.
- Debian/Ubuntu: штатного аналога нет; для sudo — через rescue: `chown root:root /usr/bin/sudo && chmod 4755 /usr/bin/sudo`; права можно взять с эталонной машины той же версии (`getfacl -R` / `find -printf '%m %u %g %p'`) или переустановить пакеты (`apt install --reinstall`).
- Реалистичный вариант для production — **пересоздать сервер** из образа/IaC и вернуть данные.

## [medium] Зависший NFS блокирует систему
**Симптомы:** `df`, `ls /mnt` зависают навсегда; процессы в D-state; `nfs: server X not responding, still trying`.

**Решение:**
```bash
umount -f -l /mnt/nfs        # force + lazy
# или если помогает: вернуть доступ к NFS-серверу — процессы «оживут»
df -x nfs -x nfs4 -h         # df, который не зависнет
```
Профилактика: опции монтирования (`soft,timeo=30,retrans=3` для некритичных данных, `_netdev`, `x-systemd.automount`), мониторинг доступности NFS-сервера.

## [high] Сеть не поднялась после перезагрузки
**Диагностика (через консоль):**
```bash
ip -br a; ip r
networkctl status; nmcli dev status
journalctl -b -u systemd-networkd -u NetworkManager -u networking
cat /etc/netplan/*.yaml
```
**Причины:** ошибка в YAML netplan (табы, отступы), сменилось имя интерфейса (`eth0` → `ens5` после смены типа ВМ), отсутствует драйвер, cloud-init перезаписал конфиг, конфликт NetworkManager и networkd.

**Решение:** временно поднять руками (`ip addr add`, `ip route add default`), исправить конфиг, `netplan generate && netplan try`. Для стабильных имён — привязка по MAC (`match: macaddress`).

## [high] SELinux блокирует сервис
**Симптомы:** права в порядке, но `Permission denied`; nginx не может читать файлы из `/srv/www` или подключиться к upstream (`connect() to 127.0.0.1:8080 failed (13: Permission denied)`).

**Диагностика и решение:**
```bash
getenforce
ausearch -m AVC -ts recent
sealert -a /var/log/audit/audit.log      # человеко-понятное объяснение и рекомендация
ls -Z /srv/www
semanage fcontext -a -t httpd_sys_content_t "/srv/www(/.*)?" && restorecon -Rv /srv/www
setsebool -P httpd_can_network_connect on
semanage port -a -t http_port_t -p tcp 8081
```
Не отключайте SELinux навсегда — `setenforce 0` допустим только как кратковременная проверка гипотезы.

## [critical] Подозрение на взлом: неизвестный процесс жрёт CPU
**Симптомы:** 100% CPU процессом с именем вроде `kdevtmpfsi`, `kinsing`, `xmrig`, `[kworker]` из `/tmp`; исходящие соединения на порты 3333/4444/5555; новые записи в crontab.

**Диагностика:**
```bash
ps auxf --sort=-%cpu | head
ls -l /proc/<PID>/exe; cat /proc/<PID>/cmdline | tr '\0' ' '
ss -tanp | grep <PID>
crontab -l -u <user>; ls -la /etc/cron.d /var/spool/cron
systemctl list-unit-files --state=enabled | head -50
cat ~/.ssh/authorized_keys
```
**Решение:** изолировать хост, сохранить артефакты (бинарь, crontab, логи), найти вектор входа (открытый Docker API 2375, Redis без пароля, слабый SSH-пароль, уязвимое веб-приложение), ротировать секреты, пересоздать сервер из чистого образа. Просто `kill` не поможет — майнеры восстанавливаются через cron/systemd/ld.so.preload.

# @quiz

? Какой параметр ядра в GRUB позволит загрузиться сразу в shell без systemd?
- single=true
+ init=/bin/bash
- systemd.debug
- nomodeset
> init=/bin/bash заменяет PID 1 на shell; корень будет смонтирован read-only.

? Что нужно сделать на RHEL после сброса пароля через init=/bin/bash?
- Перегенерировать initramfs
+ Создать /.autorelabel
- Выполнить grub2-install
- Удалить /etc/shadow-
> Иначе SELinux-контекст /etc/shadow будет неверным и вход не сработает.

? Где fsck можно безопасно запускать?
- На смонтированной rw ФС
+ На размонтированной (или смонтированной ro) ФС
- Только на XFS
- Только на корневом разделе
> fsck на смонтированной rw ФС приведёт к порче данных.

? Опция fstab, позволяющая системе загрузиться при отсутствии диска:
- noauto
+ nofail
- defaults
- ro
> nofail говорит systemd не считать отсутствие устройства фатальным.

? `ssh: connect to host x port 22: Connection timed out` чаще всего означает:
- sshd не запущен
+ Пакеты отбрасываются файрволом/SG или хост недоступен
- Неверный ключ
- Неверный пароль
> refused — порт закрыт явно (RST), timeout — ответа нет вообще (DROP или маршрут).

? Как быстро освободить место от удалённого лога, который держит процесс PID 500 на fd 7?
- rm -rf /proc/500
+ : > /proc/500/fd/7
- sync
- echo 3 > /proc/sys/vm/drop_caches
> Обнуление через дескриптор освобождает блоки без перезапуска процесса.

? Что из этого самый надёжный способ удалённо поменять сетевой конфиг Ubuntu?
- netplan apply и надеяться
+ netplan try (автооткат, если не подтвердить)
- reboot
- ip link set eth0 down
> netplan try откатывает изменения, если в течение таймаута не подтвердить.

? Процессы висят в D-state, df зависает. Наиболее вероятно:
- Fork-бомба
+ Недоступен NFS-сервер
- Кончились inode
- Переполнен swap
> Обращения к hard-смонтированному NFS блокируются в ядре в непрерываемом ожидании.

? Чем восстановить права всех файлов пакетов в RHEL?
- chmod -R 755 /
+ rpm --setperms -a
- restorecon -R /
- dnf repair
> rpm хранит эталонные права и владельцев для каждого файла пакета.

? Exit code 137 у процесса означает:
- Ошибку сегментации
+ Процесс убит SIGKILL (128+9), часто OOM
- Нормальное завершение
- Не найден исполняемый файл
> 128 + номер сигнала; 137 = SIGKILL, 143 = SIGTERM, 139 = SIGSEGV.
