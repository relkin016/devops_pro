---
id: git
title: Git
icon: 🔀
order: 50
group: Фундамент
color: #f78166
summary: Внутреннее устройство, ветвление, merge vs rebase, стратегии ветвления, восстановление потерянного, хуки, секреты в истории.
---

# @theory

## Как Git устроен внутри

Git — это **контент-адресуемое хранилище объектов** + указатели на них.

| Объект | Что хранит |
|---|---|
| **blob** | содержимое файла (без имени) |
| **tree** | каталог: имена → blob/tree + права |
| **commit** | ссылка на tree, родитель(и), автор, коммиттер, сообщение |
| **tag** (annotated) | ссылка на объект + сообщение, автор, подпись |

Идентификатор объекта — хэш SHA-1 (переход на SHA-256) от его содержимого. Изменили один байт — новый хэш, новый объект.

- **Ветка** — просто файл `refs/heads/main` с хэшем коммита. Создать ветку = записать 41 байт.
- **HEAD** — указатель на текущую ветку (или на коммит в состоянии detached HEAD).
- **Три зоны**: рабочий каталог → **индекс (staging)** → репозиторий (коммиты).

```bash
git cat-file -p HEAD               # содержимое коммита
git cat-file -p HEAD^{tree}        # дерево
git rev-parse HEAD
cat .git/HEAD; ls .git/refs/heads
git count-objects -vH              # размер репозитория
```

## Ежедневные команды

```bash
git status -sb
git add -p                     # добавить по кускам (hunks)
git commit -m "feat: ..."; git commit --amend --no-edit
git diff; git diff --staged; git diff main...feature
git log --oneline --graph --decorate --all
git log -p -- path/file; git log -S "functionName"   # кто добавил/удалил строку
git blame -L 10,30 file
git show HEAD~2:path/file
git switch -c feature/x; git switch main
git restore file                # откатить изменения в рабочем каталоге
git restore --staged file       # убрать из индекса
git stash push -m "wip"; git stash list; git stash pop
git fetch --prune; git pull --rebase
git push -u origin feature/x
git push --force-with-lease     # безопасный force push
git tag -a v1.2.0 -m "release"; git push --tags
git clean -fdx -n               # что удалится (без -n — удалить неотслеживаемое)
```

## Merge, rebase, cherry-pick, squash

### merge
Создаёт **merge-коммит** с двумя родителями, история сохраняется как есть. Если ветка main не ушла вперёд — **fast-forward** (просто двигается указатель), `--no-ff` принудительно создаёт merge-коммит.

### rebase
**Переписывает** коммиты ветки поверх новой базы (новые хэши). История линейная.
```bash
git switch feature
git rebase main
# конфликты → поправить → git add → git rebase --continue (или --abort)
git rebase -i HEAD~5            # squash/fixup/reword/drop/reorder
git commit --fixup <sha>; git rebase -i --autosquash main
```

> [!danger] Золотое правило rebase
> Не делайте rebase (и любую перезапись истории) **публичных веток**, на которых работают другие (main, develop). Для своей фича-ветки — можно, но после пуша нужен `--force-with-lease`.

### cherry-pick
Скопировать отдельный коммит в текущую ветку — типично для **хотфиксов** в release-ветку: `git cherry-pick <sha>`, `-x` добавит ссылку на исходный коммит.

### squash merge
Все коммиты фичи схлопываются в один на main. Чистая история, но теряются промежуточные коммиты и связь с веткой.

| | merge | rebase | squash |
|---|---|---|---|
| История | нелинейная, правдивая | линейная | линейная, 1 коммит на фичу |
| Перезапись | нет | да | да (для ветки) |
| Конфликты | один раз | на каждом коммите | один раз |

## Отмена и восстановление

| Задача | Команда |
|---|---|
| Изменить последний коммит | `git commit --amend` |
| Отменить коммит, оставив изменения | `git reset --soft HEAD~1` |
| Отменить коммит и убрать из индекса | `git reset HEAD~1` (mixed) |
| Выбросить коммит и изменения | `git reset --hard HEAD~1` |
| Отменить запушенный коммит безопасно | `git revert <sha>` (новый коммит-антипод) |
| Отменить merge-коммит | `git revert -m 1 <merge-sha>` |
| Вернуть файл из прошлого | `git restore --source=<sha> file` |

### reflog — машина времени
Каждое перемещение HEAD записывается в reflog (≈90 дней). Даже после `reset --hard` или неудачного rebase коммиты можно вернуть.
```bash
git reflog
# a1b2c3d HEAD@{0}: reset: moving to HEAD~3
# e4f5g6h HEAD@{1}: commit: важная работа
git reset --hard HEAD@{1}         # или git branch rescue e4f5g6h
git fsck --lost-found             # «висячие» коммиты, если нет в reflog (например, после stash drop)
```

### bisect — поиск коммита, который всё сломал
```bash
git bisect start
git bisect bad                  # текущий — сломан
git bisect good v1.4.0          # тут работало
# git переключает на середину; проверяем и отмечаем good/bad
git bisect run ./test.sh        # или автоматически по коду возврата
git bisect reset
```

