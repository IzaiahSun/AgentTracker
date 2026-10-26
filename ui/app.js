"use strict";

// Agents in fixed color-slot order; stacks follow this order so adjacent
// segments keep the palette's validated adjacent pairs.
const AGENTS = [
  { name: "Codex Desktop", slot: 1 },
  { name: "Claude Code Desktop", slot: 2 },
  { name: "OpenCode", slot: 3 },
  { name: "Claude Code CLI", slot: 4 },
  { name: "Claude Cowork", slot: 5 },
  { name: "DeepSeek Harness", slot: 6 },
  { name: "Codex CLI", slot: 7 },
  { name: "OpenClaw", slot: 8 },
  { name: "Claude Code SDK", slot: 0 },
  { name: "Codex IDE", slot: 0 },
];
const MODEL_SLOTS = 7;
const OTHER = "其他";

const METRICS = {
  total: (r) => r.input + r.output + r.cache_read + r.cache_write,
  nocache: (r) => r.input + r.output + r.cache_write,
  input: (r) => r.input,
  output: (r) => r.output,
  cache_read: (r) => r.cache_read,
  cache_write: (r) => r.cache_write,
};

const state = {
  report: null,
  range: 30, // days back from today; 0 = all; -1 = custom (from/to)
  from: null,
  to: null,
  groupBy: "agent",
  metric: "total",
  hidden: new Set(),
  loading: false,
};

const $ = (s) => document.querySelector(s);
const esc = (s) =>
  String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

function fmt(n) {
  const a = Math.abs(n);
  if (a >= 1e12) return (n / 1e12).toFixed(2) + "T";
  if (a >= 1e9) return (n / 1e9).toFixed(2) + "B";
  if (a >= 1e6) return (n / 1e6).toFixed(a >= 1e8 ? 0 : 1) + "M";
  if (a >= 1e3) return (n / 1e3).toFixed(a >= 1e5 ? 0 : 1) + "K";
  return String(Math.round(n));
}
const full = (n) => n.toLocaleString("en-US");

function slotColor(slot) {
  return slot ? `var(--s${slot})` : "var(--other)";
}
function agentSlot(name) {
  const a = AGENTS.find((x) => x.name === name);
  return a ? a.slot : 0;
}
function agentOrder(name) {
  const i = AGENTS.findIndex((x) => x.name === name);
  return i < 0 ? 99 : i;
}

// ---------- persistence (per-viewer convenience only) ----------
function loadPrefs() {
  try {
    const p = JSON.parse(localStorage.getItem("agenttracker.prefs") || "{}");
    if (typeof p.range === "number") state.range = p.range;
    if (p.groupBy) state.groupBy = p.groupBy;
    if (p.metric && METRICS[p.metric]) state.metric = p.metric;
    if (Array.isArray(p.hidden)) state.hidden = new Set(p.hidden);
    if (p.from && p.to) Object.assign(state, { from: p.from, to: p.to });
    if (state.range === -1 && !(state.from && state.to)) state.range = 30;
  } catch (_) {}
}
function savePrefs() {
  try {
    localStorage.setItem(
      "agenttracker.prefs",
      JSON.stringify({ range: state.range, from: state.from, to: state.to, groupBy: state.groupBy, metric: state.metric, hidden: [...state.hidden] })
    );
  } catch (_) {}
}

// ---------- dates ----------
function ymd(d) {
  const p = (x) => String(x).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}
