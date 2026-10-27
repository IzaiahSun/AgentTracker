"use strict";

// Shareable weekly / monthly / yearly summary cards, drawn on a canvas and
// exported as PNG. The card always uses the dark palette so it looks the same
// wherever it is posted.

const CARD = {
  w: 1080, h: 1350,
  bg0: "#0d0d0d", bg1: "#14181f",
  surface: "#1a1a19", ink: "#f0efec", ink2: "#c3c2b7", muted: "#898781", grid: "#2c2c2a",
  accent: "#3987e5",
  series: ["#3987e5", "#d95926", "#199e70", "#c98500", "#d55181", "#008300", "#9085e9", "#e66767"],
  font: '-apple-system, system-ui, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif',
};

const share = { kind: "month", offset: 0, blob: null };

/// [start, end] dates of the selected period; end is clipped to today.
function sharePeriod() {
  const today = todayDate();
  let a, b;
  if (share.kind === "week") {
    a = addDays(today, -((today.getDay() + 6) % 7) + 7 * share.offset);
    b = addDays(a, 6);
  } else if (share.kind === "month") {
    a = new Date(today.getFullYear(), today.getMonth() + share.offset, 1);
    b = new Date(a.getFullYear(), a.getMonth() + 1, 0);
  } else {
    a = new Date(today.getFullYear() + share.offset, 0, 1);
    b = new Date(a.getFullYear(), 11, 31);
  }
  return [a, b > today ? today : b, b];
}

function periodTitle(a, fullEnd) {
  if (share.kind === "year") return t("shareYearTitle", { y: a.getFullYear() });
  if (share.kind === "month") return t("shareMonthTitle", { y: a.getFullYear(), m: t("monthsLong")[a.getMonth()], n: a.getMonth() + 1 });
  const d = (x) => t("shareDay", { m: t("months")[x.getMonth()], n: x.getMonth() + 1, d: x.getDate() });
  return t("shareWeekTitle", { from: d(a), to: d(fullEnd) });
}

function periodFile(a) {
  const p = (x) => String(x).padStart(2, "0");
  if (share.kind === "year") return `agenttracker-${a.getFullYear()}.png`;
  if (share.kind === "month") return `agenttracker-${a.getFullYear()}-${p(a.getMonth() + 1)}.png`;
  return `agenttracker-week-${ymd(a)}.png`;
}

/// Everything the card shows, for rows between a and b (inclusive).
function shareStats(a, b) {
  const from = ymd(a), to = ymd(b);
  const rows = state.report.rows.filter((r) => r.date >= from && r.date <= to && !state.hidden.has(r.agent));
  const tok = METRICS.total;
  const s = { tokens: 0, cost: 0, requests: 0, cacheRead: 0, inputAll: 0 };
  const byDay = new Map(), byModel = new Map(), byAgent = new Map(), byProject = new Map();
  const add = (m, k, v) => m.set(k, (m.get(k) || 0) + v);
  for (const r of rows) {
    const v = tok(r);
    s.tokens += v;
    s.cost += costOf(r);
    s.requests += r.requests;
    s.cacheRead += r.cache_read;
    s.inputAll += r.input + r.cache_read + r.cache_write;
    add(byDay, r.date, v);
    add(byModel, r.model, v);
    add(byAgent, r.agent, v);
    add(byProject, r.project, v);
  }
  const top = (m) => [...m.entries()].sort((x, y) => y[1] - x[1]);
  s.models = top(byModel);
  s.agents = top(byAgent);
  s.projects = top(byProject).filter(([p]) => p && !p.startsWith("<"));
  s.activeDays = [...byDay.values()].filter((v) => v > 0).length;
  s.peak = top(byDay)[0] || null;
  s.streak = streaks(new Set([...byDay].filter(([, v]) => v > 0).map(([k]) => k)), b).best.len;
  let night = 0, hreq = 0;
  for (const h of state.report.hours || []) {
    if (h.date < from || h.date > to || state.hidden.has(h.agent)) continue;
    hreq += h.requests;
    if (h.hour < 5) night += h.requests;
  }
  s.night = hreq ? night / hreq : 0;
  // Chart buckets: days for week/month, months for a year.
  s.bars = [];
  if (share.kind === "year") {
    for (let m = 0; m < 12; m++) {
      const pre = `${a.getFullYear()}-${String(m + 1).padStart(2, "0")}`;
      let v = 0;
      for (const [d, x] of byDay) if (d.startsWith(pre)) v += x;
      s.bars.push({ label: t("months")[m], v });
    }
  } else {
    const end = sharePeriod()[2];
    for (let d = new Date(a); d <= end; d = addDays(d, 1)) {
      const k = ymd(d);
      s.bars.push({
        label: share.kind === "week" ? t("weekdays")[d.getDay()] : String(d.getDate()),
        v: byDay.get(k) || 0,
        future: d > b,
      });
    }
  }
  return s;
}

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

