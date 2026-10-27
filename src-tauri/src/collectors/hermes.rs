//! Hermes Agent (Nous Research): `~/.hermes/state.db` (`$HERMES_HOME`,
//! `%LOCALAPPDATA%\hermes` on Windows), plus one `state.db` per named profile
//! under `profiles/<name>/`.
//!
//! Usage is only stored per (session, model): `session_model_usage` rows with
//! totals, a call count and first/last-seen times. Each row is attributed to
//! its last-seen time, so a session spanning midnight lands on its last day.
//! Databases older than that table fall back to the totals on `sessions`.

use super::{has_table, home, open_sqlite, status};
use crate::model::{Event, SourceStatus, Tokens};
use rusqlite::Connection;
use std::path::{Path, PathBuf};

pub const AGENT: &str = "Hermes Agent";

fn roots() -> Vec<PathBuf> {
    let mut defaults = Vec::new();
    if let Ok(h) = std::env::var("HERMES_HOME") {
        defaults.push(PathBuf::from(h));
    }
    defaults.push(home().join(".hermes"));
    if cfg!(windows) {
        if let Some(local) = dirs::data_local_dir() {
            defaults.push(local.join("hermes"));
        }
    }
    super::existing_dirs(defaults)
}

/// `state.db` in each root and in each of its profiles.
fn databases(roots: &[PathBuf]) -> Vec<PathBuf> {
    let mut out = Vec::new();
    for root in roots {
        out.push(root.join("state.db"));
        if let Ok(entries) = std::fs::read_dir(root.join("profiles")) {
            out.extend(entries.flatten().map(|e| e.path().join("state.db")));
        }
    }
    out.retain(|p| p.is_file());
    out
}

pub fn collect(_: &super::FileCache) -> (Vec<Event>, SourceStatus) {
    let roots = roots();
    let mut events = Vec::new();
    let mut errors = Vec::new();
    for db in databases(&roots) {
        match read_db(&db) {
            Ok(ev) => events.extend(ev),
            Err(e) => errors.push(e),
        }
    }
    let n = events.len();
    (events, status(AGENT, &roots, n, errors))
}

fn has_column(conn: &Connection, table: &str, column: &str) -> bool {
    conn.prepare(&format!("SELECT 1 FROM pragma_table_info('{table}') WHERE name = ?1"))
        .and_then(|mut s| s.exists([column]))
        .unwrap_or(false)
}

/// Epoch seconds (REAL, possibly fractional) or milliseconds -> ms.
fn secs_to_ms(v: Option<f64>) -> Option<i64> {
    v.filter(|x| *x > 0.0).map(|x| if x > 1e11 { x as i64 } else { (x * 1000.0) as i64 })
}

fn read_db(path: &Path) -> Result<Vec<Event>, String> {
    let conn = open_sqlite(path)?;
    if !has_table(&conn, "sessions") {
        return Ok(Vec::new());
    }
    let workdir = match (has_column(&conn, "sessions", "git_repo_root"), has_column(&conn, "sessions", "cwd")) {
        (true, true) => "COALESCE(s.git_repo_root, s.cwd)",
        (false, true) => "s.cwd",
        (true, false) => "s.git_repo_root",
        _ => "NULL",
    };
    let sql = if has_table(&conn, "session_model_usage") {
        format!(
            "SELECT u.session_id || ':' || u.model || ':' || u.billing_provider || ':' || u.billing_base_url
                    || ':' || u.billing_mode || ':' || u.task,
                    u.model, u.api_call_count, u.input_tokens, u.output_tokens, u.cache_read_tokens,
                    u.cache_write_tokens, u.reasoning_tokens,
                    COALESCE(u.last_seen, u.first_seen, s.ended_at, s.started_at), {workdir}
             FROM session_model_usage u LEFT JOIN sessions s ON s.id = u.session_id"
        )
    } else {
        format!(
            "SELECT s.id, s.model, s.api_call_count, s.input_tokens, s.output_tokens, s.cache_read_tokens,
                    s.cache_write_tokens, s.reasoning_tokens, COALESCE(s.ended_at, s.started_at), {workdir}
             FROM sessions s"
        )
    };
    let mut stmt = conn.prepare(&sql).map_err(|e| format!("{}: {e}", path.display()))?;
    let rows = stmt
        .query_map([], |r| {
            let n = |i: usize| r.get::<_, Option<i64>>(i).ok().flatten().unwrap_or(0).max(0) as u64;
            Ok((
                r.get::<_, Option<String>>(0)?.unwrap_or_default(),
                r.get::<_, Option<String>>(1)?.unwrap_or_else(|| "unknown".into()),
                n(2),
                Tokens { input: n(3), output: n(4), cache_read: n(5), cache_write: n(6), reasoning: n(7) },
                r.get::<_, Option<f64>>(8).ok().flatten(),
                r.get::<_, Option<String>>(9).ok().flatten(),
            ))
        })
        .map_err(|e| e.to_string())?;
    let mut out = Vec::new();
    for (key, model, calls, tokens, seen, cwd) in rows.flatten() {
        let Some(ts) = secs_to_ms(seen) else { continue };
        if tokens.is_zero() {
            continue;
        }
        out.push(Event {
            key: Some(format!("hermes:{key}")),
            requests: calls.max(1),
            ts_ms: ts,
            agent: AGENT,
            model,
            cwd,
            tokens,
        });
    }
    Ok(out)
}