function addDays(d, n) {
  const x = new Date(d);
  x.setDate(x.getDate() + n);
  return x;
}
function parseYmd(s) {
  const [y, m, d] = s.split("-").map(Number);
  return new Date(y, m - 1, d);
}
function todayDate() {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d;
}
function earliestDate() {
  let min = null;
  for (const r of state.report.rows) if (r.date !== "unknown" && (!min || r.date < min)) min = r.date;
  return min ? parseYmd(min) : todayDate();
}
/// [start, end] of the selected range as local dates.
function rangeBounds() {
  const today = todayDate();
  if (state.range === -1) {
    let a = parseYmd(state.from), b = parseYmd(state.to);
    if (a > b) [a, b] = [b, a];
    return [a, b];
  }
  if (state.range > 0) return [addDays(today, -(state.range - 1)), today];
  return [earliestDate(), today];
}
function dateList() {
  const [start, end] = rangeBounds();
  const out = [];
  for (let d = start; d <= end; d = addDays(d, 1)) out.push(ymd(d));
  return out;
}

// ---------- data ----------
async function fetchReport() {
  if (window.__TAURI__) return window.__TAURI__.core.invoke("get_report");
  // Browser preview fallback: serve a dump from `agent-tracker --report`.
  const res = await fetch("sample-report.json");
  return res.json();
}

async function refresh() {
  if (state.loading) return;
  state.loading = true;
  $("#refresh").disabled = true;
  $("#status").textContent = "正在扫描…";
  try {
    state.report = await fetchReport();
    const t = new Date(state.report.generated_at);
    $("#status").textContent = `更新于 ${t.toLocaleTimeString()} · 扫描 ${state.report.scan_ms} ms`;
    render();
  } catch (e) {
    $("#status").textContent = "扫描失败：" + e;
  } finally {
    state.loading = false;
    $("#refresh").disabled = false;
  }
}

function visibleRows() {
  const days = new Set(dateList());
  return state.report.rows.filter((r) => days.has(r.date) && !state.hidden.has(r.agent));
}

/// Model -> color slot, ranked by all-time total so colors never repaint
/// when the range or filters change.
function modelSlots() {
  const tot = new Map();
  for (const r of state.report.rows) tot.set(r.model, (tot.get(r.model) || 0) + METRICS.total(r));
  const ranked = [...tot.entries()].sort((a, b) => b[1] - a[1]).map((x) => x[0]);
  const m = new Map();
  ranked.forEach((name, i) => m.set(name, i < MODEL_SLOTS ? i + 1 : 0));
  return m;
}

// ---------- rendering ----------
function syncDateInputs() {
  const [a, b] = rangeBounds();
  const from = $("#from"), to = $("#to");
  from.value = ymd(a);
  to.value = ymd(b);
  from.min = to.min = ymd(earliestDate());
  from.max = to.max = ymd(todayDate());
  $(".daterange").classList.toggle("on", state.range === -1);
}

function render() {
  if (!state.report) return;
  syncDateInputs();
  renderChips();
  const rows = visibleRows();
  renderTiles(rows);
  renderChart(rows);
  renderAgentCards(rows);
  renderDetail(rows);
  renderSources();
}

function renderChips() {
  const tot = new Map();
  for (const r of state.report.rows) tot.set(r.agent, (tot.get(r.agent) || 0) + 1);
  const names = [...tot.keys()].sort((a, b) => agentOrder(a) - agentOrder(b));
  $("#agents").innerHTML = names
    .map(
      (n) => `<button class="chip ${state.hidden.has(n) ? "off" : ""}" data-agent="${esc(n)}" aria-pressed="${!state.hidden.has(n)}">
        <span class="dot" style="background:${slotColor(agentSlot(n))}"></span>${esc(n)}</button>`
    )
    .join("");
}

