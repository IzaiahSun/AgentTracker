//! Claude Code transcripts: `<config>/projects/<project>/<session>.jsonl`.
//!
//! The desktop app's Code tab and the CLI write to the same directory; the
//! `entrypoint` field on each line tells them apart. Cowork (local agent
//! mode) keeps its own `.claude/projects` under the desktop app's data dir.

use super::{find_files, for_each_line, home, open, status, FileCache};
use crate::model::{json_ts, u, Event, SourceStatus, Tokens};
use serde_json::Value;
use std::path::{Path, PathBuf};

pub const DESKTOP: &str = "Claude Code Desktop";
pub const CLI: &str = "Claude Code CLI";
pub const SDK: &str = "Claude Code SDK";
pub const COWORK: &str = "Claude Cowork";

fn roots() -> Vec<PathBuf> {
    let mut defaults = Vec::new();
    if let Ok(v) = std::env::var("CLAUDE_CONFIG_DIR") {
        for p in v.split(',').filter(|s| !s.trim().is_empty()) {
            defaults.push(PathBuf::from(p.trim()).join("projects"));
        }
    }
    defaults.push(home().join(".claude/projects"));
    defaults.push(home().join(".config/claude/projects"));
    if let Some(cfg) = dirs::config_dir() {
        defaults.push(cfg.join("Claude/local-agent-mode-sessions"));
    }
    super::existing_dirs(defaults)
}

pub fn collect(cache: &FileCache) -> (Vec<Event>, SourceStatus) {
    let roots = roots();
    let files = find_files(&roots, |n| n.ends_with(".jsonl") && n != "audit.jsonl");
    let (events, errors) = cache.parse_all(&files, parse_file);
    let n = events.len();
    (events, status("Claude Code", &roots, n, errors))
}

fn agent_for(entrypoint: Option<&str>, cowork: bool) -> &'static str {
    if cowork {
        return COWORK;
    }
    match entrypoint {
        Some("claude-desktop") => DESKTOP,
        Some(e) if e.starts_with("sdk") => SDK,
        _ => CLI,
    }
}

fn parse_file(path: &Path) -> Result<Vec<Event>, String> {
    let cowork = path
        .components()
        .any(|c| c.as_os_str() == "local-agent-mode-sessions");
    let mut out = Vec::new();
    // The session's starting directory; later lines may `cd` into subdirs.
    let mut cwd: Option<String> = None;
    for_each_line(open(path)?, |line| {
        // Cheap prefilter: only assistant lines carry usage.
        if !line.contains("\"usage\"") || !line.contains("\"assistant\"") {
            return;
        }
        let Ok(v) = serde_json::from_str::<Value>(line) else { return };
        if v.get("type").and_then(Value::as_str) != Some("assistant") {
            return;
        }
        if v.get("isApiErrorMessage").and_then(Value::as_bool) == Some(true) {
            return;
        }
        if cwd.is_none() {
            cwd = v.get("cwd").and_then(Value::as_str).map(str::to_string);
        }
        let Some(msg) = v.get("message") else { return };
        let Some(usage) = msg.get("usage") else { return };
        let model = msg.get("model").and_then(Value::as_str).unwrap_or("unknown");
        if model == "<synthetic>" {
            return;
        }
        let Some(ts) = v.get("timestamp").and_then(json_ts) else { return };
        let tokens = Tokens {
            input: u(usage, "input_tokens"),
            output: u(usage, "output_tokens"),
            cache_read: u(usage, "cache_read_input_tokens"),
            cache_write: u(usage, "cache_creation_input_tokens"),
            reasoning: usage
                .get("output_tokens_details")
                .map(|d| u(d, "thinking_tokens"))
                .unwrap_or(0),
        };
        if tokens.is_zero() {
            return;
        }
        // Streaming writes one line per content block with the same usage;
        // resumed/forked sessions copy earlier lines into new files.
        let key = match (
            msg.get("id").and_then(Value::as_str),
            v.get("requestId").and_then(Value::as_str),
        ) {
            (Some(id), Some(req)) => Some(format!("claude:{id}:{req}")),
            (Some(id), None) => Some(format!("claude:{id}")),
            _ => None,
        };
        out.push(Event {
            key,
            ts_ms: ts,
            agent: agent_for(v.get("entrypoint").and_then(Value::as_str), cowork),
            model: model.to_string(),
            cwd: cwd.clone(),
            tokens,
        });
    });
    Ok(out)
}
