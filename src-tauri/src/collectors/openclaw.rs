//! OpenClaw transcripts.
//!
//! - JSONL: `~/.openclaw/agents/<agent>/sessions/<session>.jsonl`
//! - SQLite (newer): `~/.openclaw/agents/<agent>/agent/openclaw-agent.sqlite`,
//!   table `transcript_events` holding the same JSON entries (optionally zstd).
//!
//! Assistant entries carry `message.usage {input, output, cacheRead, cacheWrite}`
//! and `message.model`.

use super::{find_files, for_each_line, has_table, home, open, open_sqlite, status, FileCache};
use crate::model::{json_ts, u, Event, SourceStatus, Tokens};
use serde_json::Value;
use std::path::{Path, PathBuf};

pub const AGENT: &str = "OpenClaw";

fn roots() -> Vec<PathBuf> {
    let mut defaults = Vec::new();
    if let Ok(state) = std::env::var("OPENCLAW_STATE_DIR") {
        defaults.push(PathBuf::from(state).join("agents"));
    }
    defaults.push(home().join(".openclaw/agents"));
    defaults.push(home().join(".clawdbot/agents"));
    super::roots("OPENCLAW_DIR", defaults)
}

pub fn collect(cache: &FileCache) -> (Vec<Event>, SourceStatus) {
    let roots = roots();
    let files = find_files(&roots, |n| {
        n.ends_with(".jsonl") && !n.ends_with(".trajectory.jsonl")
    });
    let (mut events, mut errors) = cache.parse_all(&files, parse_file);
    for db in find_files(&roots, |n| n == "openclaw-agent.sqlite") {
        match read_db(&db) {
            Ok(ev) => events.extend(ev),
            Err(e) => errors.push(e),
        }
    }
    let n = events.len();
    (events, status(AGENT, &roots, n, errors))
}

fn event_from(v: &Value) -> Option<Event> {
    if v.get("type").and_then(Value::as_str) != Some("message") {
        return None;
    }
    let msg = v.get("message")?;
    if msg.get("role").and_then(Value::as_str) != Some("assistant") {
        return None;
    }
    let usage = msg.get("usage")?;
    let tokens = Tokens {
        input: u(usage, "input"),
        output: u(usage, "output"),
        cache_read: u(usage, "cacheRead"),
        cache_write: u(usage, "cacheWrite"),
        reasoning: 0,
    };
    if tokens.is_zero() {
        return None;
    }
    let ts = v
        .get("timestamp")
        .and_then(json_ts)
        .or_else(|| msg.get("timestamp").and_then(json_ts))?;
    let model = msg
        .get("model")
        .or_else(|| v.get("model"))
        .and_then(Value::as_str)
        .unwrap_or("unknown")
        .to_string();
    Some(Event {
        key: v
            .get("id")
            .and_then(Value::as_str)
            .map(|id| format!("openclaw:{id}")),
        ts_ms: ts,
        agent: AGENT,
        model,
        tokens,
    })
}

fn parse_file(path: &Path) -> Result<Vec<Event>, String> {
    let mut out = Vec::new();
    for_each_line(open(path)?, |line| {
        if !line.contains("\"usage\"") {
            return;
        }
        if let Ok(v) = serde_json::from_str::<Value>(line) {
            out.extend(event_from(&v));
        }
    });
    Ok(out)
}

fn read_db(path: &Path) -> Result<Vec<Event>, String> {
    let conn = open_sqlite(path)?;
    if !has_table(&conn, "transcript_events") {
        return Ok(Vec::new());
    }
    let has_zstd = conn
        .prepare("SELECT 1 FROM pragma_table_info('transcript_events') WHERE name = 'event_zstd'")
        .and_then(|mut s| s.exists([]))
        .unwrap_or(false);
    let sql = if has_zstd {
        "SELECT event_json, event_zstd FROM transcript_events"
    } else {
        "SELECT event_json, NULL FROM transcript_events"
    };
    let mut stmt = conn.prepare(sql).map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([], |r| Ok((r.get::<_, Option<String>>(0)?, r.get::<_, Option<Vec<u8>>>(1)?)))
        .map_err(|e| e.to_string())?;
    let mut out = Vec::new();
    for (text, blob) in rows.flatten() {
        let json = match (text, blob) {
            (Some(t), _) => t,
            (None, Some(b)) => match zstd::decode_all(&b[..]) {
                Ok(d) => String::from_utf8_lossy(&d).into_owned(),
                Err(_) => continue,
            },
            _ => continue,
        };
        if !json.contains("\"usage\"") {
            continue;
        }
        if let Ok(v) = serde_json::from_str::<Value>(&json) {
            out.extend(event_from(&v));
        }
    }
    Ok(out)
}