## Стратегии ветвления

| Стратегия | Суть | Для кого |
|---|---|---|
| **GitHub Flow** | main всегда деплоибелен; короткие feature-ветки → PR → merge → деплой | веб-сервисы с CD |
| **Trunk-Based Development** | все коммитят в main (или ветки < 1–2 дней), незавершённое прячут за **feature flags** | высокочастотный CD, сильные тесты |
| **GitFlow** | main + develop + feature/* + release/* + hotfix/* | продукты с версиями и релизным циклом (коробки, мобилки) |
| **GitLab Flow** | main + environment-ветки (staging, production) или release-ветки | промежуточный вариант |

> [!interview]
> Для DevOps-собеса: «GitFlow тяжёлый и плохо сочетается с CI/CD — долгоживущие ветки, дорогие слияния. Для сервисов я предпочитаю trunk-based или GitHub flow с короткими ветками, обязательным ревью, CI на каждый PR и feature flags».

### Защита веток и соглашения
- Protected branches: запрет force push, обязательный PR, approvals, зелёный CI, CODEOWNERS.
- **Conventional Commits**: `feat:`, `fix:`, `chore:`, `docs:`, `refactor:`, `feat!:` → автоматический semver и changelog (semantic-release, release-please).
- **SemVer**: `MAJOR.MINOR.PATCH` — несовместимые изменения / новая функциональность / исправления.

## Хуки, большие файлы, монорепо

### Хуки
Скрипты в `.git/hooks/` (локально, не версионируются) — `pre-commit`, `commit-msg`, `pre-push`. Для команды — фреймворк **pre-commit** (`.pre-commit-config.yaml`): форматтеры, линтеры, `terraform fmt`, `shellcheck`, поиск секретов (gitleaks, detect-secrets). Серверные хуки — `pre-receive` (GitLab/Gitea).

```yaml .pre-commit-config.yaml
repos:
  - repo: https://github.com/pre-commit/pre-commit-hooks
    rev: v4.6.0
    hooks:
      - id: trailing-whitespace
      - id: check-yaml
      - id: detect-private-key
  - repo: https://github.com/gitleaks/gitleaks
    rev: v8.18.4
    hooks:
      - id: gitleaks
  - repo: https://github.com/antonbabenko/pre-commit-terraform
    rev: v1.92.0
    hooks:
      - id: terraform_fmt
      - id: terraform_validate
```

### Большие файлы и производительность
- **Git LFS** — хранит большие бинарники вне репозитория, в git — указатели.
- `git clone --depth 1` (shallow) — быстро в CI; `--filter=blob:none` (partial clone); `sparse-checkout` для монорепо.
- `.gitignore`, `.gitattributes` (`*.sh text eol=lf`, `*.png binary`).

### Submodules vs subtree
Submodule — ссылка на конкретный коммит другого репо (нужно `git submodule update --init --recursive`, частый источник проблем в CI). Subtree — копия кода внутри репо с возможностью синхронизации.

## Секреты в репозитории

> [!danger] Закоммитили пароль/ключ
> 1. **Сначала ротируйте секрет** — считайте его скомпрометированным: репо мог быть склонирован, попасть в CI-кэш, форки, боты сканируют GitHub за секунды.
> 2. Затем почистите историю: `git filter-repo --path secrets.env --invert-paths` или `--replace-text`, либо BFG Repo-Cleaner. Force push во все ветки, попросить всех переклонировать, удалить кэш PR/форков через поддержку платформы.
> 3. Добавить защиту: gitleaks в pre-commit и CI, push protection (GitHub secret scanning).

# @interview

## [junior] Чем git merge отличается от git rebase?
Merge объединяет ветки, создавая merge-коммит (или fast-forward), историю не переписывает. Rebase переносит коммиты ветки поверх другой базы, создавая новые коммиты — история линейная, но переписанная. Rebase не применяют к общим публичным веткам.

## [junior] Чем git fetch отличается от git pull?
`fetch` скачивает новые объекты и обновляет remote-tracking ветки (`origin/main`), не трогая ваши локальные ветки и рабочий каталог. `pull` = `fetch` + `merge` (или `rebase` с `--rebase`) в текущую ветку.

## [middle] Чем reset отличается от revert?
`reset` двигает указатель ветки назад (soft — изменения остаются в индексе, mixed — в рабочем каталоге, hard — выбрасываются), переписывает историю — нельзя для запушенных общих веток. `revert` создаёт новый коммит, отменяющий изменения указанного, история сохраняется — безопасно для shared-веток.

## [middle] Случайно сделали git reset --hard и потеряли коммиты. Как вернуть?
`git reflog` — найти хэш состояния до reset, затем `git reset --hard <sha>` или `git branch recovered <sha>`. Если коммита нет в reflog (например, потерянный stash) — `git fsck --lost-found`.

## [middle] Что такое detached HEAD?
HEAD указывает напрямую на коммит, а не на ветку (после `git checkout <sha>` или тега, в CI при checkout конкретного коммита). Новые коммиты не принадлежат ни одной ветке и могут быть потеряны — нужно создать ветку `git switch -c name`.

## [middle] Какие стратегии ветвления знаете? Что выберете для микросервиса с CD?
GitFlow, GitHub Flow, GitLab Flow, Trunk-Based. Для сервиса с непрерывной доставкой — trunk-based / GitHub flow: короткоживущие ветки, PR с обязательным CI и ревью, частые маленькие релизы, feature flags для незавершённой функциональности. GitFlow — для продуктов с явными версиями и поддержкой нескольких релизов.

## [junior] Что такое cherry-pick и когда его используют?
Применение изменений конкретного коммита к текущей ветке как нового коммита. Типично — перенести хотфикс из main в release-ветку или наоборот.

## [middle] Чем --force-with-lease лучше --force?
`--force-with-lease` перезапишет удалённую ветку, только если она находится в том состоянии, которое вы видели при последнем fetch. Если кто-то успел запушить — push отклонится, и вы не затрёте чужую работу.

## [senior] Вы обнаружили, что в публичный репозиторий полгода назад попал AWS-ключ. Ваши действия?
1) Немедленно деактивировать/ротировать ключ и проверить CloudTrail на использование. 2) Оценить ущерб. 3) Удалить из истории (`git filter-repo`/BFG), force push всех веток и тегов, обращение в поддержку платформы для очистки кэшей и PR-ссылок. 4) Внедрить gitleaks в pre-commit/CI, secret scanning с push protection, перевести секреты в Vault/Secret Manager, использовать короткоживущие креды (OIDC) вместо статических ключей.

## [middle] Как найти коммит, который сломал сборку?
`git bisect`: отметить плохой и хороший коммиты, Git делает бинарный поиск; `git bisect run <script>` автоматизирует проверку. Также `git log -S`, `git blame`, сравнение артефактов CI.

## [junior] Как работает .gitignore? Почему файл продолжает отслеживаться после добавления в .gitignore?
.gitignore влияет только на неотслеживаемые файлы. Если файл уже в индексе, нужно `git rm --cached file` и закоммитить.

## [middle] Что такое Git LFS и когда нужен?
Расширение для хранения больших бинарных файлов вне истории git (в репозитории остаются текстовые указатели). Нужно для медиа, моделей, артефактов, чтобы репозиторий не раздувался и клонировался быстро.

# @troubleshooting

## [medium] Конфликт при merge/rebase
**Решение:**
```bash
git status                      # какие файлы в конфликте
# вручную убрать маркеры <<<<<<< ======= >>>>>>> или:
git checkout --ours file / --theirs file
git mergetool
git add file && git rebase --continue   # или git merge --continue / git commit
git rebase --abort / git merge --abort  # всё отменить
```
Профилактика: маленькие и короткоживущие ветки, частый rebase на main, `git rerere` (запоминает разрешения).

## [medium] Запушили не то в main
**Решение:** не переписывайте историю общей ветки — `git revert <sha>` (для merge — `git revert -m 1 <sha>`), запушить. Если в коммите секрет — см. тему секретов: сначала ротация.

## [low] Репозиторий огромный, клонируется вечность
**Диагностика:** `git count-objects -vH`, `git rev-list --objects --all | git cat-file --batch-check='%(objecttype) %(objectname) %(objectsize) %(rest)' | sort -k3 -n | tail` — найти большие блобы.

**Решение:** в CI — `--depth 1`, `--filter=blob:none`; убрать бинарники в LFS и почистить историю `git filter-repo --strip-blobs-bigger-than 10M` (с force push и переклонированием), `git gc --aggressive`.

# @quiz

? Что хранит blob в Git?
+ Содержимое файла без имени
- Имя и содержимое файла
- Список файлов каталога
- Метаданные коммита
> Имена хранятся в объектах tree.

? Какая команда безопасно отменит уже запушенный коммит в общей ветке?
- git reset --hard HEAD~1
+ git revert <sha>
- git commit --amend
- git rebase -i
> revert создаёт новый коммит без переписывания истории.

? Как восстановить коммиты после случайного reset --hard?
- git restore
+ git reflog и reset на нужную запись
- git stash pop
- Никак
> reflog хранит историю перемещений HEAD.

? git pull по умолчанию это:
+ fetch + merge
- fetch + rebase
- только fetch
- push + fetch
> Поведение меняется `pull.rebase=true` или `--rebase`.

? Что делает `git bisect`?
- Разделяет репозиторий на два
+ Бинарным поиском находит коммит, внёсший ошибку
- Сравнивает две ветки
- Разделяет коммит на несколько
> Нужно указать хороший и плохой коммиты.

? Что первым делом сделать, если секрет попал в публичный репозиторий?
- Удалить файл новым коммитом
- Переписать историю
+ Отозвать/ротировать секрет
- Сделать репозиторий приватным
> История могла быть уже склонирована — секрет скомпрометирован.
