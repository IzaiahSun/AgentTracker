"use strict";

// Streaks & records, weekly rhythm (weekday x hour) and per-project usage.

/// Per-day totals of the selected metric and requests, honoring the agent filter.
function dailyTotals(metric = METRICS[state.metric]) {
  const per = new Map();
  for (const r of state.report.rows) {
    if (state.hidden.has(r.agent) || r.date === "unknown") continue;
    const d = per.get(r.date) || { v: 0, req: 0 };
    d.v += metric(r);
    d.req += r.requests;
    per.set(r.date, d);
  }
  return per;
}

/// Longest and current runs of consecutive active days in `active` (a Set of ymd).
/// The current streak may end yesterday, since today might not have started yet.
function streaks(active, endDate) {
  const sorted = [...active].sort();
  let best = { len: 0, from: null, to: null };
  let run = 0, runFrom = null, prev = null;
  for (const d of sorted) {
    if (prev && ymd(addDays(parseYmd(prev), 1)) === d) run++;
    else (run = 1), (runFrom = d);
    if (run > best.len) best = { len: run, from: runFrom, to: d };
    prev = d;
  }
  let cur = 0;
  let d = endDate;
  if (!active.has(ymd(d))) d = addDays(d, -1);
  while (active.has(ymd(d))) cur++, (d = addDays(d, -1));
  return { best, cur };
}

function hourLabel(h) {
  const p = (x) => String(x).padStart(2, "0");
  return `${p(h)}:00–${p((h + 1) % 24)}:00`;
}

function renderRecords() {
  const per = dailyTotals();
  const active = new Set([...per].filter(([, d]) => d.req > 0).map(([k]) => k));
  const { best, cur } = streaks(active, todayDate());
  let peak = null;
  for (const [k, d] of per) if (!peak || d.v > peak.v) peak = { date: k, v: d.v };
  const byHour = new Array(24).fill(0);
  const byWeekday = new Array(7).fill(0);
  let req = 0;
  for (const h of state.report.hours || []) {
    if (state.hidden.has(h.agent) || h.date === "unknown") continue;
    byHour[h.hour] += h.requests;
    byWeekday[parseYmd(h.date).getDay()] += h.requests;
    req += h.requests;
  }
  const topHour = byHour.indexOf(Math.max(...byHour));
  const topWd = byWeekday.indexOf(Math.max(...byWeekday));
  const night = byHour.slice(0, 5).reduce((a, b) => a + b, 0);
  const items = [
    { label: t("recCurStreak"), value: t("nDays", { n: cur }), hint: cur ? t("recCurHint") : t("recCurNone") },
    { label: t("recBestStreak"), value: t("nDays", { n: best.len }), hint: best.len ? `${best.from} → ${best.to}` : "—" },
    { label: t("recPeakDay"), value: peak ? fv(peak.v) : "—", hint: peak ? peak.date : "—", title: peak ? fvFull(peak.v) : "" },
    { label: t("recActiveDays"), value: full(active.size), hint: t("recActiveHint") },
    { label: t("recBusyHour"), value: req ? hourLabel(topHour) : "—", hint: req ? t("recBusyWd", { d: t("weekdaysLong")[topWd] }) : "" , small: true },
    { label: t("recNight"), value: req ? ((night / req) * 100).toFixed(1) + "%" : "—", hint: t("recNightHint") },
  ];
  $("#records").innerHTML = items
    .map(
      (x) => `<div class="stat" ${x.title ? `title="${esc(x.title)}"` : ""}><div class="label">${x.label}</div>
        <div class="value${x.small ? " small" : ""}">${x.value}</div><div class="hint">${esc(x.hint)}</div></div>`
    )
    .join("");
}

