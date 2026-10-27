#!/usr/bin/env node
// Собирает content/*.md в js/content.js (window.DEVOPS_CONTENT).
// Формат файла темы описан в content/README.md.
import { readFileSync, writeFileSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const CONTENT_DIR = join(ROOT, "content");
const OUT = join(ROOT, "js", "content.js");
const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));

// ---------- helpers ----------

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);

const TRANSLIT = {
  а: "a", б: "b", в: "v", г: "g", д: "d", е: "e", ё: "e", ж: "zh", з: "z", и: "i", й: "y", к: "k", л: "l", м: "m",
  н: "n", о: "o", п: "p", р: "r", с: "s", т: "t", у: "u", ф: "f", х: "h", ц: "c", ч: "ch", ш: "sh", щ: "sch", ъ: "",
  ы: "y", ь: "", э: "e", ю: "yu", я: "ya", і: "i", ї: "yi", є: "e",
};

function slug(text) {
  return text.toLowerCase()
    .split("").map((c) => TRANSLIT[c] ?? c).join("")
    .replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60) || "s";
}

function hash(text) {
  let h = 5381;
  for (let i = 0; i < text.length; i++) h = ((h << 5) + h + text.charCodeAt(i)) >>> 0;
  return h.toString(36);
}

function plain(md) {
  return md
    .replace(/```[^\n]*\n/g, " ").replace(/```/g, " ")
    .replace(/[*_`>#|]/g, " ").replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/\s+/g, " ").trim();
}

// ---------- syntax highlighting ----------

const KW = {
  hcl: "resource|data|variable|output|locals|module|provider|terraform|backend|required_providers|for_each|count|depends_on|lifecycle|dynamic|content|for|in|if|true|false|null|moved|import|check",
  python: "def|class|import|from|return|if|elif|else|for|while|in|not|and|or|try|except|finally|with|as|None|True|False|lambda|yield|raise",
  go: "func|package|import|return|if|else|for|range|var|const|type|struct|interface|go|defer|nil|true|false",
  sql: "SELECT|FROM|WHERE|INSERT|INTO|VALUES|UPDATE|SET|DELETE|CREATE|TABLE|INDEX|DROP|ALTER|JOIN|LEFT|RIGHT|INNER|ON|GROUP|BY|ORDER|LIMIT|AND|OR|NOT|NULL|AS|EXPLAIN|ANALYZE|GRANT|REVOKE|BEGIN|COMMIT|ROLLBACK|VACUUM|WITH|HAVING|DISTINCT|COUNT|USER|DATABASE|PRIMARY|KEY",
  docker: "FROM|RUN|CMD|ENTRYPOINT|COPY|ADD|ENV|ARG|WORKDIR|EXPOSE|USER|VOLUME|LABEL|HEALTHCHECK|SHELL|ONBUILD|STOPSIGNAL|AS",
  promql: "sum|rate|irate|increase|avg|max|min|count|by|without|histogram_quantile|topk|bottomk|absent|offset|on|ignoring|group_left|group_right|and|or|unless|predict_linear|delta|deriv|avg_over_time|max_over_time|label_replace|clamp_min",
  nginx: "server|location|listen|server_name|root|index|proxy_pass|proxy_set_header|upstream|return|rewrite|try_files|include|ssl_certificate|ssl_certificate_key|http|events|worker_processes|worker_connections|access_log|error_log|limit_req|limit_req_zone|add_header|gzip|keepalive_timeout|client_max_body_size|proxy_read_timeout|if|set|map",
};

function lexer(lang) {
  const l = (lang || "").toLowerCase();
  const rules = [];
  const add = (cls, re) => rules.push([cls, re.source]);
  if (["bash", "sh", "shell", "console", "zsh"].includes(l)) {
    add("c", /(?:^|(?<=\s))#.*$/);
    add("s", /"(?:\\.|[^"\\])*"|'[^']*'/);
    add("v", /\$\{[^}]*\}|\$\(|\$[A-Za-z_][A-Za-z0-9_]*|\$[0-9?#@!$*-]/);
    add("p", /^(?:\$|#|[\w.-]+@[\w.-]+[:~][^$#\n]*[$#])\s/);
    add("f", /(?<=\s)--?[A-Za-z][\w-]*/);
    add("k", /\b(?:if|then|else|elif|fi|for|while|until|do|done|case|esac|function|in|return|local|export|set|trap|exit|sudo)\b/);
  } else if (["yaml", "yml"].includes(l)) {
    add("c", /(?:^|(?<=\s))#.*$/);
    add("s", /"(?:\\.|[^"\\])*"|'[^']*'/);
    add("t", /\{\{.*?\}\}|\{%.*?%\}/);
    add("k", /^\s*-?\s*[\w./-]+(?=\s*:(?:\s|$))/);
    add("n", /\b(?:true|false|yes|no|null)\b|(?<=[\s:-])-?\d+(?:\.\d+)?\b/);
  } else if (["hcl", "terraform", "tf"].includes(l)) {
    add("c", /(?:#|\/\/).*$/);
    add("s", /"(?:\\.|[^"\\])*"/);
    add("k", new RegExp(`\\b(?:${KW.hcl})\\b`));
    add("a", /^\s*[\w-]+(?=\s*=)/);
    add("n", /\b\d+(?:\.\d+)?\b/);
  } else if (l === "dockerfile") {
    add("c", /^\s*#.*$/);
    add("s", /"(?:\\.|[^"\\])*"|'[^']*'/);
    add("k", new RegExp(`^\\s*(?:${KW.docker})\\b|\\bAS\\b`));
    add("v", /\$\{[^}]*\}|\$[A-Za-z_]\w*/);
  } else if (l === "promql") {
    add("s", /"(?:\\.|[^"\\])*"/);
    add("k", new RegExp(`\\b(?:${KW.promql})\\b`));
    add("n", /\[\d+[smhdw]\]|\b\d+(?:\.\d+)?\b/);
  } else if (l === "nginx") {
    add("c", /#.*$/);
    add("s", /"(?:\\.|[^"\\])*"|'[^']*'/);
    add("k", new RegExp(`(?<=^\\s*)(?:${KW.nginx})\\b`));
    add("v", /\$[A-Za-z_]\w*/);
  } else if (KW[l]) {
    add("c", l === "sql" ? /--.*$/ : l === "python" ? /#.*$/ : /\/\/.*$/);
    add("s", /"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'/);
    add("k", new RegExp(`\\b(?:${KW[l]})\\b`));
    add("n", /\b\d+(?:\.\d+)?\b/);
  } else if (["ini", "conf", "toml", "properties", "systemd"].includes(l)) {
    add("c", /^\s*[#;].*$/);
    add("k", /^\s*\[[^\]]+\]/);
    add("a", /^\s*[\w.-]+(?=\s*=)/);
    add("s", /"(?:\\.|[^"\\])*"/);
  } else if (l === "json") {
    add("a", /"(?:\\.|[^"\\])*"(?=\s*:)/);
    add("s", /"(?:\\.|[^"\\])*"/);
    add("n", /\b(?:true|false|null)\b|-?\b\d+(?:\.\d+)?\b/);
  } else {
    return null;
  }
  return new RegExp(rules.map(([c, src], i) => `(?<${c}${i}>${src})`).join("|"), "gm");
}

function highlight(code, lang) {
  const re = lexer(lang);
  if (!re) return esc(code);
  // Подсветка построчно, чтобы ^/$ и комментарии вели себя предсказуемо.
  return code.split("\n").map((line) => {
    let out = "", last = 0;
    re.lastIndex = 0;
    for (const m of line.matchAll(re)) {
      if (!m[0]) continue;
      const cls = Object.entries(m.groups).find(([, v]) => v !== undefined)[0].replace(/\d+$/, "");
      out += esc(line.slice(last, m.index)) + `<span class="hl-${cls}">${esc(m[0])}</span>`;
      last = m.index + m[0].length;
    }
    return out + esc(line.slice(last));
  }).join("\n");
}

// ---------- markdown ----------

function inline(text) {
  const codes = [];
  let s = text.replace(/`([^`]+)`/g, (_, c) => { codes.push(c); return `\u0000${codes.length - 1}\u0000`; });
  s = esc(s)
    .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
    .replace(/(^|[\s(])\*(?!\s)(.+?)\*(?=[\s).,:;!?]|$)/g, "$1<em>$2</em>")
    .replace(/\[([^\]]+)\]\((https?:[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>')
    .replace(/\[([^\]]+)\]\((#[^)\s]+)\)/g, '<a href="$2">$1</a>')
    .replace(/(^|\s)(→|=&gt;)(\s)/g, "$1→$3");
  return s.replace(/\u0000(\d+)\u0000/g, (_, i) => `<code>${esc(codes[+i])}</code>`);
}

const CALLOUTS = { tip: "Совет", info: "Важно", warn: "Осторожно", danger: "Опасно", interview: "На собеседовании", example: "Пример" };

function renderList(lines, start) {
  // lines: [{indent, ordered, text}]
  const ordered = lines[start].ordered;
  const base = lines[start].indent;
  let html = ordered ? "<ol>" : "<ul>";
  let i = start;
  while (i < lines.length && lines[i].indent >= base) {
    if (lines[i].indent > base) {
      const [sub, next] = renderList(lines, i);
      html = html.replace(/<\/li>$/, sub + "</li>");
      i = next;
      continue;
    }
    html += `<li>${inline(lines[i].text)}</li>`;
    i++;
  }
  return [html + (ordered ? "</ol>" : "</ul>"), i];
}

function md(src) {
  const lines = src.replace(/\r/g, "").split("\n");
  let html = "", i = 0;
  const isBlockStart = (l) => /^(```|#{2,5} |\s*([-*]|\d+\.) |>|\|)/.test(l) || /^---+\s*$/.test(l);
  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) { i++; continue; }

    let m;
    if ((m = line.match(/^```\s*([\w+-]*)\s*(.*)$/))) {
      const lang = m[1], title = m[2];
      const body = [];
      i++;
      while (i < lines.length && !/^```\s*$/.test(lines[i])) body.push(lines[i++]);
      i++;
      const code = body.join("\n");
      html += `<div class="code"><div class="code-head"><span>${esc(title || lang || "text")}</span><button class="copy" type="button">Копировать</button></div><pre><code>${highlight(code, lang)}</code></pre></div>`;
      continue;
    }
    if ((m = line.match(/^(#{2,5}) (.*)$/))) {
      const lvl = Math.min(m[1].length + 1, 5);
      html += `<h${lvl}>${inline(m[2])}</h${lvl}>`;
      i++;
      continue;
    }
    if (/^---+\s*$/.test(line)) { html += "<hr>"; i++; continue; }
    if (line.startsWith(">")) {
      const body = [];
      while (i < lines.length && lines[i].startsWith(">")) body.push(lines[i++].replace(/^> ?/, ""));
      const head = body[0].match(/^\[!(\w+)\]\s*(.*)$/);
      if (head) {
        const kind = head[1].toLowerCase();
        const title = head[2] || CALLOUTS[kind] || kind;
        html += `<div class="callout callout-${kind}"><div class="callout-title">${inline(title)}</div>${md(body.slice(1).join("\n"))}</div>`;
      } else {
        html += `<blockquote>${md(body.join("\n"))}</blockquote>`;
      }
      continue;
    }
    if (line.startsWith("|")) {
      const rows = [];
      while (i < lines.length && lines[i].startsWith("|")) rows.push(lines[i++]);
      const cells = (r) => r.replace(/^\||\|\s*$/g, "").split(/(?<!\\)\|/).map((c) => inline(c.trim().replace(/\\\|/g, "|")));
      const head = cells(rows[0]);
      const body = rows.slice(/^\|[\s:|-]+\|?\s*$/.test(rows[1] || "") ? 2 : 1).map(cells);
      html += `<div class="table-wrap"><table><thead><tr>${head.map((c) => `<th>${c}</th>`).join("")}</tr></thead><tbody>${body.map((r) => `<tr>${r.map((c) => `<td>${c}</td>`).join("")}</tr>`).join("")}</tbody></table></div>`;
      continue;
    }
    if (/^\s*([-*]|\d+\.) /.test(line)) {
      const items = [];
      while (i < lines.length) {
        const l = lines[i];
        const lm = l.match(/^(\s*)([-*]|\d+\.) (.*)$/);
        if (lm) { items.push({ indent: lm[1].length, ordered: /\d/.test(lm[2]), text: lm[3] }); i++; continue; }
        if (l.trim() && /^\s{2,}\S/.test(l) && items.length) { items[items.length - 1].text += " " + l.trim(); i++; continue; }
        break;
      }
      html += renderList(items, 0)[0];
      continue;
    }
    const para = [];
    while (i < lines.length && lines[i].trim() && !isBlockStart(lines[i])) para.push(lines[i++]);
    if (!para.length) { para.push(line); i++; }
    html += `<p>${inline(para.join(" "))}</p>`;
  }
  return html;
}

// ---------- topic parsing ----------

// Разбивает текст по заголовкам заданного уровня, не заглядывая внутрь ``` блоков.
function splitBy(src, level) {
  const marker = "#".repeat(level) + " ";
  const parts = [];
  let cur = null, fence = false;
  const pre = [];
  for (const line of src.split("\n")) {
    if (/^```/.test(line)) fence = !fence;
    if (!fence && line.startsWith(marker)) {
      cur = { title: line.slice(marker.length).trim(), body: [] };
      parts.push(cur);
      continue;
    }
    (cur ? cur.body : pre).push(line);
  }
  return { pre: pre.join("\n"), parts: parts.map((p) => ({ title: p.title, body: p.body.join("\n").trim() })) };
}

function parseQuiz(src, topicId) {
  const items = [];
  let cur = null;
  for (const raw of src.split("\n")) {
    const line = raw.trimEnd();
    if (line.startsWith("? ")) { cur = { q: inline(line.slice(2)), options: [], answer: -1, explain: "" }; items.push(cur); continue; }
    if (!cur) continue;
    if (/^[+-] /.test(line)) {
      if (line[0] === "+") cur.answer = cur.options.length;
      cur.options.push(inline(line.slice(2)));
    } else if (line.startsWith("> ")) {
      cur.explain += (cur.explain ? " " : "") + line.slice(2);
    }
  }
  for (const q of items) {
    if (q.answer < 0) throw new Error(`[${topicId}] в вопросе квиза нет правильного ответа: ${q.q}`);
    q.explain = inline(q.explain);
  }
  return items;
}

function parseTopic(file) {
  const raw = readFileSync(join(CONTENT_DIR, file), "utf8").replace(/\r/g, "");
  const fm = raw.match(/^---\n([\s\S]*?)\n---\n/);
  if (!fm) throw new Error(`${file}: нет frontmatter`);
  const meta = Object.fromEntries(fm[1].split("\n").filter(Boolean).map((l) => {
    const k = l.slice(0, l.indexOf(":")).trim();
    return [k, l.slice(l.indexOf(":") + 1).trim().replace(/^"(.*)"$/, "$1")];
  }));
  const topic = {
    id: meta.id, title: meta.title, icon: meta.icon || "•", order: +meta.order || 99,
    group: meta.group || "Основа", summary: meta.summary || "", color: meta.color || "#5b8cff",
    theory: [], interview: [], troubleshooting: [], quiz: [],
  };
  const { parts } = splitBy(raw.slice(fm[0].length), 1);
  for (const part of parts) {
    const kind = part.title.replace(/^@/, "").toLowerCase();
    if (kind === "quiz") { topic.quiz = parseQuiz(part.body, topic.id); continue; }
    const { parts: items } = splitBy(part.body, 2);
    const seen = new Set();
    for (const it of items) {
      if (kind === "theory") {
        let id = slug(it.title);
        while (seen.has(id)) id += "-x";
        seen.add(id);
        topic.theory.push({ id, title: it.title, html: md(it.body), text: plain(it.body) });
      } else if (kind === "interview") {
        const lm = it.title.match(/^\[(junior|middle|senior)\]\s*(.*)$/i);
        const level = lm ? lm[1].toLowerCase() : "middle";
        const q = lm ? lm[2] : it.title;
        topic.interview.push({ id: topic.id + "-" + hash(q), level, q: inline(q), qText: plain(q), html: md(it.body), text: plain(it.body) });
      } else if (kind === "troubleshooting") {
        const lm = it.title.match(/^\[(\w+)\]\s*(.*)$/);
        const title = lm ? lm[2] : it.title;
        topic.troubleshooting.push({ id: topic.id + "-" + hash(title), severity: lm ? lm[1].toLowerCase() : "medium", title: inline(title), titleText: plain(title), html: md(it.body), text: plain(it.body) });
      } else {
        throw new Error(`${file}: неизвестный раздел "# ${part.title}"`);
      }
    }
  }
  return topic;
}

const files = readdirSync(CONTENT_DIR).filter((f) => f.endsWith(".md") && f !== "README.md");
const topics = files.map(parseTopic).sort((a, b) => a.order - b.order);

const ids = new Set();
for (const t of topics) {
  if (ids.has(t.id)) throw new Error(`дублирующийся id темы: ${t.id}`);
  ids.add(t.id);
}

const data = { version: pkg.version, builtAt: new Date().toISOString().slice(0, 10), topics };
writeFileSync(OUT, "/* Сгенерировано tools/build.mjs — не редактировать вручную. */\nwindow.DEVOPS_CONTENT = " + JSON.stringify(data) + ";\n");

const count = (k) => topics.reduce((n, t) => n + t[k].length, 0);
console.log(`v${pkg.version}: тем ${topics.length}, разделов ${count("theory")}, вопросов ${count("interview")}, кейсов ${count("troubleshooting")}, квиз ${count("quiz")}`);
console.log(`→ ${OUT} (${(JSON.stringify(data).length / 1024).toFixed(0)} KB)`);