function renderTiles(rows) {
  const m = METRICS[state.metric];
  const days = dateList();
  const today = days[days.length - 1];
  const yesterday = ymd(addDays(parseYmd(today), -1));
  let total = 0, todayV = 0, yestV = 0, req = 0, cr = 0, inAll = 0;
  const byModel = new Map();
  for (const r of rows) {
    const v = m(r);
    total += v;
    req += r.requests;
    if (r.date === today) todayV += v;
    byModel.set(r.model, (byModel.get(r.model) || 0) + v);
    cr += r.cache_read;
    inAll += r.input + r.cache_read + r.cache_write;
  }
  for (const r of state.report.rows) if (r.date === yesterday && !state.hidden.has(r.agent)) yestV += m(r);
  const top = [...byModel.entries()].sort((a, b) => b[1] - a[1])[0];
  const delta = yestV ? ((todayV - yestV) / yestV) * 100 : null;
  const tiles = [
    { label: "区间总量", value: fmt(total), hint: `${days[0]} 起 ${days.length} 天 · 日均 ${fmt(total / Math.max(days.length, 1))}`, title: full(total) },
    {
      label: today === ymd(todayDate()) ? "今天" : `${today}（区间最后一天）`,
      value: fmt(todayV),
      hint: delta === null ? `昨天 ${fmt(yestV)}` : `较昨天 ${delta >= 0 ? "+" : ""}${delta.toFixed(0)}%（${fmt(yestV)}）`,
      title: full(todayV),
    },
    { label: "请求数", value: fmt(req), hint: "模型调用次数", title: full(req) },
    { label: "缓存命中率", value: inAll ? ((cr / inAll) * 100).toFixed(1) + "%" : "—", hint: "缓存读取 / 全部输入" },
    {
      label: "用量最多的模型",
      value: top ? esc(top[0]) : "—",
      hint: top && total ? `占 ${((top[1] / total) * 100).toFixed(1)}%` : "",
      small: true,
    },
  ];
  $("#tiles").innerHTML = tiles
    .map(
      (t) => `<div class="tile" ${t.title ? `title="${t.title}"` : ""}><div class="label">${t.label}</div>
        <div class="value" ${t.small ? 'style="font-size:17px;padding-top:5px"' : ""}>${t.value}</div>
        <div class="hint">${t.hint}</div></div>`
    )
    .join("");
}

/// Builds per-day stacks: [{date, segs:[{key, slot, v}], sum}]; keys sorted by range total.
function buildSeries(rows) {
  const m = METRICS[state.metric];
  const days = dateList();
  let keyOf, slotOf;
  if (state.groupBy === "agent") {
    keyOf = (r) => (agentSlot(r.agent) ? r.agent : OTHER);
    slotOf = (k) => (k === OTHER ? 0 : agentSlot(k));
  } else {
    const ms = modelSlots();
    keyOf = (r) => (ms.get(r.model) ? r.model : OTHER);
    slotOf = (k) => (k === OTHER ? 0 : ms.get(k));
  }
  const byDay = new Map(days.map((d) => [d, new Map()]));
  const keyTotals = new Map();
  for (const r of rows) {
    const day = byDay.get(r.date);
    if (!day) continue;
    const k = keyOf(r);
    const v = m(r);
    day.set(k, (day.get(k) || 0) + v);
    keyTotals.set(k, (keyTotals.get(k) || 0) + v);
  }
  // Largest total first (bottom of the stack, first in the legend); "Other" last.
  const keys = [...keyTotals.keys()]
    .filter((k) => keyTotals.get(k) > 0)
    .sort((a, b) => (a === OTHER) - (b === OTHER) || keyTotals.get(b) - keyTotals.get(a));
  const stacks = days.map((d) => {
    const day = byDay.get(d);
    const segs = keys.map((k) => ({ key: k, slot: slotOf(k), v: day.get(k) || 0 }));
    return { date: d, segs, sum: segs.reduce((s, x) => s + x.v, 0) };
  });
  return { keys: keys.map((k) => ({ key: k, slot: slotOf(k), total: keyTotals.get(k) })), stacks };
}

function niceMax(v) {
  if (v <= 0) return 1;
  const p = Math.pow(10, Math.floor(Math.log10(v)));
  for (const s of [1, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10]) if (s * p >= v) return s * p;
  return 10 * p;
}

