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
// Internal key for the folded series; shown as t("other").
const OTHER = "__other__";

const METRICS = {
  total: (r) => r.input + r.output + r.cache_read + r.cache_write,
  nocache: (r) => r.input + r.output + r.cache_write,
  input: (r) => r.input,
  output: (r) => r.output,
  cache_read: (r) => r.cache_read,
  cache_write: (r) => r.cache_write,
  cost: (r) => costOf(r),
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
// Formatters for values of the selected metric (tokens, or USD for "cost").
const fv = (v) => (state.metric === "cost" ? money(v) : fmt(v));
const fvFull = (v) => (state.metric === "cost" ? moneyFull(v) : full(Math.round(v)));

/// Display name for a series key.
const label = (k) => (k === OTHER ? t("other") : k);

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
  // Browser preview only (repo root served over http, page at /ui/): a dump from
  // `agent-tracker --report` in dev/, never inside ui/ (it would be bundled).
  const file = new URLSearchParams(location.search).get("data") || "sample-report.json";
  const res = await fetch("../dev/" + file.replace(/[^\w.-]/g, ""));
  return res.json();
}

async function refresh() {
  if (state.loading) return;
  state.loading = true;
  $("#refresh").disabled = true;
  $("#status").textContent = t("scanning");
  try {
    state.report = await fetchReport();
    const at = new Date(state.report.generated_at);
    $("#status").textContent = t("updated", { time: at.toLocaleTimeString(LANG === "zh" ? "zh-CN" : "en-US"), ms: state.report.scan_ms });
    render();
  } catch (e) {
    $("#status").textContent = t("scanFailed", { err: e });
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
  renderRecords();
  renderHeatmap();
  renderChart(rows);
  renderProjects(rows);
  renderRhythm();
  renderAgentCards(rows);
  renderDetail(rows);
  renderSources();
  updateTray();
}

function renderChips() {
  // All-time token totals, largest first; independent of the filter so chips don't jump.
  const tot = new Map();
  for (const r of state.report.rows) tot.set(r.agent, (tot.get(r.agent) || 0) + METRICS.total(r));
  const names = [...tot.keys()].sort((a, b) => tot.get(b) - tot.get(a));
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
  let total = 0, todayV = 0, yestV = 0, req = 0, cr = 0, inAll = 0, cost = 0, saved = 0;
  const byModel = new Map();
  for (const r of rows) {
    const v = m(r);
    total += v;
    req += r.requests;
    if (r.date === today) todayV += v;
    byModel.set(r.model, (byModel.get(r.model) || 0) + v);
    cr += r.cache_read;
    inAll += r.input + r.cache_read + r.cache_write;
    cost += costOf(r);
    saved += cacheSavingsOf(r);
  }
  for (const r of state.report.rows) if (r.date === yesterday && !state.hidden.has(r.agent)) yestV += m(r);
  const top = [...byModel.entries()].sort((a, b) => b[1] - a[1])[0];
  const delta = yestV ? ((todayV - yestV) / yestV) * 100 : null;
  // Subscription cost prorated over the range, for the "pays for itself N×" hint.
  const plan = planMonthly * (days.length / 30.44);
  const tiles = [
    {
      label: t("tileTotal"),
      value: fv(total),
      hint: t("tileTotalHint", { start: days[0], days: days.length, avg: fv(total / Math.max(days.length, 1)) }),
      title: fvFull(total),
    },
    {
      label: today === ymd(todayDate()) ? t("tileToday") : t("tileLastDay", { date: today }),
      value: fv(todayV),
      hint:
        delta === null
          ? t("prevDay", { prev: fv(yestV) })
          : t("vsYesterday", { sign: delta >= 0 ? "+" : "", pct: delta.toFixed(0), prev: fv(yestV) }),
      title: fvFull(todayV),
    },
    {
      label: t("tileCost"),
      value: money(cost),
      hint: plan > 0 ? t("tileCostPlan", { x: (cost / plan).toFixed(1), plan: money(plan) }) : t("tileCostHint"),
      title: moneyFull(cost),
    },
    { label: t("tileRequests"), value: fmt(req), hint: t("tileRequestsHint"), title: full(req) },
    {
      label: t("tileCacheHit"),
      value: inAll ? ((cr / inAll) * 100).toFixed(1) + "%" : "—",
      hint: saved > 0 ? t("tileCacheSaved", { v: money(saved) }) : t("tileCacheHitHint"),
      title: t("tileCacheHitHint"),
    },
    {
      label: t("tileTopModel"),
      value: top ? esc(top[0]) : "—",
      hint: top && total ? t("tileTopModelHint", { pct: ((top[1] / total) * 100).toFixed(1) }) : "",
      small: true,
    },
  ];
  $("#tiles").innerHTML = tiles
    .map(
      (t) => `<div class="tile" ${t.title ? `title="${esc(t.title)}"` : ""}><div class="label">${t.label}</div>
        <div class="value" ${t.small ? 'style="font-size:17px;padding-top:5px"' : ""}>${t.value}</div>
        <div class="hint">${t.hint}</div></div>`
    )
    .join("");
}

/// GitHub-style calendar of the past year (Monday-first weeks). Follows the
/// agent filter and metric, not the date range; selected-range days are outlined.
function renderHeatmap() {
  const m = METRICS[state.metric];
  const perDay = new Map();
  for (const r of state.report.rows) {
    if (state.hidden.has(r.agent)) continue;
    const d = perDay.get(r.date) || { v: 0, req: 0 };
    d.v += m(r);
    d.req += r.requests;
    perDay.set(r.date, d);
  }
  const today = todayDate();
  const start = addDays(today, -364);
  start.setDate(start.getDate() - ((start.getDay() + 6) % 7)); // back to Monday
  const days = [];
  for (let d = new Date(start); d <= today; d = addDays(d, 1)) days.push(new Date(d));

  // Quartiles of non-zero days -> levels 1..4.
  const vals = days.map((d) => (perDay.get(ymd(d)) || { v: 0 }).v).filter((v) => v > 0).sort((a, b) => a - b);
  const q = (p) => vals[Math.min(vals.length - 1, Math.floor(p * vals.length))] || 0;
  const t1 = q(0.25), t2 = q(0.5), t3 = q(0.75);
  const level = (v) => (v <= 0 ? 0 : v <= t1 ? 1 : v <= t2 ? 2 : v <= t3 ? 3 : 4);

  const [ra, rb] = rangeBounds().map(ymd);
  const el = $("#heatmap");
  const weeks = Math.ceil(days.length / 7);
  const G = 3, L = 28, T = 16;
  // Cells grow to fill the card, between 10px and 20px.
  const C = Math.max(10, Math.min(20, Math.floor((el.clientWidth - L) / weeks - G)));
  const W = L + weeks * (C + G), H = T + 7 * (C + G);
  let svg = `<svg width="${W}" height="${H}" role="img" aria-label="${t("heatAria")}">`;
  [1, 3, 5].forEach((wd) => {
    svg += `<text class="lbl" x="0" y="${T + (wd - 1) * (C + G) + C - 2}">${t("weekdays")[wd]}</text>`;
  });
  let lastMonth = -1, lastLabelX = -99;
  let total = 0, active = 0;
  days.forEach((d, i) => {
    const w = Math.floor(i / 7), wd = i % 7;
    const x = L + w * (C + G), y = T + wd * (C + G);
    if (wd === 0 && d.getMonth() !== lastMonth) {
      lastMonth = d.getMonth();
      if (x - lastLabelX > 28) {
        svg += `<text class="lbl" x="${x}" y="10">${t("months")[d.getMonth()]}</text>`;
        lastLabelX = x;
      }
    }
    const key = ymd(d);
    const v = (perDay.get(key) || { v: 0 }).v;
    total += v;
    if (v > 0) active++;
    const sel = key >= ra && key <= rb ? " sel" : "";
    svg += `<rect class="cell${sel}" data-d="${key}" x="${x}" y="${y}" width="${C}" height="${C}" fill="var(--h${level(v)})"/>`;
  });
  svg += "</svg>";
  const keepRight = el.scrollLeft + el.clientWidth >= el.scrollWidth - 4;
  el.innerHTML = svg;
  el._perDay = perDay;
  if (keepRight) el.scrollLeft = el.scrollWidth;
  $("#heatSummary").textContent = t("heatSummary", { total: fv(total), days: active });
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
    .map((k) => `<span><i style="background:${slotColor(k.slot)}"></i>${esc(label(k.key))} <b>${fv(k.total)}</b></span>`)
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

  let svg = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="${t("chartAria")}">`;
  for (let i = 0; i <= 4; i++) {
    const v = (max / 4) * i;
    const yy = y(v);
    svg += `<line class="${i === 0 ? "baseline" : "gridline"}" x1="${pad.l}" x2="${W - pad.r}" y1="${yy}" y2="${yy}"/>`;
    svg += `<text class="tick" x="${pad.l - 8}" y="${yy + 4}" text-anchor="end">${fv(v)}</text>`;
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
    svg += `<text class="empty" x="${pad.l + iw / 2}" y="${pad.t + ih / 2}" text-anchor="middle">${t("noData")}</text>`;
  }
  svg += "</svg>";
  el.innerHTML = svg;
  el._stacks = stacks;
}

function showTooltip(ev, s) {
  const segs = s.segs.filter((g) => g.v > 0).sort((a, b) => b.v - a.v);
  showTip(
    ev,
    `<div class="t">${s.date}</div>` +
      (segs.length
        ? segs
            .map((g) => `<div class="row"><span><i style="background:${slotColor(g.slot)}"></i>${esc(label(g.key))}</span><b>${fv(g.v)}</b></div>`)
            .join("") + `<div class="row sum"><span>${t("total")}</span><b>${fvFull(s.sum)}</b></div>`
        : `<div class="muted">${t("noUsage")}</div>`)
  );
}

/// Shows the shared tooltip near the pointer, kept inside the viewport.
function showTip(ev, html) {
  const tip = $("#tooltip");
  tip.innerHTML = html;
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
    $("#agentCards").innerHTML = `<div class="muted">${t("noData")}</div>`;
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
            <td title="${fvFull(x.v)}"><b>${fv(x.v)}</b></td></tr>`
        )
        .join("");
      return `<article class="agent-card">
        <header><h3><i style="background:${slotColor(agentSlot(name))}"></i>${esc(name)}</h3>
          <span><span class="total" title="${fvFull(a.total)}">${fv(a.total)}</span> <span class="muted">· ${t("calls", { n: fmt(a.requests) })}</span></span></header>
        <table class="mini"><thead><tr><th>${t("model")}</th><th>${t("requests")}</th><th>${t("input")}</th><th>${t("output")}</th><th>${t("cacheRead")}</th><th>${t("cacheWrite")}</th><th>${t("total")}</th></tr></thead>
        <tbody>${body}</tbody></table></article>`;
    })
    .join("");
}

