"use strict";

// List API prices in USD per million tokens: [input, output, cache read, cache write].
// Used to estimate what the usage would cost at pay-as-you-go API rates; users
// can override any model in the Prices dialog. First matching pattern wins.
// Anthropic: cache writes are 5-minute writes (1.25x input).
// OpenAI: no cache-write surcharge. Third-party rates are best-effort estimates.
const PRICE_TABLE = [
  // Anthropic (as of 2026-10)
  [/fable-5-1|mythos-5-1/, [10, 50, 0.25, 12.5]],
  [/fable-5|mythos-5|mythos/, [10, 50, 1, 12.5]],
  [/opus-5-5/, [4, 20, 0.2, 5]],
  [/opus-5|opus-4-[5-9]/, [5, 25, 0.5, 6.25]],
  [/opus/, [15, 75, 1.5, 18.75]],
  [/sonnet-5/, [2, 10, 0.2, 2.5]],
  [/sonnet/, [3, 15, 0.3, 3.75]],
  [/haiku-5-5/, [0.1, 0.5, 0.01, 0.125]],
  [/haiku-4-5/, [1, 5, 0.1, 1.25]],
  [/3-5-haiku|haiku-3-5/, [0.8, 4, 0.08, 1]],
  [/haiku/, [0.25, 1.25, 0.03, 0.3]],
  // OpenAI (list prices, 2026-10)
  [/gpt-6(\.\d+)?-astra/, [10, 50, 1, 10]],
  [/gpt-6(\.\d+)?-sol/, [2, 10, 0.2, 2]],
  [/gpt-6(\.\d+)?-luna/, [0.1, 0.5, 0.01, 0.1]],
  [/gpt-5\.6-sol/, [5, 30, 0.5, 5]],
  [/gpt-5\.6-luna/, [0.2, 1.2, 0.02, 0.2]],
  [/gpt-5(\.\d+)?(-codex)?(-mini)$/, [0.25, 2, 0.025, 0.25]],
  [/gpt-5(\.\d+)?(-codex)?$/, [1.25, 10, 0.125, 1.25]],
  // Others (estimates)
  [/glm-5\.3-flash/, [0.15, 0.5, 0.03, 0.15]],
  [/glm-5/, [1.4, 4.4, 0.28, 1.4]],
  [/deepseek/, [0.28, 0.42, 0.028, 0.28]],
];

const PRICE_KEY = "agenttracker.prices";
let priceOverrides = {};
let planMonthly = 0;
const priceMemo = new Map();

function loadPrices() {
  try {
    const p = JSON.parse(localStorage.getItem(PRICE_KEY) || "{}");
    priceOverrides = p.models || {};
    planMonthly = Number(p.plan) || 0;
  } catch (_) {}
  priceMemo.clear();
}
function savePrices() {
  try {
    localStorage.setItem(PRICE_KEY, JSON.stringify({ models: priceOverrides, plan: planMonthly }));
  } catch (_) {}
  priceMemo.clear();
}

/// Normalizes "anthropic/claude-opus-5-20260101" -> "claude-opus-5".
function normModel(m) {
  return String(m).toLowerCase().replace(/^.*\//, "").replace(/-\d{8}$/, "");
}

/// Built-in price for a model, or null when unknown.
function builtinPrice(model) {
  const n = normModel(model);
  for (const [re, p] of PRICE_TABLE) if (re.test(n)) return p;
  return null;
}

/// Effective price (override, else built-in), or null when unpriced.
function priceOf(model) {
  if (priceMemo.has(model)) return priceMemo.get(model);
  const o = priceOverrides[model];
  const p = o && o.some((x) => x !== null && x !== "") ? o.map((x, i) => (x === null || x === "" ? (builtinPrice(model) || [0, 0, 0, 0])[i] : Number(x))) : builtinPrice(model);
  priceMemo.set(model, p);
  return p;
}

/// Estimated USD cost of a row with input/output/cache_read/cache_write and model.
function costOf(r) {
  const p = priceOf(r.model);
  if (!p) return 0;
  return (r.input * p[0] + r.output * p[1] + r.cache_read * p[2] + r.cache_write * p[3]) / 1e6;
}

/// What cache reads saved versus paying full input price.
function cacheSavingsOf(r) {
  const p = priceOf(r.model);
  return p ? (r.cache_read * (p[0] - p[2])) / 1e6 : 0;
}

function money(v) {
  const a = Math.abs(v);
  if (a >= 1e6) return "$" + (v / 1e6).toFixed(2) + "M";
  if (a >= 1e4) return "$" + (v / 1e3).toFixed(1) + "K";
  if (a >= 100) return "$" + Math.round(v).toLocaleString("en-US");
  if (a >= 1) return "$" + v.toFixed(2);
  if (a === 0) return "$0";
  return "$" + v.toFixed(a >= 0.01 ? 2 : 4);
}
const moneyFull = (v) => "$" + v.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