/// Truncates `text` with an ellipsis to fit `maxW` in the current font.
function fitText(ctx, text, maxW) {
  if (ctx.measureText(text).width <= maxW) return text;
  let s = text;
  while (s.length > 1 && ctx.measureText(s + "…").width > maxW) s = s.slice(0, -1);
  return s + "…";
}

function drawCard(canvas) {
  const [a, b, fullEnd] = sharePeriod();
  const s = shareStats(a, b);
  const { w: W, h: H } = CARD;
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext("2d");
  const font = (wt, px) => `${wt} ${px}px ${CARD.font}`;
  const P = 72;

  const g = ctx.createLinearGradient(0, 0, W, H);
  g.addColorStop(0, CARD.bg1);
  g.addColorStop(1, CARD.bg0);
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, W, H);
  ctx.textBaseline = "alphabetic";

  // Header
  ctx.fillStyle = CARD.accent;
  roundRect(ctx, P, 64, 14, 14, 4);
  ctx.fill();
  ctx.fillStyle = CARD.ink2;
  ctx.font = font(600, 26);
  ctx.fillText("AgentTracker", P + 26, 79);
  ctx.textAlign = "right";
  ctx.fillStyle = CARD.muted;
  ctx.font = font(500, 24);
  ctx.fillText(t("shareKind_" + share.kind), W - P, 79);
  ctx.textAlign = "left";
  ctx.fillStyle = CARD.ink;
  ctx.font = font(700, 48);
  ctx.fillText(fitText(ctx, periodTitle(a, fullEnd), W - 2 * P), P, 160);

  // Hero
  ctx.font = font(800, 150);
  const hero = fmt(s.tokens);
  ctx.fillText(hero, P - 6, 330);
  const hw = ctx.measureText(hero).width;
  ctx.font = font(500, 34);
  ctx.fillStyle = CARD.ink2;
  ctx.fillText(t("tokens"), P + hw + 14, 330);
  ctx.fillStyle = CARD.accent;
  ctx.font = font(600, 36);
  ctx.fillText(t("shareCost", { v: money(s.cost) }), P, 392);

  // Bar chart
  const cx = P, cy = 440, cw = W - 2 * P, ch = 180;
  const max = Math.max(1, ...s.bars.map((x) => x.v));
  const n = s.bars.length;
  const band = cw / n;
  const bw = Math.max(4, Math.min(56, band * 0.7));
  ctx.strokeStyle = CARD.grid;
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(cx, cy + ch + 1);
  ctx.lineTo(cx + cw, cy + ch + 1);
  ctx.stroke();
  const peakIdx = s.bars.reduce((bi, x, i) => (x.v > s.bars[bi].v ? i : bi), 0);
  ctx.font = font(500, 20);
  ctx.textAlign = "center";
  const every = n > 14 ? Math.ceil(n / 8) : 1;
  s.bars.forEach((x, i) => {
    const h = (x.v / max) * ch;
    const bx = cx + band * i + (band - bw) / 2;
    if (h > 0) {
      ctx.fillStyle = i === peakIdx ? CARD.accent : "#256abf";
      roundRect(ctx, bx, cy + ch - h, bw, h, Math.min(6, bw / 2, h / 2));
      ctx.fill();
    }
    if (i % every === 0 || i === n - 1) {
      ctx.fillStyle = x.future ? CARD.grid : CARD.muted;
      ctx.fillText(x.label, cx + band * i + band / 2, cy + ch + 32);
    }
  });
  ctx.textAlign = "left";

  // Stat boxes
  const stats = [
    [t("tileRequests"), fmt(s.requests)],
    [t("recActiveDays"), String(s.activeDays)],
    [t("recBestStreak"), t("nDays", { n: s.streak })],
    [t("recPeakDay"), s.peak ? fmt(s.peak[1]) : "—", s.peak ? s.peak[0].slice(5) : ""],
    [t("tileCacheHit"), s.inputAll ? ((s.cacheRead / s.inputAll) * 100).toFixed(0) + "%" : "—"],
    [t("recNight"), (s.night * 100).toFixed(0) + "%"],
  ];
  const gx = 20, bxw = (W - 2 * P - 2 * gx) / 3, bxh = 116, by0 = 690;
  stats.forEach(([lab, val, sub], i) => {
    const x = P + (i % 3) * (bxw + gx), y = by0 + Math.floor(i / 3) * (bxh + gx);
    ctx.fillStyle = CARD.surface;
    roundRect(ctx, x, y, bxw, bxh, 18);
    ctx.fill();
    ctx.fillStyle = CARD.muted;
    ctx.font = font(500, 22);
    ctx.fillText(fitText(ctx, lab, bxw - 40), x + 22, y + 40);
    ctx.fillStyle = CARD.ink;
    ctx.font = font(700, 44);
    ctx.fillText(val, x + 22, y + 92);
    if (sub) {
      const vw = ctx.measureText(val).width;
      ctx.fillStyle = CARD.muted;
      ctx.font = font(500, 22);
      ctx.fillText(sub, x + 22 + vw + 10, y + 92);
    }
  });

  // Top models + agent / project
  let y = by0 + 2 * bxh + gx + 56;
  ctx.fillStyle = CARD.ink2;
  ctx.font = font(600, 26);
  ctx.fillText(t("shareTopModels"), P, y);
  y += 22;
  const topM = s.models.slice(0, 4);
  const mmax = topM.length ? topM[0][1] : 1;
  topM.forEach(([name, v], i) => {
    const yy = y + i * 44;
    ctx.fillStyle = CARD.ink;
    ctx.font = font(500, 24);
    ctx.fillText(fitText(ctx, name, 330), P, yy + 30);
    const bx = P + 350, bwMax = W - 2 * P - 350 - 150;
    ctx.fillStyle = CARD.grid;
    roundRect(ctx, bx, yy + 14, bwMax, 18, 9);
    ctx.fill();
    ctx.fillStyle = CARD.series[i % CARD.series.length];
    roundRect(ctx, bx, yy + 14, Math.max(18, (v / mmax) * bwMax), 18, 9);
    ctx.fill();
    ctx.textAlign = "right";
    ctx.fillStyle = CARD.ink2;
    ctx.fillText(`${fmt(v)} · ${s.tokens ? Math.round((v / s.tokens) * 100) : 0}%`, W - P, yy + 30);
    ctx.textAlign = "left";
  });
  if (!topM.length) {
    ctx.fillStyle = CARD.muted;
    ctx.font = font(500, 24);
    ctx.fillText(t("noData"), P, y + 30);
  }

  // Footer: favorite agent and project
  ctx.font = font(500, 22);
  ctx.fillStyle = CARD.ink2;
  const favs = [];
  if (s.agents[0]) favs.push(t("shareTopAgent", { v: s.agents[0][0] }));
  if (s.projects[0]) favs.push(t("shareTopProject", { v: projectNames([s.projects[0][0]]).get(s.projects[0][0]) }));
  ctx.fillText(fitText(ctx, favs.join("   ·   "), W - 2 * P), P, H - 92);
  ctx.strokeStyle = CARD.grid;
  ctx.beginPath();
  ctx.moveTo(P, H - 72);
  ctx.lineTo(W - P, H - 72);
  ctx.stroke();
  ctx.fillStyle = CARD.muted;
  ctx.font = font(500, 20);
  ctx.fillText(`${ymd(a)} – ${ymd(b)}`, P, H - 40);
  ctx.textAlign = "right";
  ctx.fillText("github.com/IzaiahSun/AgentTracker", W - P, H - 40);
  ctx.textAlign = "left";
  return { name: periodFile(a) };
}

