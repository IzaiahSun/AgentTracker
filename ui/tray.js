"use strict";

// Feeds the menu bar / tray icon (see src-tauri/src/tray.rs): today's and this
// week's usage across all agents, and handles its menu clicks.

const TRAY_KEY = "agenttracker.tray";

function trayMode() {
  try {
    return localStorage.getItem(TRAY_KEY) || "tokens";
  } catch (_) {
    return "tokens";
  }
}

function updateTray() {
  if (!window.__TAURI__ || !state.report) return;
  const today = todayDate();
  const day = ymd(today);
  const monday = ymd(addDays(today, -((today.getDay() + 6) % 7)));
  let tTok = 0, tCost = 0, tReq = 0, wTok = 0, wCost = 0;
  for (const r of state.report.rows) {
    if (r.date < monday || r.date > day) continue;
    const v = METRICS.total(r), c = costOf(r);
    wTok += v;
    wCost += c;
    if (r.date === day) (tTok += v), (tCost += c), (tReq += r.requests);
  }
  const mode = trayMode();
  const trayState = {
    title: mode === "tokens" ? fmt(tTok) : mode === "cost" ? money(tCost) : "",
    tooltip: `AgentTracker · ${t("tileToday")}: ${fmt(tTok)} · ${money(tCost)}`,
    lines: [
      t("trayToday", { tok: fmt(tTok), cost: money(tCost), req: fmt(tReq) }),
      t("trayWeek", { tok: fmt(wTok), cost: money(wCost) }),
    ],
    mode,
    labels: {
      show_tokens: t("trayShowTokens"),
      show_cost: t("trayShowCost"),
      icon_only: t("trayIconOnly"),
      refresh: t("trayRefresh"),
      open: t("trayOpen"),
      quit: t("trayQuit"),
    },
  };
  window.__TAURI__.core.invoke("update_tray", { state: trayState }).catch(() => {});
}

function bindTray() {
  if (!window.__TAURI__) return;
  window.__TAURI__.event.listen("tray", (e) => {
    const id = e.payload;
    if (id === "refresh") refresh();
    else if (id.startsWith("mode:")) {
      try {
        localStorage.setItem(TRAY_KEY, id.slice(5));
      } catch (_) {}
      updateTray();
    }
  });
}
