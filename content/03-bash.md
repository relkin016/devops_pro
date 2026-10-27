---
id: bash
title: Bash и скрипты
icon: 💲
order: 30
group: Фундамент
color: #8b949e
summary: Переменные, кавычки, условия, циклы, функции, перенаправления, strict mode, trap, обработка аргументов и типичные ловушки shell-скриптов.
---

# @theory

## Основы и шебанг

```bash
#!/usr/bin/env bash
# Шебанг указывает интерпретатор. env ищет bash в PATH — переносимо.
set -euo pipefail
IFS=$'\n\t'

main() {
  echo "Hello, ${1:-world}"
}

main "$@"
```

- `bash script.sh` — запустить явно; `./script.sh` — нужен `chmod +x` и шебанг.
- `source script.sh` / `. script.sh` — выполнить **в текущем shell** (переменные и `cd` останутся).
- `sh` ≠ `bash`: в Debian `/bin/sh` → `dash`, в нём нет массивов, `[[ ]]`, `${var//}`.
- Проверка синтаксиса: `bash -n script.sh`; трассировка: `bash -x script.sh` или `set -x` внутри.
- Линтер — **shellcheck**. Обязательно используйте в CI.

## Strict mode: set -euo pipefail

| Опция | Что делает | Подвох |
|---|---|---|
| `-e` (errexit) | выйти при ненулевом коде команды | не срабатывает в условиях `if`, в `&&`/`\|\|`, в подстановках в некоторых контекстах |
| `-u` (nounset) | ошибка при обращении к неустановленной переменной | `$1` без аргумента упадёт → используйте `${1:-}` |
| `-o pipefail` | код пайплайна = код первой упавшей команды | без него `false \| true` вернёт 0 |
| `-x` (xtrace) | печатать команды перед выполнением | может засветить секреты в логах CI |

```bash
grep -q pattern file || true     # «ожидаемая» ошибка не уронит скрипт
if ! cmd; then echo "failed"; fi
count=$(grep -c x file || true)
```

## Переменные и кавычки

```bash
name="world"          # без пробелов вокруг =
readonly VERSION=1.2
export PATH="$HOME/bin:$PATH"     # export — передаётся дочерним процессам
local tmp             # внутри функции

echo "$name"          # двойные кавычки: переменные раскрываются
echo '$name'          # одинарные: всё буквально
echo "${name}_suffix" # фигурные скобки отделяют имя
```

> [!danger] Всегда берите переменные в двойные кавычки
> `rm -rf $DIR/*` при пустой `DIR` превратится в `rm -rf /*`. А `cp $file /tmp` сломается на имени с пробелом. Пишите `"$DIR"`, `"$@"`, и используйте `${DIR:?}`, чтобы упасть при пустом значении: `rm -rf "${DIR:?}"/*`.

### Раскрытие параметров
| Конструкция | Результат |
|---|---|
| `${var:-default}` | значение или default, если пусто/не задано |
| `${var:=default}` | то же + присвоить |
| `${var:?msg}` | ошибка с msg, если пусто |
| `${var:+alt}` | alt, если var не пусто |
| `${#var}` | длина |
| `${var#prefix}` / `${var##*/}` | удалить кратчайший/длиннейший префикс (basename) |
| `${var%suffix}` / `${var%/*}` | удалить суффикс (dirname) |
| `${var/old/new}` / `${var//old/new}` | замена первого / всех |
| `${var^^}` / `${var,,}` | верхний / нижний регистр |
| `${var:0:5}` | подстрока |

```bash
file="/var/log/nginx/access.log.gz"
echo "${file##*/}"     # access.log.gz
echo "${file%.gz}"     # /var/log/nginx/access.log
echo "${file%/*}"      # /var/log/nginx
```

