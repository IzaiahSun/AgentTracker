// Writes dev/demo-report.json: a year of made-up usage for screenshots and the
// browser preview (open /ui/?data=demo-report.json). Deterministic.
import { mkdirSync, writeFileSync } from "node:fs";

let seed = 42;
const rand = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32);
const pick = (items) => {
  let r = rand() * items.reduce((s, x) => s + x[1], 0);
  for (const [v, w] of items) if ((r -= w) <= 0) return v;
  return items[0][0];
};

const AGENTS = [
  ["Claude Code Desktop", 5, ["claude-opus-5-5", "claude-opus-5-5", "claude-sonnet-5-5", "claude-haiku-5-5"]],
  ["Claude Code CLI", 2.5, ["claude-opus-5-5", "claude-sonnet-5-5"]],
  ["Codex Desktop", 2, ["gpt-6-sol", "gpt-6-luna"]],
  ["Codex CLI", 1, ["gpt-6-sol"]],
  ["OpenCode", 1, ["glm-5.3", "claude-sonnet-5-5"]],
];
const PROJECTS = ["acme-web", "payments-api", "ml-pipeline", "design-system", "cli-tools", "docs-site"].map(
  (p) => `/Users/demo/code/${p}`
);
const HOURS = [0.3, 0.2, 0.1, 0.05, 0.05, 0.05, 0.1, 0.3, 0.7, 1.2, 1.5, 1.4, 0.8, 1.1, 1.5, 1.6, 1.5, 1.2, 0.8, 0.7, 0.9, 1.0, 0.8, 0.5].map(
  (w, h) => [h, w]
);

const ymd = (d) => d.toISOString().slice(0, 10);
const today = new Date();
today.setUTCHours(0, 0, 0, 0);
const rows = new Map(), hours = new Map();

for (let i = 364; i >= 0; i--) {
  const d = new Date(today);
  d.setUTCDate(d.getUTCDate() - i);
  const weekend = [0, 6].includes(d.getUTCDay());
  // Usage ramps up over the year, with quiet weekends and some days off.
  const ramp = 0.15 + 0.85 * ((364 - i) / 364) ** 1.6;
  if (rand() < (weekend ? 0.55 : 0.12)) continue;
  const requests = Math.round((weekend ? 60 : 180) * ramp * (0.5 + rand()));
  for (let n = 0; n < requests; n++) {
    const [agent, , models] = pick(AGENTS.map((a) => [a, a[1]]));
    const model = models[Math.floor(rand() * models.length)];
    const project = pick(PROJECTS.map((p, j) => [p, 6 - j]));
    const hour = pick(HOURS);
    const big = model.includes("opus") || model.includes("sol") ? 1 : 0.4;
    const t = {
      input: Math.round(800 * rand() * big),
      output: Math.round((1500 + 4000 * rand()) * big),
      cache_read: Math.round((90000 + 160000 * rand()) * big),
      cache_write: Math.round(6000 * rand() * big),
    };
    const date = ymd(d);
    const k = [date, agent, model, project].join("|");
    const r = rows.get(k) || { date, agent, model, project, requests: 0, input: 0, output: 0, cache_read: 0, cache_write: 0, reasoning: 0 };
    r.requests++;
    for (const f of Object.keys(t)) r[f] += t[f];
    rows.set(k, r);
    const hk = [date, hour, agent].join("|");
    const h = hours.get(hk) || { date, hour, agent, requests: 0, tokens: 0 };
    h.requests++;
    h.tokens += t.input + t.output + t.cache_read + t.cache_write;
    hours.set(hk, h);
  }
}

const count = (name) => [...rows.values()].filter((r) => r.agent.startsWith(name)).reduce((s, r) => s + r.requests, 0);
const report = {
  rows: [...rows.values()].sort((a, b) => b.date.localeCompare(a.date)),
  hours: [...hours.values()],
  sources: [
    { agent: "Claude Code", paths: ["/Users/demo/.claude/projects"], found: true, events: count("Claude"), errors: [] },
    { agent: "Codex", paths: ["/Users/demo/.codex/sessions"], found: true, events: count("Codex"), errors: [] },
    { agent: "OpenCode", paths: ["/Users/demo/.local/share/opencode"], found: true, events: count("OpenCode"), errors: [] },
    { agent: "OpenClaw", paths: [], found: false, events: 0, errors: [] },
    { agent: "DeepSeek Harness", paths: [], found: false, events: 0, errors: [] },
  ],
  generated_at: new Date().toISOString(),
  scan_ms: 48,
};
mkdirSync(new URL("../dev/", import.meta.url), { recursive: true });
writeFileSync(new URL("../dev/demo-report.json", import.meta.url), JSON.stringify(report));
console.log(`dev/demo-report.json: ${report.rows.length} rows`);
