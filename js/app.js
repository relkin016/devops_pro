(function () {
  "use strict";

  const DATA = window.DEVOPS_CONTENT;
  const TOPICS = DATA.topics;
  const byId = Object.fromEntries(TOPICS.map((t) => [t.id, t]));
  const $ = (sel, root) => (root || document).querySelector(sel);
  const $$ = (sel, root) => Array.from((root || document).querySelectorAll(sel));
  const view = $("#view");

  const LEVELS = { junior: "Junior", middle: "Middle", senior: "Senior" };
  const SEVERITY = { critical: "Критично", high: "Высокий", medium: "Средний", low: "Низкий" };
  const TABS = [
    ["theory", "📖 Теория", "theory"],
    ["interview", "🎤 Собеседование", "interview"],
    ["troubleshooting", "🔧 Траблшутинг", "troubleshooting"],
    ["quiz", "✅ Квиз", "quiz"],
  ];

  // ---------- storage ----------

  const STORE_KEY = "devops-pro:state";
  const state = (function load() {
    try {
      const s = JSON.parse(localStorage.getItem(STORE_KEY)) || {};
      return { read: s.read || {}, cards: s.cards || {}, quiz: s.quiz || {}, last: s.last || {} };
    } catch (e) {
      return { read: {}, cards: {}, quiz: {}, last: {} };
    }
  })();
  function save() {
    try { localStorage.setItem(STORE_KEY, JSON.stringify(state)); } catch (e) { /* приватный режим */ }
  }

  function isRead(tid, sid) { return !!(state.read[tid] && state.read[tid][sid]); }
  function setRead(tid, sid, v) {
    state.read[tid] = state.read[tid] || {};
    if (v) state.read[tid][sid] = 1; else delete state.read[tid][sid];
    save();
  }
  function cardState(qid) { return state.cards[qid] || ""; }
  function setCard(qid, v) {
    if (v) state.cards[qid] = v; else delete state.cards[qid];
    save();
  }

  function topicProgress(t) {
    const read = t.theory.filter((s) => isRead(t.id, s.id)).length;
    const known = t.interview.filter((q) => cardState(q.id) === "known").length;
    const total = t.theory.length + t.interview.length;
    return { read, known, pct: total ? Math.round(((read + known) / total) * 100) : 0 };
  }

  // ---------- utils ----------

  function esc(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
  }
  function shuffle(arr) {
    const a = arr.slice();
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
  }
  function plural(n, one, few, many) {
    const m10 = n % 10, m100 = n % 100;
    if (m10 === 1 && m100 !== 11) return one;
    if (m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14)) return few;
    return many;
  }
  function toast(text) {
    const el = document.createElement("div");
    el.className = "toast";
    el.textContent = text;
    document.body.appendChild(el);
    setTimeout(() => el.remove(), 1600);
  }
  const sum = (key) => TOPICS.reduce((n, t) => n + t[key].length, 0);

  // ---------- nav ----------

  function renderNav(activeId) {
    const groups = [];
    for (const t of TOPICS) {
      let g = groups.find((x) => x.name === t.group);
      if (!g) groups.push((g = { name: t.group, items: [] }));
      g.items.push(t);
    }
    const route = location.hash;
    const extra = [
      ["#/", "⌂", "Обзор и маршрут", !activeId && (route === "" || route === "#/" || route === "#")],
      ["#/train", "🎯", "Тренажёр вопросов", route.startsWith("#/train")],
      ["#/exam", "🧪", "Экзамен (микс)", route.startsWith("#/exam")],
      ["#/fix", "🚑", "Все траблшутинги", route.startsWith("#/fix")],
    ];
    $("#nav").innerHTML =
      extra.map(([href, ico, name, on]) =>
        `<a class="nav-item${on ? " active" : ""}" href="${href}"><span class="nav-ico">${ico}</span><span>${name}</span><span></span></a>`
      ).join("") +
      groups.map((g) =>
        `<div class="nav-group">${esc(g.name)}</div>` +
        g.items.map((t) => {
          const p = topicProgress(t).pct;
          return `<a class="nav-item${t.id === activeId ? " active" : ""}" href="#/t/${t.id}"><span class="nav-ico">${t.icon}</span><span>${esc(t.title)}</span><span class="nav-pct">${p ? p + "%" : ""}</span></a>`;
        }).join("")
      ).join("");
  }

  // ---------- home ----------

  const ROADMAP = [
    ["01", "Фундамент", ["linux", "linux-troubleshooting", "bash", "networking", "git"]],
    ["02", "Контейнеры и доставка", ["docker", "cicd", "nginx"]],
    ["03", "Оркестрация и IaC", ["kubernetes", "helm", "terraform", "ansible"]],
    ["04", "Эксплуатация", ["monitoring", "databases", "cloud", "security", "tools", "sre", "interview-general"]],
  ];

  function renderHome() {
    const totalSec = sum("theory"), totalQ = sum("interview");
    const readAll = TOPICS.reduce((n, t) => n + topicProgress(t).read, 0);
    const knownAll = TOPICS.reduce((n, t) => n + topicProgress(t).known, 0);
    view.innerHTML = `
      <section class="hero">
        <span class="eyebrow">DevOps Pro · v${esc(DATA.version)}</span>
        <h1>От <span class="acc">ls -la</span> до production-<br>инцидента в Kubernetes.</h1>
        <p>Учебник, тренажёр к собеседованиям и сборник реальных поломок с разбором. Linux, сети, Docker, Kubernetes, Terraform, Ansible, CI/CD, мониторинг, базы данных, облака и безопасность — всё работает офлайн, прогресс сохраняется в браузере.</p>
        <div class="hero-actions">
          <a class="btn primary" href="#/t/linux">Начать с Linux →</a>
          <a class="btn" href="#/train">🎯 Тренажёр собеседования</a>
          <a class="btn" href="#/fix">🚑 Траблшутинг</a>
        </div>
        <div class="stats">
          <div class="stat"><strong>${TOPICS.length}</strong><span>тем</span></div>
          <div class="stat"><strong>${totalSec}</strong><span>разделов теории · изучено ${readAll}</span></div>
          <div class="stat"><strong>${totalQ}</strong><span>вопросов с собесов · знаю ${knownAll}</span></div>
          <div class="stat"><strong>${sum("troubleshooting")}</strong><span>кейсов траблшутинга</span></div>
          <div class="stat"><strong>${sum("quiz")}</strong><span>вопросов в квизах</span></div>
        </div>
      </section>

      <div class="sec-head"><h2>Маршрут обучения</h2><span>Рекомендуемый порядок — сверху вниз, слева направо</span></div>
      <div class="roadmap">${ROADMAP.map(([n, name, ids]) => `
        <div class="stage"><div class="stage-n">ЭТАП ${n}</div><h3>${name}</h3>
          ${ids.filter((id) => byId[id]).map((id) => {
            const t = byId[id], p = topicProgress(t).pct;
            return `<a href="#/t/${id}">${t.icon} ${esc(t.title)}${p ? ` <span class="muted">· ${p}%</span>` : ""}</a>`;
          }).join("")}
        </div>`).join("")}
      </div>

      <div class="sec-head"><h2>Все темы</h2><span>Прогресс = изученные разделы + вопросы «знаю»</span></div>
      <div class="grid">${TOPICS.map((t) => {
        const p = topicProgress(t);
        return `<a class="card" href="#/t/${t.id}" style="--c:${esc(t.color)}">
          <div class="card-top"><span class="card-ico">${t.icon}</span><h3>${esc(t.title)}</h3></div>
          <p>${esc(t.summary)}</p>
          <div class="card-meta"><span>${t.theory.length} разд.</span><span>${t.interview.length} вопр.</span><span>${t.troubleshooting.length} кейс.</span><span>${p.pct}%</span></div>
          <div class="bar"><span style="width:${p.pct}%"></span></div>
        </a>`;
      }).join("")}</div>

      <div class="tip"><span>⌨️</span><div><strong>Горячие клавиши.</strong> <kbd>/</kbd> или <kbd>Ctrl</kbd>+<kbd>K</kbd> — поиск по всему (команды, ошибки, вопросы). В теории <kbd>←</kbd>/<kbd>→</kbd> — листать разделы. В тренажёре <kbd>Пробел</kbd> — показать ответ, <kbd>1</kbd> — знаю, <kbd>2</kbd> — повторить.
        Прогресс хранится в localStorage этого браузера. <a href="#" id="reset-progress">Сбросить прогресс</a></div></div>`;
    $("#reset-progress").addEventListener("click", (e) => {
      e.preventDefault();
      if (!confirm("Сбросить весь прогресс: изученные разделы, карточки и результаты квизов?")) return;
      state.read = {}; state.cards = {}; state.quiz = {}; state.last = {};
      save();
      route();
    });
  }

  // ---------- topic ----------

  function topicHeader(t, tab) {
    const p = topicProgress(t);
    const count = { theory: t.theory.length, interview: t.interview.length, troubleshooting: t.troubleshooting.length, quiz: t.quiz.length };
    return `
      <header class="topic-head">
        <div class="crumbs"><a href="#/">обзор</a> / ${esc(t.group.toLowerCase())} / ${esc(t.id)}</div>
        <div class="topic-title"><span class="ico">${t.icon}</span><h1>${esc(t.title)}</h1></div>
        <p>${esc(t.summary)}</p>
        <div class="topic-progress"><span>${p.read}/${t.theory.length} разд. · ${p.known}/${t.interview.length} вопр.</span><div class="bar"><span style="width:${p.pct}%"></span></div><span>${p.pct}%</span></div>
      </header>
      <nav class="tabs">${TABS.filter(([k]) => count[k]).map(([k, label]) =>
        `<a class="tab${k === tab ? " active" : ""}" href="#/t/${t.id}/${k}">${label}<span class="n">${count[k]}</span></a>`).join("")}
      </nav>`;
  }

  function renderTheory(t, sid) {
    if (!t.theory.length) return renderInterview(t);
    let idx = t.theory.findIndex((s) => s.id === sid);
    if (idx < 0) idx = Math.max(0, t.theory.findIndex((s) => s.id === state.last[t.id]));
    const s = t.theory[idx];
    state.last[t.id] = s.id;
    save();
    const prev = t.theory[idx - 1], next = t.theory[idx + 1];
    const read = isRead(t.id, s.id);
    view.innerHTML = topicHeader(t, "theory") + `
      <div class="theory">
        <nav class="toc">${t.theory.map((x, i) =>
          `<a class="${x.id === s.id ? "active" : ""}${isRead(t.id, x.id) ? " done" : ""}" href="#/t/${t.id}/theory/${x.id}"><span class="chk">${isRead(t.id, x.id) ? "✓" : String(i + 1).padStart(2, "0")}</span><span>${esc(x.title)}</span></a>`).join("")}
        </nav>
        <article class="article">
          <div class="prose"><h2>${esc(s.title)}</h2>${s.html}</div>
          <div class="article-foot">
            <button class="btn ${read ? "ok" : "primary"}" id="mark-read" type="button">${read ? "✓ Изучено" : "Отметить изученным"}</button>
            <div class="pager">
              ${prev ? `<a class="btn" href="#/t/${t.id}/theory/${prev.id}" data-key="prev">← ${esc(prev.title)}</a>` : ""}
              ${next ? `<a class="btn" href="#/t/${t.id}/theory/${next.id}" data-key="next">${esc(next.title)} →</a>`
                : t.interview.length ? `<a class="btn" href="#/t/${t.id}/interview" data-key="next">К вопросам собеседования →</a>` : ""}
            </div>
          </div>
        </article>
      </div>`;
    $("#mark-read").addEventListener("click", () => {
      const v = !isRead(t.id, s.id);
      setRead(t.id, s.id, v);
      if (v && next) location.hash = `#/t/${t.id}/theory/${next.id}`;
      else route();
    });
  }

  const qaFilter = { level: "all", status: "all", text: "" };

  function renderInterview(t, openId) {
    view.innerHTML = topicHeader(t, "interview") + `
      <div class="toolbar">
        <div class="chips" id="lvl-chips">${[["all", "Все"], ...Object.entries(LEVELS)].map(([k, v]) =>
          `<button class="chip${qaFilter.level === k ? " on" : ""}" data-level="${k}" type="button">${v}</button>`).join("")}
          <span style="width:8px"></span>
          ${[["all", "Любые"], ["new", "Новые"], ["repeat", "Повторить"], ["known", "Знаю"]].map(([k, v]) =>
          `<button class="chip${qaFilter.status === k ? " on" : ""}" data-status="${k}" type="button">${v}</button>`).join("")}
        </div>
        <div class="row">
          <input id="qa-filter" type="search" placeholder="Фильтр вопросов…" value="${esc(qaFilter.text)}">
          <button class="ghost-btn" id="expand" type="button">Раскрыть все</button>
          <a class="btn" href="#/train/${t.id}">🎯 Карточки</a>
        </div>
      </div>
      <div class="qa-list" id="qa-list"></div>`;

    const list = $("#qa-list");
    function draw() {
      const needle = qaFilter.text.toLowerCase();
      const items = t.interview.filter((q) =>
        (qaFilter.level === "all" || q.level === qaFilter.level) &&
        (qaFilter.status === "all" || (qaFilter.status === "new" ? !cardState(q.id) : cardState(q.id) === qaFilter.status)) &&
        (!needle || (q.qText + " " + q.text).toLowerCase().includes(needle)));
      list.innerHTML = items.length ? items.map((q) => qaItem(q, t.interview.indexOf(q) + 1, q.id === openId)).join("")
        : `<div class="empty">Под фильтр ничего не попало.</div>`;
    }
    draw();
    bindQa(list);
    $("#lvl-chips").addEventListener("click", (e) => {
      const b = e.target.closest("button");
      if (!b) return;
      if (b.dataset.level) qaFilter.level = b.dataset.level;
      if (b.dataset.status) qaFilter.status = b.dataset.status;
      $$("#lvl-chips button").forEach((x) => x.classList.toggle("on",
        x.dataset.level ? x.dataset.level === qaFilter.level : x.dataset.status === qaFilter.status));
      draw();
    });
    $("#qa-filter").addEventListener("input", (e) => { qaFilter.text = e.target.value; draw(); });
    $("#expand").addEventListener("click", (e) => {
      const all = $$("details", list);
      const open = all.some((d) => !d.open);
      all.forEach((d) => { d.open = open; });
      e.target.textContent = open ? "Свернуть все" : "Раскрыть все";
    });
    scrollToOpen(list);
  }

  function statusIcon(qid) {
    const s = cardState(qid);
    return s === "known" ? "✅" : s === "repeat" ? "🔁" : "";
  }

  function qaItem(q, n, open, topicLabel) {
    return `<details class="qa" id="q-${q.id}" data-qid="${q.id}"${open ? " open" : ""}>
      <summary><span class="qn">${topicLabel || String(n).padStart(2, "0")}</span><span class="lvl lvl-${q.level}">${LEVELS[q.level]}</span><span>${q.q}</span><span class="st">${statusIcon(q.id)}</span></summary>
      <div class="qa-body prose">${q.html}
        <div class="qa-actions">
          <button class="btn ok" data-mark="known" type="button">✅ Знаю</button>
          <button class="btn warn" data-mark="repeat" type="button">🔁 Повторить</button>
          <button class="ghost-btn" data-mark="" type="button">Сбросить</button>
        </div>
      </div>
    </details>`;
  }

  function bindQa(list) {
    list.addEventListener("click", (e) => {
      const b = e.target.closest("[data-mark]");
      if (!b) return;
      const d = b.closest("details");
      setCard(d.dataset.qid, b.dataset.mark);
      $(".st", d).textContent = statusIcon(d.dataset.qid);
      d.open = false;
      renderNav(currentTopic);
    });
  }

  function scrollToOpen(root) {
    const el = $("details[open]", root);
    if (el) setTimeout(() => el.scrollIntoView({ block: "start", behavior: "smooth" }), 30);
  }

  function tsItem(x, topicLabel, open) {
    return `<details class="qa" id="ts-${x.id}"${open ? " open" : ""}>
      <summary><span class="lvl lvl-${x.severity}">${SEVERITY[x.severity] || x.severity}</span><span>${x.title}</span>${topicLabel ? `<span class="st muted" style="font-size:12px">${topicLabel}</span>` : ""}</summary>
      <div class="qa-body prose">${x.html}</div>
    </details>`;
  }

  function renderTroubleshooting(t, openId) {
    view.innerHTML = topicHeader(t, "troubleshooting") + `
      <div class="toolbar">
        <span class="muted">Формат: симптомы → диагностика → причина → решение. Сначала попробуйте ответить сами, потом раскрывайте.</span>
        <input id="ts-filter" type="search" placeholder="Фильтр: ошибка, команда…">
      </div>
      <div class="qa-list" id="ts-list">${t.troubleshooting.map((x) => tsItem(x, "", x.id === openId)).join("")}</div>`;
    bindFilter($("#ts-filter"), $("#ts-list"), t.troubleshooting);
    scrollToOpen($("#ts-list"));
  }

  function bindFilter(input, list, items) {
    input.addEventListener("input", () => {
      const needle = input.value.toLowerCase();
      items.forEach((x) => {
        const el = $("#ts-" + x.id, list);
        el.hidden = !!needle && !(x.titleText + " " + x.text).toLowerCase().includes(needle);
      });
    });
  }

  function renderAllFixes(openId) {
    const all = TOPICS.flatMap((t) => t.troubleshooting.map((x) => ({ x, t })));
    view.innerHTML = `
      <header class="topic-head">
        <div class="crumbs"><a href="#/">обзор</a> / траблшутинг</div>
        <div class="topic-title"><span class="ico">🚑</span><h1>Траблшутинг: все кейсы</h1></div>
        <p>${all.length} реальных поломок из всех тем: Linux, сеть, Docker, Kubernetes, Terraform, CI/CD, базы. Именно такие ситуации дают на собеседованиях («у вас упал сервис — ваши действия»).</p>
      </header>
      <div class="toolbar">
        <div class="chips" id="ts-topics"><button class="chip on" data-t="" type="button">Все</button>${TOPICS.filter((t) => t.troubleshooting.length).map((t) =>
          `<button class="chip" data-t="${t.id}" type="button">${t.icon} ${esc(t.title)} <span class="muted">${t.troubleshooting.length}</span></button>`).join("")}</div>
        <input id="ts-filter" type="search" placeholder="Фильтр: OOMKilled, inode, 502…">
      </div>
      <div class="qa-list" id="ts-list">${all.map(({ x, t }) =>
        `<div data-topic="${t.id}">${tsItem(x, t.icon + " " + esc(t.title), x.id === openId)}</div>`).join("")}</div>`;
    const list = $("#ts-list");
    let topic = "";
    const input = $("#ts-filter");
    function apply() {
      const needle = input.value.toLowerCase();
      all.forEach(({ x, t }) => {
        const el = $("#ts-" + x.id, list).parentElement;
        el.hidden = (topic && t.id !== topic) || (!!needle && !(x.titleText + " " + x.text).toLowerCase().includes(needle));
      });
    }
    input.addEventListener("input", apply);
    $("#ts-topics").addEventListener("click", (e) => {
      const b = e.target.closest("button");
      if (!b) return;
      topic = b.dataset.t;
      $$("#ts-topics button").forEach((x) => x.classList.toggle("on", x === b));
      apply();
    });
    scrollToOpen(list);
  }

  // ---------- quiz ----------

  let quizSession = null;

  function startQuiz(key, questions, count) {
    const qs = shuffle(questions).slice(0, count || questions.length).map((q) => {
      const order = shuffle(q.options.map((_, i) => i));
      return { q: q.q, explain: q.explain, options: order.map((i) => q.options[i]), answer: order.indexOf(q.answer), topic: q.topic };
    });
    quizSession = { key, qs, i: 0, picked: null, score: 0 };
  }

  function renderQuizInto(container, key, source, opts) {
    if (!quizSession || quizSession.key !== key) startQuiz(key, source, opts.count);
    const s = quizSession;
    if (s.i >= s.qs.length) {
      const pct = Math.round((s.score / s.qs.length) * 100);
      const prev = state.quiz[key];
      if (!s.saved) {
        s.saved = true;
        if (!prev || pct > prev.best) state.quiz[key] = { best: pct, at: Date.now() };
        save();
      }
      container.innerHTML = `<div class="quiz"><div class="result">
        <div class="big">${pct}%</div>
        <p>${s.score} из ${s.qs.length} правильных. ${pct >= 85 ? "Отлично, можно идти на собес 💪" : pct >= 60 ? "Неплохо, но есть пробелы — перечитайте теорию." : "Стоит вернуться к теории этой темы."}</p>
        <p class="muted">Лучший результат: ${Math.max(pct, prev ? prev.best : 0)}%</p>
        <button class="btn primary" id="quiz-again" type="button">Пройти ещё раз</button>
      </div></div>`;
      $("#quiz-again").addEventListener("click", () => { quizSession = null; renderQuizInto(container, key, source, opts); });
      return;
    }
    const q = s.qs[s.i];
    const done = s.picked !== null;
    container.innerHTML = `<div class="quiz">
      <div class="quiz-top"><span>Вопрос ${s.i + 1} / ${s.qs.length}${q.topic ? " · " + byId[q.topic].icon + " " + esc(byId[q.topic].title) : ""}</span>
        <div class="bar"><span style="width:${(s.i / s.qs.length) * 100}%"></span></div><span>верно: ${s.score}</span></div>
      <div class="quiz-q">${q.q}</div>
      <div class="opts">${q.options.map((o, i) => {
        const cls = done ? (i === q.answer ? " right" : i === s.picked ? " wrong" : "") : "";
        return `<button class="opt${cls}" data-i="${i}" type="button"${done ? " disabled" : ""}><span class="k">${"ABCDEF"[i]}</span><span>${o}</span></button>`;
      }).join("")}</div>
      ${done ? `<div class="callout ${s.picked === q.answer ? "callout-tip" : "callout-warn"} explain"><div class="callout-title">${s.picked === q.answer ? "Верно" : "Неверно"}</div><p>${q.explain || ""}</p></div>
        <div class="row" style="margin-top:14px"><button class="btn primary" id="quiz-next" type="button">${s.i + 1 < s.qs.length ? "Дальше →" : "Результат"}</button></div>` : ""}
    </div>`;
    $$(".opt", container).forEach((b) => b.addEventListener("click", () => {
      s.picked = +b.dataset.i;
      if (s.picked === q.answer) s.score++;
      renderQuizInto(container, key, source, opts);
    }));
    const nextBtn = $("#quiz-next");
    if (nextBtn) {
      nextBtn.focus();
      nextBtn.addEventListener("click", () => { s.i++; s.picked = null; renderQuizInto(container, key, source, opts); });
    }
  }

  function renderQuiz(t) {
    const best = state.quiz[t.id];
    view.innerHTML = topicHeader(t, "quiz") + `<p class="muted">Вопросы и варианты перемешиваются при каждом запуске.${best ? ` Лучший результат: <strong>${best.best}%</strong>.` : ""}</p><div id="quiz"></div>`;
    renderQuizInto($("#quiz"), t.id, t.quiz, {});
  }

  function renderExam() {
    const pool = TOPICS.flatMap((t) => t.quiz.map((q) => Object.assign({ topic: t.id }, q)));
    const best = state.quiz.__exam;
    view.innerHTML = `
      <header class="topic-head">
        <div class="crumbs"><a href="#/">обзор</a> / экзамен</div>
        <div class="topic-title"><span class="ico">🧪</span><h1>Экзамен: микс по всем темам</h1></div>
        <p>30 случайных вопросов из ${pool.length}. Имитация технического скрининга.${best ? ` Лучший результат: <strong>${best.best}%</strong>.` : ""}</p>
      </header>
      <div class="row" style="margin-bottom:16px"><button class="btn" id="exam-new" type="button">↻ Новый набор</button></div>
      <div id="quiz"></div>`;
    renderQuizInto($("#quiz"), "__exam", pool, { count: 30 });
    $("#exam-new").addEventListener("click", () => { quizSession = null; renderExam(); });
  }

  // ---------- trainer ----------

  const trainer = { topics: new Set(), levels: new Set(["junior", "middle", "senior"]), mode: "smart", queue: null, shown: false, done: 0 };

  function trainerPool() {
    return TOPICS.filter((t) => !trainer.topics.size || trainer.topics.has(t.id))
      .flatMap((t) => t.interview.map((q) => Object.assign({ topic: t.id }, q)))
      .filter((q) => trainer.levels.has(q.level))
      .filter((q) => {
        const s = cardState(q.id);
        return trainer.mode === "all" || (trainer.mode === "repeat" ? s === "repeat" : s !== "known");
      });
  }

  function buildQueue() {
    const pool = trainerPool();
    // «Повторить» — первыми, затем новые.
    trainer.queue = trainer.mode === "smart"
      ? shuffle(pool.filter((q) => cardState(q.id) === "repeat")).concat(shuffle(pool.filter((q) => !cardState(q.id))))
      : shuffle(pool);
    trainer.shown = false;
    trainer.done = 0;
  }

  function renderTrainer(topicId) {
    if (topicId && byId[topicId] && !(trainer.topics.size === 1 && trainer.topics.has(topicId))) {
      trainer.topics = new Set([topicId]);
      trainer.queue = null;
    }
    if (!trainer.queue) buildQueue();
    const q = trainer.queue[0];
    const t = q && byId[q.topic];
    view.innerHTML = `
      <header class="topic-head">
        <div class="crumbs"><a href="#/">обзор</a> / тренажёр</div>
        <div class="topic-title"><span class="ico">🎯</span><h1>Тренажёр собеседования</h1></div>
        <p>Карточки из вопросов, которые реально задают. Сформулируйте ответ вслух, затем откройте эталон и честно оцените себя.</p>
      </header>
      <div class="panel">
        <h3>Темы</h3>
        <div class="chips" id="tr-topics"><button class="chip${!trainer.topics.size ? " on" : ""}" data-t="" type="button">Все</button>${TOPICS.filter((x) => x.interview.length).map((x) =>
          `<button class="chip${trainer.topics.has(x.id) ? " on" : ""}" data-t="${x.id}" type="button">${x.icon} ${esc(x.title)}</button>`).join("")}</div>
        <div class="row" style="margin-top:12px">
          <div class="chips" id="tr-levels">${Object.entries(LEVELS).map(([k, v]) => `<button class="chip${trainer.levels.has(k) ? " on" : ""}" data-l="${k}" type="button">${v}</button>`).join("")}</div>
          <span style="width:10px"></span>
          <div class="chips" id="tr-mode">${[["smart", "Новые + повторить"], ["repeat", "Только «повторить»"], ["all", "Все подряд"]].map(([k, v]) =>
            `<button class="chip${trainer.mode === k ? " on" : ""}" data-m="${k}" type="button">${v}</button>`).join("")}</div>
        </div>
      </div>
      <div class="flash">
        ${q ? `<div class="flash-card">
            <div class="flash-meta"><span>${t.icon} ${esc(t.title)}</span><span class="lvl lvl-${q.level}">${LEVELS[q.level]}</span><span style="margin-left:auto">осталось ${trainer.queue.length} · пройдено ${trainer.done}</span></div>
            <div class="flash-q">${q.q}</div>
            ${trainer.shown ? `<div class="flash-a prose">${q.html}</div>` : ""}
          </div>
          <div class="flash-actions">
            ${trainer.shown
              ? `<button class="btn ok" data-a="known" type="button">✅ Знаю <kbd>1</kbd></button><button class="btn warn" data-a="repeat" type="button">🔁 Повторить <kbd>2</kbd></button><button class="ghost-btn" data-a="skip" type="button">Пропустить</button>`
              : `<button class="btn primary" data-a="show" type="button">Показать ответ <kbd>Пробел</kbd></button><button class="ghost-btn" data-a="skip" type="button">Пропустить</button>`}
          </div>`
        : `<div class="empty">🎉 Карточек под выбранные фильтры не осталось. Пройдено в этой сессии: ${trainer.done}.<br><br><button class="btn" id="tr-restart" type="button">Начать заново</button></div>`}
      </div>`;

    $("#tr-topics").addEventListener("click", (e) => {
      const b = e.target.closest("button");
      if (!b) return;
      const id = b.dataset.t;
      if (!id) trainer.topics.clear();
      else if (trainer.topics.has(id)) trainer.topics.delete(id);
      else trainer.topics.add(id);
      buildQueue();
      if (location.hash !== "#/train") location.hash = "#/train"; else renderTrainer();
    });
    $("#tr-levels").addEventListener("click", (e) => {
      const b = e.target.closest("button");
      if (!b) return;
      const l = b.dataset.l;
      if (trainer.levels.has(l) && trainer.levels.size > 1) trainer.levels.delete(l); else trainer.levels.add(l);
      buildQueue();
      renderTrainer();
    });
    $("#tr-mode").addEventListener("click", (e) => {
      const b = e.target.closest("button");
      if (!b) return;
      trainer.mode = b.dataset.m;
      buildQueue();
      renderTrainer();
    });
    const restart = $("#tr-restart");
    if (restart) restart.addEventListener("click", () => { trainer.mode = "all"; buildQueue(); renderTrainer(); });
    $$("[data-a]").forEach((b) => b.addEventListener("click", () => trainerAction(b.dataset.a)));
  }

  function trainerAction(a) {
    const q = trainer.queue && trainer.queue[0];
    if (!q) return;
    if (a === "show") { trainer.shown = true; renderTrainer(); return; }
    trainer.queue.shift();
    if (a === "known") { setCard(q.id, "known"); trainer.done++; }
    if (a === "repeat") {
      setCard(q.id, "repeat");
      trainer.done++;
      // Вернуть карточку через несколько вопросов.
      trainer.queue.splice(Math.min(trainer.queue.length, 4 + Math.floor(Math.random() * 4)), 0, q);
    }
    if (a === "skip") trainer.queue.push(q);
    trainer.shown = false;
    renderNav(null);
    renderTrainer();
    window.scrollTo({ top: 0 });
  }

  // ---------- search ----------

  const INDEX = TOPICS.flatMap((t) => [
    ...t.theory.map((s) => ({ kind: "Теория", t, title: s.title, text: s.text, href: `#/t/${t.id}/theory/${s.id}` })),
    ...t.interview.map((q) => ({ kind: "Вопрос", t, title: q.qText, text: q.text, href: `#/t/${t.id}/interview/${q.id}` })),
    ...t.troubleshooting.map((x) => ({ kind: "Траблшутинг", t, title: x.titleText, text: x.text, href: `#/t/${t.id}/troubleshooting/${x.id}` })),
  ]).map((e) => Object.assign(e, { lt: e.title.toLowerCase(), lx: e.text.toLowerCase() }));

  function searchIndex(query) {
    const terms = query.toLowerCase().split(/\s+/).filter((w) => w.length > 1 || /[a-z0-9]/.test(w));
    if (!terms.length) return [];
    const out = [];
    for (const e of INDEX) {
      let score = 0, ok = true;
      for (const w of terms) {
        const inT = e.lt.includes(w), inX = e.lx.includes(w);
        if (!inT && !inX && !e.t.title.toLowerCase().includes(w)) { ok = false; break; }
        score += (inT ? 10 : 0) + (inX ? 1 + Math.min(4, e.lx.split(w).length - 2) : 0) + (e.lt.startsWith(w) ? 5 : 0);
      }
      if (ok) out.push([score + (e.kind === "Траблшутинг" ? 1 : 0), e]);
    }
    return out.sort((a, b) => b[0] - a[0]).slice(0, 40).map((x) => x[1]);
  }

  function mark(text, terms) {
    let s = esc(text);
    for (const w of terms) {
      if (!w) continue;
      s = s.replace(new RegExp(esc(w).replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "gi"), (m) => `<mark>${m}</mark>`);
    }
    return s;
  }

  function snippet(e, terms) {
    const pos = Math.max(0, ...terms.map((w) => e.lx.indexOf(w)).filter((p) => p >= 0).slice(0, 1));
    const start = Math.max(0, pos - 60);
    return (start ? "…" : "") + e.text.slice(start, start + 170) + (start + 170 < e.text.length ? "…" : "");
  }

  const searchInput = $("#search");
  const resultsBox = $("#search-results");
  let sel = 0;

  function drawResults() {
    const q = searchInput.value.trim();
    if (!q) { resultsBox.hidden = true; return; }
    const terms = q.toLowerCase().split(/\s+/);
    const res = searchIndex(q);
    sel = 0;
    resultsBox.hidden = false;
    resultsBox.innerHTML = res.length ? res.map((e, i) => `
      <a class="sr-item${i === 0 ? " sel" : ""}" href="${e.href}">
        <div class="sr-meta"><span>${e.t.icon} ${esc(e.t.title)}</span><span>·</span><span>${e.kind}</span></div>
        <div class="sr-title">${mark(e.title, terms)}</div>
        <div class="sr-snip">${mark(snippet(e, terms), terms)}</div>
      </a>`).join("") : `<div class="sr-empty">Ничего не найдено по «${esc(q)}». Попробуйте другое слово или английский термин.</div>`;
  }

  searchInput.addEventListener("input", drawResults);
  searchInput.addEventListener("focus", drawResults);
  searchInput.addEventListener("keydown", (e) => {
    const items = $$(".sr-item", resultsBox);
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      if (!items.length) return;
      sel = (sel + (e.key === "ArrowDown" ? 1 : -1) + items.length) % items.length;
      items.forEach((x, i) => x.classList.toggle("sel", i === sel));
      items[sel].scrollIntoView({ block: "nearest" });
    } else if (e.key === "Enter" && items[sel]) {
      location.hash = items[sel].getAttribute("href");
      closeSearch();
    } else if (e.key === "Escape") {
      closeSearch();
    }
  });
  resultsBox.addEventListener("click", (e) => { if (e.target.closest("a")) closeSearch(); });
  document.addEventListener("click", (e) => { if (!e.target.closest(".search")) resultsBox.hidden = true; });
  function closeSearch() {
    resultsBox.hidden = true;
    searchInput.blur();
  }

  // ---------- global events ----------

  view.addEventListener("click", (e) => {
    const b = e.target.closest(".copy");
    if (!b) return;
    const code = b.closest(".code").querySelector("code").innerText;
    const done = () => { b.textContent = "Скопировано"; b.classList.add("done"); setTimeout(() => { b.textContent = "Копировать"; b.classList.remove("done"); }, 1400); };
    if (navigator.clipboard && window.isSecureContext) navigator.clipboard.writeText(code).then(done, () => fallbackCopy(code, done));
    else fallbackCopy(code, done);
  });
  function fallbackCopy(text, done) {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.style.position = "fixed";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.select();
    try { document.execCommand("copy"); done(); } catch (err) { toast("Не удалось скопировать"); }
    ta.remove();
  }

  document.addEventListener("keydown", (e) => {
    const typing = /INPUT|TEXTAREA/.test(document.activeElement.tagName);
    if ((e.key === "k" && (e.ctrlKey || e.metaKey)) || (e.key === "/" && !typing)) {
      e.preventDefault();
      searchInput.focus();
      searchInput.select();
      return;
    }
    if (typing || e.ctrlKey || e.metaKey || e.altKey) return;
    if (location.hash.startsWith("#/train") && trainer.queue && trainer.queue[0]) {
      if (e.key === " " && !trainer.shown) { e.preventDefault(); trainerAction("show"); }
      else if (e.key === "1" && trainer.shown) trainerAction("known");
      else if (e.key === "2" && trainer.shown) trainerAction("repeat");
      return;
    }
    if (e.key === "ArrowRight" || e.key === "ArrowLeft") {
      const a = $(`[data-key="${e.key === "ArrowRight" ? "next" : "prev"}"]`);
      if (a) location.hash = a.getAttribute("href");
    }
  });

  const sidebar = $("#sidebar"), scrim = $("#scrim");
  function toggleMenu(open) {
    sidebar.classList.toggle("open", open);
    scrim.classList.toggle("show", open);
  }
  $("#menu-btn").addEventListener("click", () => toggleMenu(!sidebar.classList.contains("open")));
  scrim.addEventListener("click", () => toggleMenu(false));
  $("#nav").addEventListener("click", (e) => { if (e.target.closest("a")) toggleMenu(false); });

  $("#theme-toggle").addEventListener("click", () => {
    const root = document.documentElement;
    const cur = root.dataset.theme || (matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark");
    const next = cur === "light" ? "dark" : "light";
    root.dataset.theme = next;
    try { localStorage.setItem("devops-pro:theme", next); } catch (err) { /* ignore */ }
  });
  if (!document.documentElement.dataset.theme && matchMedia("(prefers-color-scheme: light)").matches) {
    document.documentElement.dataset.theme = "light";
  }
  $("#version").textContent = "v" + DATA.version;

  // ---------- router ----------

  let currentTopic = null;
  let lastHash = "";

  function route() {
    const parts = location.hash.replace(/^#\/?/, "").split("/").filter(Boolean).map(decodeURIComponent);
    const sameView = lastHash.split("/").slice(0, 4).join("/") === location.hash.split("/").slice(0, 4).join("/");
    lastHash = location.hash;
    currentTopic = null;
    if (parts[0] === "t" && byId[parts[1]]) {
      const t = byId[parts[1]];
      currentTopic = t.id;
      const tab = parts[2] || "theory";
      if (tab === "interview") renderInterview(t, parts[3]);
      else if (tab === "troubleshooting") renderTroubleshooting(t, parts[3]);
      else if (tab === "quiz") { if (!quizSession || quizSession.key !== t.id) quizSession = null; renderQuiz(t); }
      else renderTheory(t, parts[3]);
    } else if (parts[0] === "train") {
      renderTrainer(parts[1]);
    } else if (parts[0] === "exam") {
      renderExam();
    } else if (parts[0] === "fix") {
      renderAllFixes(parts[1]);
    } else {
      renderHome();
    }
    renderNav(currentTopic);
    if (!parts[3] || parts[2] === "theory" || !sameView) window.scrollTo({ top: 0 });
    document.title = currentTopic ? `${byId[currentTopic].title} — DevOps Pro` : "DevOps Pro";
  }

  window.addEventListener("hashchange", route);
  route();
})();