### Специальные переменные
| | |
|---|---|
| `$0` | имя скрипта |
| `$1..$9`, `${10}` | позиционные аргументы |
| `$#` | число аргументов |
| `"$@"` | все аргументы, каждый отдельным словом (**почти всегда нужно именно это**) |
| `"$*"` | все аргументы одной строкой |
| `$?` | код возврата последней команды |
| `$$` | PID текущего shell |
| `$!` | PID последнего фонового процесса |
| `$_` | последний аргумент предыдущей команды |

## Условия и тесты

```bash
if [[ -f /etc/os-release ]]; then
  . /etc/os-release
  echo "$ID $VERSION_ID"
elif [[ -d /etc/redhat-release ]]; then
  :
else
  echo "unknown" >&2
fi
```

| Тест | Значение |
|---|---|
| `-f` / `-d` / `-e` | файл / каталог / существует |
| `-r` / `-w` / `-x` | доступен на чтение / запись / исполнение |
| `-s` | файл не пустой |
| `-L` | симлинк |
| `-z "$s"` / `-n "$s"` | строка пустая / непустая |
| `"$a" == "$b"` / `!=` | строки равны |
| `-eq -ne -lt -le -gt -ge` | сравнение чисел |
| `[[ $s =~ ^[0-9]+$ ]]` | регулярка (только `[[ ]]`) |
| `[[ $s == *.log ]]` | glob-шаблон |

`[[ ]]` — встроенный в bash, безопаснее `[ ]` (не нужно кавычить переменные от word splitting, есть `&&`, `||`, `=~`). Арифметика — `(( ))`: `if (( count > 10 )); then`.

```bash
case "$1" in
  start|up)   start ;;
  stop)       stop ;;
  *.tar.gz)   extract "$1" ;;
  *)          echo "usage: $0 {start|stop}" >&2; exit 1 ;;
esac
```

## Циклы

```bash
for host in web1 web2 web3; do
  ssh "$host" uptime
done

for i in {1..10}; do echo "$i"; done
for ((i = 0; i < 5; i++)); do echo "$i"; done

# Правильное чтение файла построчно
while IFS= read -r line; do
  echo "line: $line"
done < hosts.txt

# Обработка вывода команды без subshell-ловушки
while read -r pid cmd; do
  echo "$pid -> $cmd"
done < <(ps -eo pid=,comm=)

# Ожидание с таймаутом
for i in {1..30}; do
  curl -sf http://localhost:8080/health && break
  sleep 2
done
```

> [!warn] Ловушка: pipe в while создаёт subshell
> `cat file | while read l; do count=$((count+1)); done; echo $count` → 0, потому что цикл выполнялся в subshell. Используйте `done < file` или `done < <(cmd)`.

> [!warn] Не парсите ls
> `for f in $(ls *.log)` ломается на пробелах. Пишите `for f in *.log; do [[ -e $f ]] || continue; ...` или `find ... -print0 | xargs -0`.

## Функции, коды возврата, массивы

```bash
log()  { printf '%s [%s] %s\n' "$(date +%FT%T)" "$1" "${*:2}" >&2; }
die()  { log ERROR "$@"; exit 1; }

is_port_open() {
  local host=$1 port=$2
  timeout 2 bash -c "</dev/tcp/$host/$port" 2>/dev/null
}

is_port_open db 5432 || die "db недоступна"
```
- `return N` — код возврата функции (0–255), «вернуть строку» — через `echo` и `$(func)`.
- Переменные в функциях глобальны, если не объявлены `local`.

```bash
# Индексный массив
servers=(web1 web2 "db 1")
echo "${servers[0]}"; echo "${#servers[@]}"
for s in "${servers[@]}"; do echo "$s"; done
servers+=(web4)

# Ассоциативный массив (bash 4+)
declare -A port=([http]=80 [https]=443)
for k in "${!port[@]}"; do echo "$k=${port[$k]}"; done
```

## Перенаправления и подстановки