function renderChart(rows) {
  const { keys, stacks } = buildSeries(rows);
  $("#legend").innerHTML = keys
    .map((k) => `<span><i style="background:${slotColor(k.slot)}"></i>${esc(k.key)} <b>${fmt(k.total)}</b></span>`)
    .join("");

  const el = $("#chart");
  const W = el.clientWidth || 800;
  const H = el.clientHeight || 300;
  const pad = { l: 48, r: 8, t: 8, b: 24 };
  const iw = W - pad.l - pad.r;
  const ih = H - pad.t - pad.b;
  const max = niceMax(Math.max(0, ...stacks.map((s) => s.sum)));
  const y = (v) => pad.t + ih - (v / max) * ih;
  const n = stacks.length;
  const band = iw / n;
  const bw = Math.max(2, Math.min(36, band * 0.68));

  let svg = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="每日 token 用量堆叠柱状图">`;
  for (let i = 0; i <= 4; i++) {
    const v = (max / 4) * i;
    const yy = y(v);
    svg += `<line class="${i === 0 ? "baseline" : "gridline"}" x1="${pad.l}" x2="${W - pad.r}" y1="${yy}" y2="${yy}"/>`;
    svg += `<text class="tick" x="${pad.l - 8}" y="${yy + 4}" text-anchor="end">${fmt(v)}</text>`;
  }
  const labelEvery = Math.ceil(n / Math.max(1, Math.floor(iw / 64)));
  stacks.forEach((s, i) => {
    const cx = pad.l + band * i + band / 2;
    const x = cx - bw / 2;
    let acc = 0;
    const live = s.segs.filter((g) => g.v > 0);
    live.forEach((g, j) => {
      const y0 = y(acc);
      acc += g.v;
      const y1 = y(acc);
      // 2px surface gap between stacked segments.
      const gap = j > 0 ? 1 : 0;
      const top = y1 + (j < live.length - 1 ? 1 : 0);
      const h = Math.max(0, y0 - gap - top);
      if (h <= 0) return;
      const r = j === live.length - 1 ? Math.min(4, bw / 2, h) : 0;
      svg += r
        ? `<path fill="${slotColor(g.slot)}" d="M${x},${y0 - gap} V${top + r} Q${x},${top} ${x + r},${top} H${x + bw - r} Q${x + bw},${top} ${x + bw},${top + r} V${y0 - gap} Z"/>`
        : `<rect fill="${slotColor(g.slot)}" x="${x}" y="${top}" width="${bw}" height="${h}"/>`;
    });
    if (i % labelEvery === 0 || i === n - 1) {
      if (i === n - 1 || n - 1 - i >= labelEvery / 2) {
        svg += `<text class="tick" x="${cx}" y="${H - 6}" text-anchor="middle">${s.date.slice(5)}</text>`;
      }
    }
    svg += `<rect class="hit" data-i="${i}" x="${pad.l + band * i}" y="${pad.t}" width="${band}" height="${ih}"/>`;
  });
  if (!stacks.some((s) => s.sum > 0)) {
    svg += `<text class="empty" x="${pad.l + iw / 2}" y="${pad.t + ih / 2}" text-anchor="middle">所选范围内没有数据</text>`;
  }
  svg += "</svg>";
  el.innerHTML = svg;
  el._stacks = stacks;
}

function showTooltip(ev, s) {
  const tip = $("#tooltip");
  const segs = s.segs.filter((g) => g.v > 0).sort((a, b) => b.v - a.v);
  tip.innerHTML =
    `<div class="t">${s.date}</div>` +
    (segs.length
      ? segs
          .map((g) => `<div class="row"><span><i style="background:${slotColor(g.slot)}"></i>${esc(g.key)}</span><b>${fmt(g.v)}</b></div>`)
          .join("") + `<div class="row sum"><span>合计</span><b>${full(s.sum)}</b></div>`
      : `<div class="muted">无用量</div>`);
  tip.hidden = false;
  const r = tip.getBoundingClientRect();
  let left = ev.clientX + 14;
  if (left + r.width > window.innerWidth - 8) left = ev.clientX - r.width - 14;
  let top = ev.clientY + 14;
  if (top + r.height > window.innerHeight - 8) top = window.innerHeight - r.height - 8;
  tip.style.left = left + "px";
  tip.style.top = top + "px";
}

function renderAgentCards(rows) {
  const m = METRICS[state.metric];
  const agents = new Map();
  for (const r of rows) {
    let a = agents.get(r.agent);
    if (!a) agents.set(r.agent, (a = { total: 0, requests: 0, models: new Map() }));
    const v = m(r);
    a.total += v;
    a.requests += r.requests;
    let mm = a.models.get(r.model);
    if (!mm) a.models.set(r.model, (mm = { v: 0, requests: 0, input: 0, output: 0, cache_read: 0, cache_write: 0 }));
    mm.v += v;
    mm.requests += r.requests;
    mm.input += r.input;
    mm.output += r.output;
    mm.cache_read += r.cache_read;
    mm.cache_write += r.cache_write;
  }
  const list = [...agents.entries()].sort((a, b) => b[1].total - a[1].total);
  if (!list.length) {
    $("#agentCards").innerHTML = `<div class="muted">所选范围内没有数据</div>`;
    return;
  }
  $("#agentCards").innerHTML = list
    .map(([name, a]) => {
      const models = [...a.models.entries()].sort((x, y) => y[1].v - x[1].v);
      const body = models
        .map(
          ([model, x]) => `<tr><td><span class="model-name" title="${esc(model)}">${esc(model)}</span>
            <div class="bar"><b style="width:${a.total ? (x.v / a.total) * 100 : 0}%;background:${slotColor(agentSlot(name))}"></b></div></td>
            <td title="${full(x.requests)}">${fmt(x.requests)}</td>
            <td title="${full(x.input)}">${fmt(x.input)}</td>
            <td title="${full(x.output)}">${fmt(x.output)}</td>
            <td title="${full(x.cache_read)}">${fmt(x.cache_read)}</td>
            <td title="${full(x.cache_write)}">${fmt(x.cache_write)}</td>
            <td title="${full(x.v)}"><b>${fmt(x.v)}</b></td></tr>`
        )
        .join("");
      return `<article class="agent-card">
        <header><h3><i style="background:${slotColor(agentSlot(name))}"></i>${esc(name)}</h3>
          <span><span class="total" title="${full(a.total)}">${fmt(a.total)}</span> <span class="muted">· ${fmt(a.requests)} 次</span></span></header>
        <table class="mini"><thead><tr><th>模型</th><th>请求</th><th>输入</th><th>输出</th><th>缓存读</th><th>缓存写</th><th>合计</th></tr></thead>
        <tbody>${body}</tbody></table></article>`;
    })
    .join("");
}

function renderDetail(rows) {
  const m = METRICS[state.metric];
  const sorted = [...rows].sort(
    (a, b) => b.date.localeCompare(a.date) || agentOrder(a.agent) - agentOrder(b.agent) || m(b) - m(a)
  );
  const LIMIT = 1500;
  let html = "";
  let cur = null;
  const dayTotals = new Map();
  for (const r of sorted) dayTotals.set(r.date, (dayTotals.get(r.date) || 0) + m(r));
  for (const r of sorted.slice(0, LIMIT)) {
    if (r.date !== cur) {
      cur = r.date;
      html += `<tr class="day"><td colspan="8">${r.date}</td><td class="num" title="${full(dayTotals.get(r.date))}">${fmt(dayTotals.get(r.date))}</td></tr>`;
    }
    html += `<tr><td></td><td><span class="dot-inline" style="color:${slotColor(agentSlot(r.agent))}">●</span> ${esc(r.agent)}</td><td>${esc(r.model)}</td>
      <td class="num">${full(r.requests)}</td><td class="num">${full(r.input)}</td><td class="num">${full(r.output)}</td>
      <td class="num">${full(r.cache_read)}</td><td class="num">${full(r.cache_write)}</td><td class="num"><b>${full(m(r))}</b></td></tr>`;
  }
  $("#detail tbody").innerHTML = html || `<tr><td colspan="9" class="muted">所选范围内没有数据</td></tr>`;
  $("#detailCount").textContent = `${sorted.length} 行${sorted.length > LIMIT ? `（显示前 ${LIMIT}）` : ""} · “合计”列按当前口径`;
}

const DEFAULT_PATHS = {
  OpenClaw: "~/.openclaw/agents（或 $OPENCLAW_DIR）",
  "DeepSeek Harness": "~/.dsh/sessions（或 $DSH_HOME）",
  OpenCode: "~/.local/share/opencode",
  Codex: "~/.codex/sessions（或 $CODEX_HOME）",
  "Claude Code": "~/.claude/projects（或 $CLAUDE_CONFIG_DIR）",
};

function renderSources() {
  $("#sources").innerHTML = state.report.sources
    .map(
      (s) => `<div class="source"><span class="state ${s.found ? "ok" : "no"}">${s.found ? `✓ ${full(s.events)} 条请求` : "未找到数据目录"}</span>
        <b>${esc(s.agent)}</b>
        ${s.paths.map((p) => `<div class="path">${esc(p)}</div>`).join("") || `<div class="path">${esc(DEFAULT_PATHS[s.agent] || "—")}</div>`}
        ${s.errors.map((e) => `<div class="err">${esc(e)}</div>`).join("")}</div>`
    )
    .join("");
}

// ---------- events ----------
function bindSeg(sel, key, parse) {
  const root = $(sel);
  const sync = () => root.querySelectorAll("button").forEach((b) => b.classList.toggle("on", parse(b.dataset.v) === state[key]));
  root.addEventListener("click", (e) => {
    const b = e.target.closest("button");
    if (!b) return;
    state[key] = parse(b.dataset.v);
    sync();
    savePrefs();
    render();
  });
  sync();
}

function init() {
  loadPrefs();
  bindSeg("#range", "range", Number);
  const onDate = () => {
    const f = $("#from").value, t = $("#to").value;
    if (!f || !t) return;
    Object.assign(state, { range: -1, from: f, to: t });
    $("#range").querySelectorAll("button").forEach((b) => b.classList.remove("on"));
    savePrefs();
    render();
  };
  $("#from").addEventListener("change", onDate);
  $("#to").addEventListener("change", onDate);
  bindSeg("#groupBy", "groupBy", String);
  $("#metric").value = state.metric;
  $("#metric").addEventListener("change", (e) => {
    state.metric = e.target.value;
    savePrefs();
    render();
  });
  $("#agents").addEventListener("click", (e) => {
    const b = e.target.closest(".chip");
    if (!b) return;
    const n = b.dataset.agent;
    state.hidden.has(n) ? state.hidden.delete(n) : state.hidden.add(n);
    savePrefs();
    render();
  });
  $("#refresh").addEventListener("click", refresh);

  const chart = $("#chart");
  chart.addEventListener("mousemove", (e) => {
    const hit = e.target.closest(".hit");
    if (!hit || !chart._stacks) return ($("#tooltip").hidden = true);
    showTooltip(e, chart._stacks[Number(hit.dataset.i)]);
  });
  chart.addEventListener("mouseleave", () => ($("#tooltip").hidden = true));
  let rt;
  new ResizeObserver(() => {
    clearTimeout(rt);
    rt = setTimeout(() => state.report && renderChart(visibleRows()), 80);
  }).observe(chart);

  // Rescan periodically and whenever the window regains focus.
  setInterval(() => document.visibilityState === "visible" && refresh(), 120000);
  window.addEventListener("focus", () => {
    if (state.report && Date.now() - new Date(state.report.generated_at).getTime() > 30000) refresh();
  });
  refresh();
}

init();
