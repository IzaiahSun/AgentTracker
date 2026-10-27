"use strict";

// Streaks & records, time-of-day rhythm and per-project usage.

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

/// Bar chart SVG for `items` [{label, v}] sized to `el`; labels where `labelAt(i)`.
function miniBars(el, items, labelAt, aria) {
  const W = Math.max(120, el.clientWidth), H = el.clientHeight || 150;
  const pad = { t: 6, b: 20 };
  const ih = H - pad.t - pad.b;
  const max = Math.max(1, ...items.map((x) => x.v));
  const peak = items.reduce((bi, x, i) => (x.v > items[bi].v ? i : bi), 0);
  const band = W / items.length;
  const bw = Math.max(3, Math.min(22, band * 0.7));
  let svg = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(aria)}">`;
  svg += `<line class="baseline" x1="0" x2="${W}" y1="${pad.t + ih + 0.5}" y2="${pad.t + ih + 0.5}"/>`;
  items.forEach((x, i) => {
    const h = (x.v / max) * ih;
    const bx = band * i + (band - bw) / 2;
    if (h > 0) {
      const top = pad.t + ih - h, r = Math.min(3, bw / 2, h);
      svg += `<path fill="${x.v && i === peak ? "var(--h4)" : "var(--h3)"}" d="M${bx},${pad.t + ih} V${top + r} Q${bx},${top} ${bx + r},${top} H${bx + bw - r} Q${bx + bw},${top} ${bx + bw},${top + r} V${pad.t + ih} Z"/>`;
    }
    if (labelAt(i)) svg += `<text class="tick" x="${band * i + band / 2}" y="${H - 5}" text-anchor="middle">${esc(x.label)}</text>`;
    svg += `<rect class="hit" data-i="${i}" x="${band * i}" y="0" width="${band}" height="${pad.t + ih}"/>`;
  });
  return svg + "</svg>";
}

/// Requests by hour of day and by weekday (Monday first) in the selected range.
function renderRhythm() {
  const days = new Set(dateList());
  const hours = Array.from({ length: 24 }, (_, h) => ({ label: String(h), v: 0, tok: 0, tip: hourLabel(h) }));
  const wds = Array.from({ length: 7 }, (_, i) => ({ label: t("weekdays")[(i + 1) % 7], v: 0, tok: 0, tip: t("weekdaysLong")[(i + 1) % 7] }));
  for (const h of state.report.hours || []) {
    if (state.hidden.has(h.agent) || !days.has(h.date)) continue;
    const w = wds[(parseYmd(h.date).getDay() + 6) % 7];
    hours[h.hour].v += h.requests;
    hours[h.hour].tok += h.tokens;
    w.v += h.requests;
    w.tok += h.tokens;
  }
  const hEl = $("#rhythmHours"), wEl = $("#rhythmDays");
  hEl.innerHTML = miniBars(hEl, hours, (i) => i % 3 === 0, t("rhythmHoursAria"));
  wEl.innerHTML = miniBars(wEl, wds, () => true, t("rhythmDaysAria"));
  hEl._items = hours;
  wEl._items = wds;
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
  for (const el of [$("#rhythmHours"), $("#rhythmDays")]) {
    el.addEventListener("mousemove", (e) => {
      const hit = e.target.closest(".hit");
      if (!hit || !el._items) return ($("#tooltip").hidden = true);
      const x = el._items[Number(hit.dataset.i)];
      showTip(e, `<div class="t">${esc(x.tip)}</div>
        <div class="row"><span>${t("requests")}</span><b>${full(x.v)}</b></div>
        <div class="row"><span>${t("tokens")}</span><b>${full(x.tok)}</b></div>`);
    });
    el.addEventListener("mouseleave", () => ($("#tooltip").hidden = true));
  }
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