function renderDetail(rows) {
  const m = METRICS[state.metric];
  // Rows are per project; the detail table is per (day, agent, model).
  const merged = new Map();
  for (const r of rows) {
    const k = r.date + "\u0000" + r.agent + "\u0000" + r.model;
    const x = merged.get(k);
    if (!x) merged.set(k, { ...r });
    else for (const f of ["requests", "input", "output", "cache_read", "cache_write", "reasoning"]) x[f] += r[f] || 0;
  }
  const sorted = [...merged.values()].sort(
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
      html += `<tr class="day"><td colspan="8">${r.date}</td><td class="num" title="${fvFull(dayTotals.get(r.date))}">${fv(dayTotals.get(r.date))}</td></tr>`;
    }
    html += `<tr><td></td><td><span class="dot-inline" style="color:${slotColor(agentSlot(r.agent))}">●</span> ${esc(r.agent)}</td><td>${esc(r.model)}</td>
      <td class="num">${full(r.requests)}</td><td class="num">${full(r.input)}</td><td class="num">${full(r.output)}</td>
      <td class="num">${full(r.cache_read)}</td><td class="num">${full(r.cache_write)}</td><td class="num"><b>${fvFull(m(r))}</b></td></tr>`;
  }
  $("#detail tbody").innerHTML = html || `<tr><td colspan="9" class="muted">${t("noData")}</td></tr>`;
  $("#detailCount").textContent =
    t("detailCount", { n: sorted.length }) + (sorted.length > LIMIT ? t("detailLimited", { limit: LIMIT }) : "") + t("detailNote");
}