```bash
cmd > out.log           # stdout в файл (перезапись)
cmd >> out.log          # дописать
cmd 2> err.log          # stderr
cmd > all.log 2>&1      # оба (порядок важен!)
cmd &> all.log          # то же, bash-сокращение
cmd 2>/dev/null         # выкинуть ошибки
cmd < input.txt         # stdin из файла
cmd1 | cmd2             # stdout cmd1 → stdin cmd2
cmd1 |& cmd2            # stdout+stderr
diff <(sort a) <(sort b)            # process substitution
result=$(command)                    # command substitution
cat <<EOF > /etc/app.conf            # here-doc с раскрытием переменных
host=$HOST
EOF
cat <<'EOF' > script.sh              # 'EOF' — без раскрытия
echo $HOME
EOF
grep -c x <<< "$var"                 # here-string
```

`tee`: `cmd | tee -a log.txt` — и на экран, и в файл. `sudo tee` — способ записать в root-файл: `echo "x" | sudo tee /etc/file >/dev/null` (а `sudo echo x > /etc/file` не сработает — перенаправление делает ваш shell, не sudo).

## trap, временные файлы, блокировки

```bash
tmpdir=$(mktemp -d)
cleanup() {
  rm -rf "$tmpdir"
}
trap cleanup EXIT                 # выполнится при любом выходе
trap 'echo "ошибка в строке $LINENO" >&2' ERR
trap 'echo "прервано"; exit 130' INT TERM

# Не запускать вторую копию (cron!)
exec 9>/var/lock/backup.lock
flock -n 9 || { echo "уже запущен"; exit 1; }
# или одной строкой в crontab:
# */5 * * * * flock -n /tmp/job.lock /opt/job.sh
```

## Аргументы: getopts

```bash
#!/usr/bin/env bash
set -euo pipefail

usage() { echo "usage: $0 [-e env] [-v] [-n] target" >&2; exit 2; }

env=staging verbose=0 dry_run=0
while getopts ":e:vnh" opt; do
  case $opt in
    e) env=$OPTARG ;;
    v) verbose=1 ;;
    n) dry_run=1 ;;
    h) usage ;;
    :) echo "-$OPTARG требует значение" >&2; usage ;;
    \?) echo "неизвестный флаг -$OPTARG" >&2; usage ;;
  esac
done
shift $((OPTIND - 1))
(( $# == 1 )) || usage
target=$1

run() { if (( dry_run )); then echo "+ $*"; else "$@"; fi; }
run rsync -az ./build/ "deploy@$target:/srv/app/"
```

## Полезные приёмы

```bash
# Повтор с экспоненциальной задержкой
retry() {
  local n=0 max=5 delay=1
  until "$@"; do
    (( ++n >= max )) && return 1
    sleep $delay; delay=$((delay * 2))
  done
}
retry curl -sf https://api/health

# Параллельный запуск с ожиданием
for h in "${hosts[@]}"; do ssh "$h" 'apt update' & done
wait

# Параллельность с ограничением
printf '%s\n' "${hosts[@]}" | xargs -P 10 -I{} ssh {} uptime

# Проверка зависимостей
for bin in jq curl aws; do command -v "$bin" >/dev/null || die "нужен $bin"; done

# Чтение конфига key=value
while IFS='=' read -r k v; do [[ $k =~ ^# ]] && continue; printf -v "$k" '%s' "$v"; done < app.env

# Цвета, только если вывод — терминал
if [[ -t 1 ]]; then RED=$'\e[31m'; RST=$'\e[0m'; else RED=; RST=; fi

# Дата и арифметика
date +%Y-%m-%d_%H%M; date -d "7 days ago" +%F; echo $(( 17 / 5 )) $(( 17 % 5 ))
```

## Однострочники для собеса и работы

