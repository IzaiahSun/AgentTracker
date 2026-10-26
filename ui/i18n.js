"use strict";

// UI strings. English is the default; Chinese is used when the OS locale is zh-*.
// `{name}` placeholders are filled by t(key, {name: value}).
const I18N = {
  en: {
    scanning: "Scanning…",
    updated: "Updated {time} · scanned in {ms} ms",
    scanFailed: "Scan failed: {err}",
    rangeGroup: "Date range",
    today: "Today",
    days7: "7 days",
    days30: "30 days",
    days90: "90 days",
    all: "All",
    customRange: "Custom date range",
    fromDate: "Start date",
    toDate: "End date",
    refresh: "↻ Refresh",
    refreshTitle: "Rescan logs",
    agentFilter: "Agent filter",
    metric: "Metric",
    mTotal: "All tokens",
    mNocache: "Excluding cache reads",
    mInput: "Input (uncached)",
    mOutput: "Output",
    mCacheRead: "Cache reads",
    mCacheWrite: "Cache writes",
    heatTitle: "Past year",
    heatHint: "Click a day to see just that day",
    heatAria: "Daily token usage over the past year",
    heatSummary: "{total} tokens · {days} active days",
    less: "Less",
    more: "More",
    dailyUsage: "Daily usage",
    groupBy: "Group by",
    byAgent: "By agent",
    byModel: "By model",
    chartAria: "Stacked bar chart of daily token usage",
    perAgent: "Models per agent",
    dailyDetail: "Daily detail",
    date: "Date",
    agent: "Agent",
    model: "Model",
    requests: "Requests",
    input: "Input",
    output: "Output",
    cacheRead: "Cache read",
    cacheWrite: "Cache write",
    total: "Total",
    sources: "Data sources",
    other: "Other",
    noData: "No data in the selected range",
    noUsage: "No usage",
    tileTotal: "Total in range",
    tileTotalHint: "{days} days from {start} · {avg}/day",
    tileToday: "Today",
    tileLastDay: "{date} (last day)",
    vsYesterday: "{sign}{pct}% vs previous day ({prev})",
    prevDay: "Previous day {prev}",
    tileRequests: "Requests",
    tileRequestsHint: "Model calls",
    tileCacheHit: "Cache hit rate",
    tileCacheHitHint: "Cache reads / all input",
    tileTopModel: "Top model",
    tileTopModelHint: "{pct}% of total",
    calls: "{n} calls",
    detailCount: "{n} rows",
    detailLimited: " (showing first {limit})",
    detailNote: " · Total column uses the selected metric",
    sourceFound: "✓ {n} requests",
    sourceMissing: "Not found",
    orEnv: "or {env}",
    weekdays: ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"],
    months: ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"],
    tipWeekday: "{d}",
    updateAvailable: "AgentTracker {version} is available (you have {current}).",
    updateNow: "Update and restart",
    later: "Later",
    updating: "Downloading and installing {version}…",
    updateFailed: "Update failed: {err}",
  },
  zh: {
    scanning: "正在扫描…",
    updated: "更新于 {time} · 扫描 {ms} ms",
    scanFailed: "扫描失败：{err}",
    rangeGroup: "时间范围",
    today: "今天",
    days7: "7 天",
    days30: "30 天",
    days90: "90 天",
    all: "全部",
    customRange: "自定义日期范围",
    fromDate: "开始日期",
    toDate: "结束日期",
    refresh: "↻ 刷新",
    refreshTitle: "重新扫描",
    agentFilter: "Agent 过滤",
    metric: "统计口径",
    mTotal: "全部 token",
    mNocache: "不含缓存读取",
    mInput: "输入（未缓存）",
    mOutput: "输出",
    mCacheRead: "缓存读取",
    mCacheWrite: "缓存写入",
    heatTitle: "近一年热力图",
    heatHint: "点击某一天只看当天",
    heatAria: "近一年每日 token 用量热力图",
    heatSummary: "{total} tokens · {days} 天有用量",
    less: "少",
    more: "多",
    dailyUsage: "每日用量",
    groupBy: "分组",
    byAgent: "按 Agent",
    byModel: "按模型",
    chartAria: "每日 token 用量堆叠柱状图",
    perAgent: "各 Agent 模型明细",
    dailyDetail: "每日明细",
    date: "日期",
    agent: "Agent",
    model: "模型",
    requests: "请求",
    input: "输入",
    output: "输出",
    cacheRead: "缓存读",
    cacheWrite: "缓存写",
    total: "合计",
    sources: "数据源",
    other: "其他",
    noData: "所选范围内没有数据",
    noUsage: "无用量",
    tileTotal: "区间总量",
    tileTotalHint: "{start} 起 {days} 天 · 日均 {avg}",
    tileToday: "今天",
    tileLastDay: "{date}（区间最后一天）",
    vsYesterday: "较昨天 {sign}{pct}%（{prev}）",
    prevDay: "昨天 {prev}",
    tileRequests: "请求数",
    tileRequestsHint: "模型调用次数",
    tileCacheHit: "缓存命中率",
    tileCacheHitHint: "缓存读取 / 全部输入",
    tileTopModel: "用量最多的模型",
    tileTopModelHint: "占 {pct}%",
    calls: "{n} 次",
    detailCount: "{n} 行",
    detailLimited: "（显示前 {limit}）",
    detailNote: " · “合计”列按当前口径",
    sourceFound: "✓ {n} 条请求",
    sourceMissing: "未找到数据目录",
    orEnv: "或 {env}",
    weekdays: ["日", "一", "二", "三", "四", "五", "六"],
    months: ["1月", "2月", "3月", "4月", "5月", "6月", "7月", "8月", "9月", "10月", "11月", "12月"],
    tipWeekday: "周{d}",
    updateAvailable: "AgentTracker {version} 已发布（当前版本 {current}）。",
    updateNow: "更新并重启",
    later: "稍后",
    updating: "正在下载并安装 {version}…",
    updateFailed: "更新失败：{err}",
  },
};

let LANG = "en";

function t(key, vars) {
  let s = I18N[LANG][key] ?? I18N.en[key] ?? key;
  if (vars && typeof s === "string") s = s.replace(/\{(\w+)\}/g, (_, k) => (k in vars ? vars[k] : `{${k}}`));
  return s;
}

/// Picks zh for a zh-* OS locale, en otherwise. Asks the Rust side first because
/// the macOS webview reports the bundle's localization, not the system language.
async function detectLang() {
  const forced = new URLSearchParams(location.search).get("lang");
  if (forced && I18N[forced]) return forced;
  let loc = null;
  try {
    if (window.__TAURI__) loc = await window.__TAURI__.core.invoke("system_locale");
  } catch (_) {}
  loc = loc || (navigator.languages && navigator.languages[0]) || navigator.language || "en";
  return /^zh\b/i.test(loc) ? "zh" : "en";
}

/// Fills static markup: data-i18n (text), data-i18n-title, data-i18n-aria.
function applyStaticStrings() {
  document.documentElement.lang = LANG === "zh" ? "zh-CN" : "en";
  document.querySelectorAll("[data-i18n]").forEach((el) => (el.textContent = t(el.dataset.i18n)));
  document.querySelectorAll("[data-i18n-title]").forEach((el) => (el.title = t(el.dataset.i18nTitle)));
  document.querySelectorAll("[data-i18n-aria]").forEach((el) => el.setAttribute("aria-label", t(el.dataset.i18nAria)));
}