// Where each collector looks by default, shown when nothing was found.
const DEFAULT_PATHS = {
  OpenClaw: ["~/.openclaw/agents", "$OPENCLAW_DIR"],
  "DeepSeek Harness": ["~/.dsh/sessions", "$DSH_HOME"],
  OpenCode: ["~/.local/share/opencode", null],
  Codex: ["~/.codex/sessions", "$CODEX_HOME"],
  "Claude Code": ["~/.claude/projects", "$CLAUDE_CONFIG_DIR"],
};
function defaultPath(agent) {
  const d = DEFAULT_PATHS[agent];
  if (!d) return "—";
  return d[1] ? `${d[0]} (${t("orEnv", { env: d[1] })})` : d[0];
}

function renderSources() {
  $("#sources").innerHTML = state.report.sources
    .map(
      (s) => `<div class="source"><span class="state ${s.found ? "ok" : "no"}">${s.found ? t("sourceFound", { n: full(s.events) }) : t("sourceMissing")}</span>
        <b>${esc(s.agent)}</b>
        ${s.paths.map((p) => `<div class="path">${esc(p)}</div>`).join("") || `<div class="path">${esc(defaultPath(s.agent))}</div>`}
        ${s.errors.map((e) => `<div class="err">${esc(e)}</div>`).join("")}</div>`
    )
    .join("");
}