/// Weekday x hour punch card of requests in the selected range (Monday first).
function renderRhythm() {
  const days = new Set(dateList());
  const grid = Array.from({ length: 7 }, () => new Array(24).fill(null).map(() => ({ req: 0, tok: 0 })));
  for (const h of state.report.hours || []) {
    if (state.hidden.has(h.agent) || !days.has(h.date)) continue;
    const c = grid[(parseYmd(h.date).getDay() + 6) % 7][h.hour];
    c.req += h.requests;
    c.tok += h.tokens;
  }
  const vals = grid.flat().map((c) => c.req).filter((v) => v > 0).sort((a, b) => a - b);
  const q = (p) => vals[Math.min(vals.length - 1, Math.floor(p * vals.length))] || 0;
  const t1 = q(0.25), t2 = q(0.5), t3 = q(0.75);
  const level = (v) => (v <= 0 ? 0 : v <= t1 ? 1 : v <= t2 ? 2 : v <= t3 ? 3 : 4);

  const el = $("#rhythm");
  const L = 34, T = 16, G = 3;
  const C = Math.max(9, Math.min(26, Math.floor((el.clientWidth - L) / 24 - G)));
  const W = L + 24 * (C + G), H = T + 7 * (C + G);
  let svg = `<svg width="${W}" height="${H}" role="img" aria-label="${t("rhythmAria")}">`;
  for (let hr = 0; hr < 24; hr += 3) svg += `<text class="lbl" x="${L + hr * (C + G)}" y="10">${hr}</text>`;
  for (let wd = 0; wd < 7; wd++) {
    const name = t("weekdays")[(wd + 1) % 7];
    svg += `<text class="lbl" x="0" y="${T + wd * (C + G) + C - 2}">${name}</text>`;
    for (let hr = 0; hr < 24; hr++) {
      svg += `<rect class="cell" data-w="${wd}" data-h="${hr}" x="${L + hr * (C + G)}" y="${T + wd * (C + G)}" width="${C}" height="${C}" fill="var(--h${level(grid[wd][hr].req)})"/>`;
    }
  }
  el.innerHTML = svg + "</svg>";
  el._grid = grid;
}

/// Short display names for project paths; duplicates get their parent folder.
function projectNames(paths) {
  const base = (p) => p.split(/[\\/]/).filter(Boolean).pop() || p;
  const parent = (p) => p.split(/[\\/]/).filter(Boolean).slice(-2, -1)[0] || "";
  const counts = new Map();
  for (const p of paths) counts.set(base(p), (counts.get(base(p)) || 0) + 1);
  const out = new Map();
  for (const p of paths) {
    if (p === "") out.set(p, t("projUnknown"));
    else if (p === "<temp>") out.set(p, t("projTemp"));
    else if (p === "<cowork>") out.set(p, "Claude Cowork");
    else out.set(p, counts.get(base(p)) > 1 ? `${parent(p)}/${base(p)}` : base(p));
  }
  return out;
}

function projectTotals(rows) {
  const m = METRICS[state.metric];
  const map = new Map();
  for (const r of rows) {
    let x = map.get(r.project);
    if (!x) map.set(r.project, (x = { path: r.project, v: 0, cost: 0, requests: 0, agents: new Map() }));
    const v = m(r);
    x.v += v;
    x.cost += costOf(r);
    x.requests += r.requests;
    x.agents.set(r.agent, (x.agents.get(r.agent) || 0) + v);
  }
  return [...map.values()].sort((a, b) => b.v - a.v);
}

let showAllProjects = false;

function renderProjects(rows) {
  const list = projectTotals(rows);
  const names = projectNames(list.map((x) => x.path));
  const max = list.length ? list[0].v : 0;
  const LIMIT = 10;
  const shown = showAllProjects ? list : list.slice(0, LIMIT);
  $("#projectCount").textContent = list.length ? t("projCount", { n: list.length }) : "";
  if (!list.length) {
    $("#projects").innerHTML = `<div class="muted">${t("noData")}</div>`;
    return;
  }
  const body = shown
    .map((x) => {
      // Bar segments per agent, largest first, in agent colors.
      const segs = [...x.agents.entries()]
        .sort((a, b) => b[1] - a[1])
        .map(([a, v]) => `<b style="width:${max ? (v / max) * 100 : 0}%;background:${slotColor(agentSlot(a))}" title="${esc(a)}"></b>`)
        .join("");
      return `<tr><td><span class="model-name" title="${esc(x.path || names.get(x.path))}">${esc(names.get(x.path))}</span>
        <div class="bar stacked">${segs}</div></td>
        <td title="${full(x.requests)}">${fmt(x.requests)}</td>
        <td title="${moneyFull(x.cost)}">${money(x.cost)}</td>
        <td title="${fvFull(x.v)}"><b>${fv(x.v)}</b></td></tr>`;
    })
    .join("");
  const more =
    list.length > LIMIT
      ? `<button class="btn small" id="projMore">${showAllProjects ? t("showLess") : t("showAll", { n: list.length })}</button>`
      : "";
  $("#projects").innerHTML = `<table class="mini"><thead><tr><th>${t("project")}</th><th>${t("requests")}</th><th>${t("cost")}</th><th>${t(state.metric === "cost" ? "cost" : "total")}</th></tr></thead><tbody>${body}</tbody></table>${more}`;
}