function renderShare() {
  const canvas = $("#shareCanvas");
  share.file = drawCard(canvas).name;
  $("#shareNext").disabled = share.offset >= 0;
  $("#shareMsg").textContent = "";
  $("#shareReveal").hidden = true;
  $("#shareKind").querySelectorAll("button").forEach((b) => b.classList.toggle("on", b.dataset.v === share.kind));
}

const canvasBlob = () => new Promise((res) => $("#shareCanvas").toBlob(res, "image/png"));

async function saveShare() {
  const blob = await canvasBlob();
  try {
    if (window.__TAURI__) {
      const bytes = Array.from(new Uint8Array(await blob.arrayBuffer()));
      const path = await window.__TAURI__.core.invoke("save_image", { name: share.file, bytes });
      share.saved = path;
      $("#shareMsg").textContent = t("shareSaved", { path });
      $("#shareReveal").hidden = false;
    } else {
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = share.file;
      a.click();
      URL.revokeObjectURL(a.href);
    }
  } catch (e) {
    $("#shareMsg").textContent = t("shareFailed", { err: e });
  }
}

async function copyShare() {
  try {
    // Pass a promise so Safari keeps the user-activation for the clipboard write.
    await navigator.clipboard.write([new ClipboardItem({ "image/png": canvasBlob() })]);
    $("#shareMsg").textContent = t("shareCopied");
  } catch (e) {
    $("#shareMsg").textContent = t("shareFailed", { err: e.message || e });
  }
}

function bindShare() {
  $("#shareBtn").addEventListener("click", () => {
    if (!state.report) return;
    renderShare();
    $("#shareDlg").showModal();
  });
  $("#shareKind").addEventListener("click", (e) => {
    const b = e.target.closest("button");
    if (!b) return;
    share.kind = b.dataset.v;
    share.offset = 0;
    renderShare();
  });
  $("#sharePrev").addEventListener("click", () => (share.offset--, renderShare()));
  $("#shareNext").addEventListener("click", () => (share.offset++, renderShare()));
  $("#shareSave").addEventListener("click", saveShare);
  $("#shareCopy").addEventListener("click", copyShare);
  $("#shareReveal").addEventListener("click", () => window.__TAURI__.core.invoke("reveal", { path: share.saved }));
  $("#shareClose").addEventListener("click", () => $("#shareDlg").close());
}