// ---------- updates ----------
let pendingUpdate = null;

async function checkForUpdate() {
  if (!window.__TAURI__ || pendingUpdate) return;
  try {
    const info = await window.__TAURI__.core.invoke("check_update");
    if (!info) return;
    pendingUpdate = info;
    $("#updateText").textContent = t("updateAvailable", { version: info.version, current: info.current });
    $("#updateBar").hidden = false;
  } catch (_) {
    // Offline or GitHub unreachable: try again on the next interval.
  }
}

async function installUpdate() {
  $("#updateNow").disabled = $("#updateLater").disabled = true;
  $("#updateText").textContent = t("updating", { version: pendingUpdate.version });
  try {
    await window.__TAURI__.core.invoke("install_update"); // restarts on success
  } catch (e) {
    $("#updateText").textContent = t("updateFailed", { err: e });
    $("#updateNow").disabled = $("#updateLater").disabled = false;
  }
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

async function init() {
  LANG = await detectLang();
  applyStaticStrings();
  loadPrefs();
  loadPrices();
  bindInsights();
  bindPrices();
  bindShare();
  bindTray();
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

  const heat = $("#heatmap");
  heat.addEventListener("mousemove", (e) => {
    const c = e.target.closest("rect.cell");
    if (!c) return ($("#tooltip").hidden = true);
    const key = c.dataset.d;
    const d = heat._perDay.get(key) || { v: 0, req: 0 };
    showTip(e, `<div class="t">${key} ${t("tipWeekday", { d: t("weekdays")[parseYmd(key).getDay()] })}</div>
      <div class="row"><span>${t(state.metric === "cost" ? "cost" : "tokens")}</span><b>${fvFull(d.v)}</b></div>
      <div class="row"><span>${t("requests")}</span><b>${full(d.req)}</b></div>`);
  });
  heat.addEventListener("mouseleave", () => ($("#tooltip").hidden = true));
  heat.addEventListener("click", (e) => {
    const c = e.target.closest("rect.cell");
    if (!c) return;
    Object.assign(state, { range: -1, from: c.dataset.d, to: c.dataset.d });
    $("#range").querySelectorAll("button").forEach((b) => b.classList.remove("on"));
    savePrefs();
    render();
  });

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
    rt = setTimeout(() => {
      if (!state.report) return;
      renderChart(visibleRows());
      renderHeatmap();
      renderRhythm();
    }, 80);
  }).observe(chart);

  $("#updateNow").addEventListener("click", installUpdate);
  // "Later" hides the banner for this session; the version is not re-offered until relaunch.
  $("#updateLater").addEventListener("click", () => ($("#updateBar").hidden = true));
  setTimeout(checkForUpdate, 3000);
  setInterval(checkForUpdate, 6 * 3600 * 1000);

  // Rescan periodically (also while hidden, to keep the menu bar current) and on focus.
  setInterval(refresh, 120000);
  window.addEventListener("focus", () => {
    if (state.report && Date.now() - new Date(state.report.generated_at).getTime() > 30000) refresh();
  });
  refresh();
}

// After the remaining scripts (insights.js, share.js) have loaded.
document.addEventListener("DOMContentLoaded", init);