function bindInsights() {
  $("#projects").addEventListener("click", (e) => {
    if (!e.target.closest("#projMore")) return;
    showAllProjects = !showAllProjects;
    renderProjects(visibleRows());
  });
  const rh = $("#rhythm");
  rh.addEventListener("mousemove", (e) => {
    const c = e.target.closest("rect.cell");
    if (!c || !rh._grid) return ($("#tooltip").hidden = true);
    const wd = Number(c.dataset.w), hr = Number(c.dataset.h);
    const g = rh._grid[wd][hr];
    showTip(e, `<div class="t">${t("weekdaysLong")[(wd + 1) % 7]} ${hourLabel(hr)}</div>
      <div class="row"><span>${t("requests")}</span><b>${full(g.req)}</b></div>
      <div class="row"><span>${t("tokens")}</span><b>${full(g.tok)}</b></div>`);
  });
  rh.addEventListener("mouseleave", () => ($("#tooltip").hidden = true));
}

// ---------- prices dialog ----------
function openPrices() {
  const tot = new Map();
  for (const r of state.report.rows) tot.set(r.model, (tot.get(r.model) || 0) + METRICS.total(r));
  const models = [...tot.entries()].sort((a, b) => b[1] - a[1]).map((x) => x[0]);
  const cell = (m, i) => {
    const o = priceOverrides[m];
    const b = builtinPrice(m);
    const v = o && o[i] !== null && o[i] !== undefined && o[i] !== "" ? o[i] : "";
    return `<td><input type="number" min="0" step="any" data-m="${esc(m)}" data-i="${i}" value="${esc(v)}" placeholder="${b ? b[i] : "—"}"></td>`;
  };
  $("#priceRows").innerHTML = models
    .map(
      (m) => `<tr class="${priceOf(m) ? "" : "unpriced"}"><td><span class="model-name" title="${esc(m)}">${esc(m)}</span>
        <div class="muted small">${fmt(tot.get(m))} tokens${priceOf(m) ? "" : " · " + t("unpriced")}</div></td>${[0, 1, 2, 3].map((i) => cell(m, i)).join("")}</tr>`
    )
    .join("");
  $("#planInput").value = planMonthly || "";
  if (!$("#pricesDlg").open) $("#pricesDlg").showModal();
}

function bindPrices() {
  $("#pricesBtn").addEventListener("click", openPrices);
  $("#pricesDlg").addEventListener("change", (e) => {
    const inp = e.target;
    if (inp.id === "planInput") {
      planMonthly = Math.max(0, Number(inp.value) || 0);
    } else if (inp.dataset.m) {
      const m = inp.dataset.m;
      const o = priceOverrides[m] || [null, null, null, null];
      o[Number(inp.dataset.i)] = inp.value === "" ? null : Number(inp.value);
      if (o.every((x) => x === null)) delete priceOverrides[m];
      else priceOverrides[m] = o;
    } else return;
    savePrices();
    render();
  });
  $("#pricesReset").addEventListener("click", () => {
    priceOverrides = {};
    savePrices();
    render();
    openPrices();
  });
  $("#pricesClose").addEventListener("click", () => $("#pricesDlg").close());
}
