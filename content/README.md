# Формат контента

Каждый `*.md` в этой папке — одна тема. После правки запустить `npm run build` (или `node tools/build.mjs`),
результат пишется в `js/content.js`.

```
---
id: linux            # латиница, используется в URL
title: Linux
icon: 🐧
order: 10            # порядок в меню
group: Фундамент     # группа в меню
color: #f0b429
summary: Одна строка описания
---

# @theory
## Заголовок раздела
Markdown: ### подзаголовки, списки, таблицы, ```bash блоки```, `код`, **жирный**,
> [!tip|info|warn|danger|interview|example] Заголовок
> текст выноски

# @interview
## [junior|middle|senior] Вопрос?
Ответ в markdown.

# @troubleshooting
## [critical|high|medium|low] Название кейса
**Симптомы** … **Диагностика** … **Решение** …

# @quiz
? Текст вопроса
- неверный вариант
+ верный вариант
- неверный вариант
> Пояснение
```
