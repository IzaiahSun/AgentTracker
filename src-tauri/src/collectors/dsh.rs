//! DeepSeek Harness (dsh) session logs: `$DSH_HOME/sessions/**/session[.vN].jsonl[.zstd]`.
//!
//! The first line is a header (`id`, `createdAt`, optional `seedLength`);
//! events follow as `{type, seq, time, data}`. Usage is reported once per
//! (turn, step) on `assistant/message` (`data.usage` or a `usage` chunk inside
//! `data.stream`), falling back to a streamed `assistant/chunk` usage chunk.
//! `compaction/summary` events carry their own usage and model.
//! Events with `seq < seedLength` were copied from a parent session.

use super::{find_files, for_each_line, home, open, status, FileCache};
use crate::model::{epoch_to_ms, u, Event, SourceStatus, Tokens};
use serde_json::Value;
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

pub const AGENT: &str = "DeepSeek Harness";

fn roots() -> Vec<PathBuf> {
    let mut defaults = Vec::new();
    if let Ok(h) = std::env::var("DSH_HOME") {
        defaults.push(PathBuf::from(h).join("sessions"));
    }
    defaults.push(home().join(".dsh/sessions"));
    super::roots("DEEPSEEK_HARNESS_SESSIONS_DIR", defaults)
}

fn is_session_log(name: &str) -> bool {
    name.starts_with("session") && (name.ends_with(".jsonl") || name.ends_with(".jsonl.zstd"))
}

pub fn collect(cache: &FileCache) -> (Vec<Event>, SourceStatus) {
    let roots = roots();
    let files = find_files(&roots, is_session_log);
    let (events, errors) = cache.parse_all(&files, parse_file);
    let n = events.len();
    (events, status(AGENT, &roots, n, errors))
}

fn usage_of(v: &Value) -> Tokens {
    Tokens {
        input: u(v, "inputTokens"),
        output: u(v, "outputTokens"),
        cache_read: u(v, "cacheReadTokens"),
        cache_write: u(v, "cacheWriteTokens"),
        reasoning: u(v, "reasoningTokens"),
    }
}

/// Finds a `{type:"usage", usage:{..}}` chunk in `data.stream[].chunk`.
fn stream_usage(data: &Value) -> Option<Tokens> {
    data.get("stream")?
        .as_array()?
        .iter()
        .filter_map(|item| item.get("chunk"))
        .filter(|c| c.get("type").and_then(Value::as_str) == Some("usage"))
        .filter_map(|c| c.get("usage"))
        .last()
        .map(usage_of)
}

#[derive(Default)]
struct Step {
    request_model: Option<String>,
    final_model: Option<String>,
    final_usage: Option<(Tokens, i64)>,
    chunk_usage: Option<(Tokens, i64)>,
}

fn parse_file(path: &Path) -> Result<Vec<Event>, String> {
    let file = open(path)?;
    let mut header: Option<Value> = None;
    let mut session_id = String::new();
    let mut seed_len: i64 = 0;
    let mut cwd: Option<String> = None;
    let mut latest_model: Option<String> = None;
    let mut steps: BTreeMap<(i64, i64), Step> = BTreeMap::new();
    let mut out = Vec::new();

    let mut on_line = |line: &str| {
        let Ok(v) = serde_json::from_str::<Value>(line) else { return };
        if header.is_none() {
            session_id = v.get("id").and_then(Value::as_str).unwrap_or_default().to_string();
            seed_len = v.get("seedLength").and_then(Value::as_i64).unwrap_or(0);
            cwd = ["cwd", "workspace", "workingDirectory"]
                .iter()
                .find_map(|k| v.get(*k).and_then(Value::as_str))
                .map(str::to_string);
            header = Some(v);
            return;
        }
        let Some(ty) = v.get("type").and_then(Value::as_str) else { return };
        let seq = v.get("seq").and_then(Value::as_i64).unwrap_or(i64::MAX);
        let time = v.get("time").and_then(Value::as_i64).map(epoch_to_ms).unwrap_or(0);
        let data = v.get("data").unwrap_or(&Value::Null);
        let turn_step = || {
            Some((data.get("turn")?.as_i64()?, data.get("step")?.as_i64()?))
        };

        // Track the request model even in the inherited prefix so the first
        // owned step knows which model it runs on.
        if ty == "request/header" {
            if let Some(m) = data
                .pointer("/header/config/model")
                .and_then(Value::as_str)
            {
                latest_model = Some(m.to_string());
            }
        }
        if seq < seed_len {
            return;
        }
        match ty {
            "step/start" | "request/header" => {
                if let Some(k) = turn_step() {
                    steps.entry(k).or_default().request_model = latest_model.clone();
                }
            }
            "assistant/chunk" => {
                let Some(k) = turn_step() else { return };
                let Some(chunk) = data.get("chunk") else { return };
                if chunk.get("type").and_then(Value::as_str) == Some("usage") {
                    if let Some(us) = chunk.get("usage") {
                        let s = steps.entry(k).or_default();
                        s.chunk_usage = Some((usage_of(us), time));
                        if s.request_model.is_none() {
                            s.request_model = latest_model.clone();
                        }
                    }
                }
            }
            "assistant/message" => {
                let Some(k) = turn_step() else { return };
                let s = steps.entry(k).or_default();
                if s.request_model.is_none() {
                    s.request_model = latest_model.clone();
                }
                if let Some(m) = data.pointer("/message/source/model").and_then(Value::as_str) {
                    s.final_model = Some(m.to_string());
                }
                let usage = data.get("usage").map(usage_of).or_else(|| stream_usage(data));
                if let Some(us) = usage {
                    s.final_usage = Some((us, time));
                }
            }
            "compaction/summary" => {
                let Some(us) = data.get("usage") else { return };
                let tokens = usage_of(us);
                if tokens.is_zero() {
                    return;
                }
                let id = data.get("compactionId").and_then(Value::as_str).unwrap_or("");
                out.push(Event {
                    key: Some(format!("dsh:{session_id}:compaction:{id}:{seq}")),
                    ts_ms: time,
                    agent: AGENT,
                    model: data
                        .get("model")
                        .and_then(Value::as_str)
                        .unwrap_or("unknown")
                        .to_string(),
                    cwd: cwd.clone(),
                    tokens,
                });
            }
            _ => {}
        }
    };

    let name = path.file_name().and_then(|n| n.to_str()).unwrap_or("");
    if name.ends_with(".zstd") {
        let dec = zstd::stream::read::Decoder::new(file).map_err(|e| e.to_string())?;
        for_each_line(dec, &mut on_line);
    } else {
        for_each_line(file, &mut on_line);
    }

    let created = header
        .as_ref()
        .and_then(|h| h.get("createdAt"))
        .and_then(Value::as_i64)
        .map(epoch_to_ms)
        .unwrap_or(0);
    for ((turn, step), s) in steps {
        let Some((tokens, time)) = s.final_usage.or(s.chunk_usage) else { continue };
        if tokens.is_zero() {
            continue;
        }
        out.push(Event {
            key: Some(format!("dsh:{session_id}:{turn}:{step}")),
            ts_ms: if time > 0 { time } else { created },
            agent: AGENT,
            model: s
                .final_model
                .or(s.request_model)
                .unwrap_or_else(|| "unknown".into()),
            cwd: cwd.clone(),
            tokens,
        });
    }
    Ok(out)
}