```bash
# Топ-10 IP по числу запросов
awk '{print $1}' access.log | sort | uniq -c | sort -rn | head
# Количество ответов по кодам
awk '{print $9}' access.log | sort | uniq -c | sort -rn
# Запросы в минуту
awk '{print substr($4, 2, 17)}' access.log | uniq -c | tail
# Средний response time (последнее поле)
awk '{s+=$NF; n++} END {print s/n}' access.log
# Найти и заменить во всех файлах
grep -rl 'old.host' /etc/app | xargs sed -i 's/old\.host/new.host/g'
# Самые большие файлы
find / -xdev -type f -printf '%s %p\n' 2>/dev/null | sort -rn | head | numfmt --to=iec --field=1
# Процессы по потреблению памяти
ps -eo rss,pid,comm --sort=-rss | head | awk '{printf "%8.1f MB %s %s\n", $1/1024, $2, $3}'
# Сертификат сайта: срок действия
echo | openssl s_client -connect example.com:443 -servername example.com 2>/dev/null | openssl x509 -noout -dates
# Ждать порт
until nc -z localhost 5432; do sleep 1; done
# Уникальные строки, которые есть в a, но нет в b
comm -23 <(sort -u a) <(sort -u b)
```

# @interview

## [junior] Разница между одинарными и двойными кавычками?
В двойных раскрываются переменные `$var`, подстановки `$(cmd)` и экранирование `\`; в одинарных — всё буквально. Переменные почти всегда нужно брать в двойные кавычки, чтобы избежать word splitting и glob-раскрытия.

## [junior] Что делает set -euo pipefail?
`-e` — завершать скрипт при ошибке любой команды; `-u` — ошибка при использовании неопределённой переменной; `-o pipefail` — код возврата пайплайна равен коду последней упавшей команды, а не последней команды. Вместе — «strict mode», который не даёт скрипту продолжать работу после сбоя.

## [junior] Чем $@ отличается от $*?
В кавычках `"$@"` раскрывается в отдельные слова для каждого аргумента (сохраняя пробелы внутри аргументов), а `"$*"` — в одну строку, склеенную через первый символ IFS. Для передачи аргументов дальше всегда `"$@"`.

## [junior] Как проверить код возврата команды?
`$?` сразу после команды, или напрямую: `if cmd; then`, `cmd && echo ok || echo fail`. 0 — успех, любое другое — ошибка. Коды > 128 означают завершение по сигналу (128 + N).

## [middle] Что такое source и чем отличается от запуска скрипта?
`source file` (или `. file`) выполняет команды в **текущем** shell — переменные, функции, `cd` остаются. `./file` или `bash file` запускает **новый процесс**, изменения окружения теряются при выходе. Так загружают `.env`, `.bashrc`, `/etc/os-release`.

## [middle] Почему переменная, изменённая внутри while после pipe, пустая после цикла?
Каждая часть пайплайна выполняется в subshell, изменения переменных не попадают в родительский shell. Решения: перенаправление `done < file`, process substitution `done < <(cmd)` или `shopt -s lastpipe`.

## [middle] Как сделать, чтобы скрипт удалял временные файлы при любом завершении?
`tmp=$(mktemp -d); trap 'rm -rf "$tmp"' EXIT`. Ловушка на EXIT срабатывает при нормальном выходе, `exit`, ошибке при `set -e`, а также при INT/TERM, если для них установлен trap (или по умолчанию в bash). От SIGKILL не спасёт ничто.

## [middle] Как не допустить параллельного запуска одного скрипта из cron?
`flock`: `flock -n /var/lock/job.lock /opt/job.sh` или внутри скрипта `exec 9>/var/lock/job.lock; flock -n 9 || exit 1`. Блокировка снимается автоматически при завершении процесса (в отличие от pid-файлов, которые остаются при падении).

## [middle] Что такое exit code 126 и 127?
126 — команда найдена, но не может быть выполнена (нет прав на исполнение). 127 — команда не найдена (PATH, опечатка). 130 — прервано Ctrl+C (128+2), 137 — SIGKILL, 143 — SIGTERM.

## [senior] Почему в Docker ENTRYPOINT-скриптах пишут `exec "$@"`?
`exec` заменяет процесс shell на приложение, и оно становится PID 1 контейнера. Тогда сигналы (SIGTERM от `docker stop`/kubelet) приходят напрямую приложению. Без `exec` сигнал получит shell, который по умолчанию не пробрасывает его дочернему процессу — контейнер будет убит по таймауту SIGKILL.

## [middle] Как безопасно обработать имена файлов с пробелами и переводами строк?
Не парсить `ls`, использовать glob (`for f in *`), `find -print0 | xargs -0` или `find -exec ... {} +`, `while IFS= read -r -d '' f; do ...; done < <(find . -print0)`, всегда кавычки вокруг `"$f"`.

## [junior] Зачем shellcheck?
Статический анализатор shell-скриптов: находит некавыченные переменные, ошибки в условиях, непереносимые конструкции, бесполезные `cat`, ловушки с `read` без `-r`. Должен запускаться в CI для всех скриптов.

# @troubleshooting

## [medium] Скрипт с Windows-машины: bad interpreter
**Симптомы:** `/bin/bash^M: bad interpreter: No such file or directory`, или странные ошибки `$'\r': command not found`.

**Причина:** переводы строк CRLF.

**Решение:** `dos2unix script.sh` или `sed -i 's/\r$//' script.sh`; настроить `.gitattributes`: `*.sh text eol=lf`.

## [medium] Скрипт работает в bash, но падает в sh/cron/Docker
**Симптомы:** `[[: not found`, `Syntax error: "(" unexpected`, `Bad substitution`.

**Причина:** скрипт запущен `sh` (dash/busybox ash), а использует bash-измы (массивы, `[[ ]]`, `${var//}`, `<<<`, `function`).

**Решение:** правильный шебанг `#!/usr/bin/env bash` и запуск `./script` или `bash script`, а не `sh script`; в Alpine — установить bash или писать POSIX-совместимо (проверять `shellcheck -s sh`).

## [medium] set -e не остановил скрипт после ошибки
**Причина:** ошибка произошла в контексте, где errexit отключён: внутри `if`, слева от `&&`/`||`, в функции, вызванной из условия, в `local var=$(cmd)` (код `local` перекрывает код подстановки), в пайплайне без `pipefail`.

**Решение:** `local var; var=$(cmd)`, `set -o pipefail`, явная проверка критичных команд (`cmd || die "..."`), `shopt -s inherit_errexit` (bash 4.4+).

# @quiz

? Что выведет `a=1; (a=2); echo $a`?
+ 1
- 2
- пустую строку
- ошибку
> Круглые скобки создают subshell, изменения переменных не возвращаются.

? Какая конструкция вернёт имя файла без пути из `p=/a/b/c.txt`?
- ${p%/*}
+ ${p##*/}
- ${p#*/}
- ${p%%/*}
> `##*/` удаляет самый длинный префикс, заканчивающийся на `/`.

? Как записать строку в файл, принадлежащий root, через sudo?
- sudo echo text > /etc/file
+ echo text | sudo tee /etc/file
- sudo (echo text > /etc/file)
- echo text > sudo /etc/file
> Перенаправление выполняет текущий shell без прав root; tee запускается под sudo.

? Что делает `set -o pipefail`?
- Останавливает скрипт при любой ошибке
+ Делает код возврата пайплайна ненулевым, если упала любая команда в нём
- Запрещает использовать пайпы
- Включает отладку пайпов
> Без него код пайплайна — код последней команды.

? Код выхода 127 означает:
- Нет прав на исполнение
+ Команда не найдена
- Процесс убит
- Синтаксическая ошибка
> 126 — нет прав, 127 — не найдена.

? Как правильно читать файл построчно, сохраняя пробелы и обратные слеши?
- for line in $(cat file)
+ while IFS= read -r line; do ...; done < file
- cat file | xargs echo
- read -a lines < file
> `IFS=` сохраняет пробелы в начале/конце, `-r` — обратные слеши.
