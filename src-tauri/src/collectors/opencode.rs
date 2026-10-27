//! OpenCode (CLI/TUI and desktop share one data dir: `$XDG_DATA_HOME/opencode`).
//!
//! Three generations of storage are read and deduplicated by message id:
//! legacy `storage/message/<session>/<msg>.json` files, the `message` table and
//! the newer `session_message` table in `opencode.db`.

use super::{find_files, has_table, home, open, open_sqlite, status, FileCache};
use crate::model::{json_ts, u, Event, SourceStatus, Tokens};
use serde_json::Value;
use std::path::{Path, PathBuf};

pub const AGENT: &str = "OpenCode";

fn roots() -> Vec<PathBuf> {
    let data = std::env::var("XDG_DATA_HOME")
        .map(PathBuf::from)
        .unwrap_or_else(|_| home().join(".local/share"));
    super::roots("OPENCODE_DATA_DIR", vec![data.join("opencode")])
}

pub fn collect(cache: &FileCache) -> (Vec<Event>, SourceStatus) {
    let roots = roots();
    let mut events = Vec::new();
    let mut errors = Vec::new();
    for root in &roots {
        let msg_dir = root.join("storage/message");
        if msg_dir.is_dir() {
            let files = find_files(&[msg_dir], |n| n.ends_with(".json"));
            let (ev, err) = cache.parse_all(&files, parse_json_file);
            events.extend(ev);
            errors.extend(err);
        }
        let db = root.join("opencode.db");
        if db.is_file() {
            match read_db(&db) {
                Ok(ev) => events.extend(ev),
                Err(e) => errors.push(e),
            }
        }
    }
    let n = events.len();
    (events, status(AGENT, &roots, n, errors))
}

/// Builds an event from an assistant message object (legacy or v2 shape).
fn event_from(id: &str, v: &Value, fallback_ts: Option<i64>, session_dir: Option<&str>) -> Option<Event> {
    if let Some(role) = v.get("role").and_then(Value::as_str) {
        if role != "assistant" {
            return None;
        }
    }
    let t = v.get("tokens")?;
    let cache = t.get("cache").unwrap_or(&Value::Null);
    let reasoning = u(t, "reasoning");
    let tokens = Tokens {
        input: u(t, "input"),
        // OpenCode reports reasoning separately from output.
        output: u(t, "output") + reasoning,
        cache_read: u(cache, "read"),
        cache_write: u(cache, "write"),
        reasoning,
    };
    if tokens.is_zero() {
        return None;
    }
    let model = v
        .get("modelID")
        .or_else(|| v.get("model").and_then(|m| m.get("id")))
        .and_then(Value::as_str)
        .unwrap_or("unknown")
        .to_string();
    let ts = v
        .get("time")
        .and_then(|t| t.get("created"))
        .and_then(json_ts)
        .or(fallback_ts)?;
    // `path.root` is the git worktree ("/" outside a repo); `path.cwd` the directory.
    let path = v.get("path");
    let cwd = path
        .and_then(|p| p.get("root"))
        .and_then(Value::as_str)
        .filter(|r| *r != "/" && !r.is_empty())
        .or_else(|| path.and_then(|p| p.get("cwd")).and_then(Value::as_str))
        .or(session_dir)
        .map(str::to_string);
    Some(Event {
        requests: 1,
        key: Some(format!("opencode:{id}")),
        ts_ms: ts,
        agent: AGENT,
        model,
        cwd,
        tokens,
    })
}

fn parse_json_file(path: &Path) -> Result<Vec<Event>, String> {
    let v: Value = serde_json::from_reader(open(path)?).map_err(|e| e.to_string())?;
    let id = v.get("id").and_then(Value::as_str).unwrap_or_default().to_string();
    Ok(event_from(&id, &v, None, None).into_iter().collect())
}

fn read_db(path: &Path) -> Result<Vec<Event>, String> {
    let conn = open_sqlite(path)?;
    let mut out = Vec::new();
    // Session directory as a fallback when the message has no `path`.
    let dir = |sessions: &str| {
        if has_table(&conn, sessions) {
            format!("(SELECT directory FROM {sessions} s WHERE s.id = m.session_id)")
        } else {
            "NULL".to_string()
        }
    };
    let queries = [
        (
            "message",
            format!("SELECT m.id, m.data, m.time_created, {} FROM message m", dir("session")),
        ),
        (
            "session_message",
            format!(
                "SELECT m.id, m.data, m.time_created, {} FROM session_message m WHERE m.type = 'assistant'",
                dir("session_v2")
            ),
        ),
    ];
    for (table, sql) in queries {
        if !has_table(&conn, table) {
            continue;
        }
        let mut stmt = conn.prepare(&sql).map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map([], |r| {
                Ok((
                    r.get::<_, String>(0)?,
                    r.get::<_, String>(1)?,
                    r.get::<_, i64>(2).ok(),
                    r.get::<_, Option<String>>(3).ok().flatten(),
                ))
            })
            .map_err(|e| e.to_string())?;
        for (id, data, created, session_dir) in rows.flatten() {
            if !data.contains("\"tokens\"") {
                continue;
            }
            if let Ok(v) = serde_json::from_str::<Value>(&data) {
                out.extend(event_from(&id, &v, created, session_dir.as_deref()));
            }
        }
    }
    Ok(out)
}
