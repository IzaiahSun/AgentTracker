//! Codex rollouts: `$CODEX_HOME/{sessions,archived_sessions}/**/rollout-*.jsonl`.
//!
//! The desktop app and the CLI share the directory; `session_meta.originator`
//! tells them apart. Usage comes from `token_count` events; the model from the
//! latest `turn_context`.

use super::{find_files, for_each_line, home, open, status, FileCache};
use crate::model::{json_ts, u, Event, SourceStatus, Tokens};
use serde_json::Value;
use std::path::{Path, PathBuf};

pub const DESKTOP: &str = "Codex Desktop";
pub const CLI: &str = "Codex CLI";
pub const IDE: &str = "Codex IDE";

fn roots() -> Vec<PathBuf> {
    let base = std::env::var("CODEX_HOME")
        .map(PathBuf::from)
        .unwrap_or_else(|_| home().join(".codex"));
    super::existing_dirs(vec![base.join("sessions"), base.join("archived_sessions")])
}

pub fn collect(cache: &FileCache) -> (Vec<Event>, SourceStatus) {
    let roots = roots();
    let files = find_files(&roots, |n| n.ends_with(".jsonl"));
    let (events, errors) = cache.parse_all(&files, parse_file);
    let n = events.len();
    (events, status("Codex", &roots, n, errors))
}

fn agent_for(originator: &str) -> &'static str {
    let o = originator.to_ascii_lowercase();
    if o.contains("desktop") || o.contains("app") {
        DESKTOP
    } else if o.contains("vscode") || o.contains("ide") || o.contains("jetbrains") {
        IDE
    } else {
        CLI
    }
}

fn parse_file(path: &Path) -> Result<Vec<Event>, String> {
    let mut out = Vec::new();
    let mut agent = CLI;
    let mut model = String::from("unknown");
    let mut last_total: Option<u64> = None;
    for_each_line(open(path)?, |line| {
        let is_meta = line.contains("\"session_meta\"");
        let is_ctx = line.contains("\"turn_context\"");
        let is_tok = line.contains("\"token_count\"");
        if !(is_meta || is_ctx || is_tok) {
            return;
        }
        let Ok(v) = serde_json::from_str::<Value>(line) else { return };
        let payload = v.get("payload").unwrap_or(&Value::Null);
        match v.get("type").and_then(Value::as_str) {
            Some("session_meta") => {
                if let Some(o) = payload.get("originator").and_then(Value::as_str) {
                    agent = agent_for(o);
                }
                if let Some(m) = payload.get("model").and_then(Value::as_str) {
                    model = m.to_string();
                }
            }
            Some("turn_context") => {
                if let Some(m) = payload.get("model").and_then(Value::as_str) {
                    model = m.to_string();
                }
            }
            Some("event_msg") if payload.get("type").and_then(Value::as_str) == Some("token_count") => {
                let Some(info) = payload.get("info").filter(|i| !i.is_null()) else { return };
                // token_count is re-emitted (e.g. on rate-limit updates) with an
                // unchanged running total; only count events that advance it.
                let total = info.get("total_token_usage").map(|t| u(t, "total_tokens"));
                if total.is_some() && total == last_total {
                    return;
                }
                last_total = total;
                let Some(last) = info.get("last_token_usage") else { return };
                let Some(ts) = v.get("timestamp").and_then(json_ts) else { return };
                let input = u(last, "input_tokens");
                let cached = u(last, "cached_input_tokens");
                let tokens = Tokens {
                    input: input.saturating_sub(cached),
                    output: u(last, "output_tokens"),
                    cache_read: cached,
                    cache_write: u(last, "cache_write_input_tokens"),
                    reasoning: u(last, "reasoning_output_tokens"),
                };
                if tokens.is_zero() {
                    return;
                }
                // Forked rollouts replay the parent's events verbatim.
                let key = Some(format!(
                    "codex:{}:{}",
                    v.get("timestamp").and_then(Value::as_str).unwrap_or(""),
                    total.unwrap_or(0)
                ));
                out.push(Event { key, ts_ms: ts, agent, model: model.clone(), tokens });
            }
            _ => {}
        }
    });
    Ok(out)
}
