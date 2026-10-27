//! ZCode (Z.ai): `~/.zcode/cli/db/db.sqlite` (`$ZCODE_DATA_BASE_DIR/.zcode/...`).
//!
//! The CLI, TUI and desktop app share one runtime and database. Assistant rows
//! in `message` carry OpenCode-style usage (`modelId`, `tokens {input, output,
//! reasoning, cache {read, write}}`, `time.created`, `path`). The per-request
//! `model_usage` table is pruned after 30 days, so it is not used.

use super::{has_table, home, open_sqlite, status};
use crate::model::{json_ts, u, Event, SourceStatus, Tokens};
use serde_json::Value;
use std::path::{Path, PathBuf};

pub const AGENT: &str = "ZCode";

fn roots() -> Vec<PathBuf> {
    let mut defaults = Vec::new();
    if let Ok(base) = std::env::var("ZCODE_DATA_BASE_DIR") {
        defaults.push(PathBuf::from(base).join(".zcode/cli/db"));
    }
    defaults.push(home().join(".zcode/cli/db"));
    super::existing_dirs(defaults)
}

pub fn collect(_: &super::FileCache) -> (Vec<Event>, SourceStatus) {
    let roots = roots();
    let mut events = Vec::new();
    let mut errors = Vec::new();
    for root in &roots {
        let db = root.join("db.sqlite");
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

fn event_from(id: &str, v: &Value, fallback_ts: Option<i64>, session_dir: Option<&str>) -> Option<Event> {
    if v.get("role").and_then(Value::as_str) != Some("assistant") {
        return None;
    }
    let t = v.get("tokens")?;
    let cache = t.get("cache").unwrap_or(&Value::Null);
    let reasoning = u(t, "reasoning");
    let tokens = Tokens {
        input: u(t, "input"),
        // Reasoning is reported separately from output, as in OpenCode.
        output: u(t, "output") + reasoning,
        cache_read: u(cache, "read"),
        cache_write: u(cache, "write"),
        reasoning,
    };
    if tokens.is_zero() {
        return None;
    }
    let ts = v
        .get("time")
        .and_then(|t| t.get("created"))
        .and_then(json_ts)
        .or(fallback_ts)?;
    let path = v.get("path");
    let cwd = path
        .and_then(|p| p.get("root"))
        .and_then(Value::as_str)
        .filter(|r| *r != "/" && !r.is_empty())
        .or_else(|| path.and_then(|p| p.get("cwd")).and_then(Value::as_str))
        .or(session_dir)
        .map(str::to_string);
    Some(Event {
        key: Some(format!("zcode:{id}")),
        requests: 1,
        ts_ms: ts,
        agent: AGENT,
        model: v
            .get("modelId")
            .or_else(|| v.get("modelID"))
            .and_then(Value::as_str)
            .unwrap_or("unknown")
            .to_string(),
        cwd,
        tokens,
    })
}

fn read_db(path: &Path) -> Result<Vec<Event>, String> {
    let conn = open_sqlite(path)?;
    if !has_table(&conn, "message") {
        return Ok(Vec::new());
    }
    let dir = if has_table(&conn, "session") {
        "(SELECT directory FROM session s WHERE s.id = m.session_id)"
    } else {
        "NULL"
    };
    let sql = format!("SELECT m.id, m.data, m.time_created, {dir} FROM message m");
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
    let mut out = Vec::new();
    for (id, data, created, session_dir) in rows.flatten() {
        if !data.contains("\"tokens\"") {
            continue;
        }
        if let Ok(v) = serde_json::from_str::<Value>(&data) {
            out.extend(event_from(&id, &v, created, session_dir.as_deref()));
        }
    }
    Ok(out)
}
