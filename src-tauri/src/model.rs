use chrono::{DateTime, Local, TimeZone, Utc};
use serde::Serialize;

/// Normalized token counts for one model request.
///
/// `input` excludes cached tokens; `output` includes reasoning tokens.
/// `reasoning` is informational (already part of `output`).
#[derive(Clone, Copy, Debug, Default, Serialize)]
pub struct Tokens {
    pub input: u64,
    pub output: u64,
    pub cache_read: u64,
    pub cache_write: u64,
    pub reasoning: u64,
}

impl Tokens {
    pub fn is_zero(&self) -> bool {
        self.input == 0 && self.output == 0 && self.cache_read == 0 && self.cache_write == 0
    }

    pub fn add(&mut self, o: &Tokens) {
        self.input += o.input;
        self.output += o.output;
        self.cache_read += o.cache_read;
        self.cache_write += o.cache_write;
        self.reasoning += o.reasoning;
    }
}

/// One model request attributed to an agent.
#[derive(Clone, Debug)]
pub struct Event {
    /// Global dedup key (same request seen in several files/stores).
    pub key: Option<String>,
    pub ts_ms: i64,
    pub agent: &'static str,
    pub model: String,
    /// Working directory of the session, resolved to a project later.
    pub cwd: Option<String>,
    pub tokens: Tokens,
}

/// Aggregated row sent to the UI: one (local day, agent, model, project) bucket.
#[derive(Clone, Debug, Serialize)]
pub struct DailyRow {
    pub date: String,
    pub agent: &'static str,
    pub model: String,
    /// Project root path; "" when unknown, or a `project::TEMP`/`COWORK` bucket.
    pub project: String,
    pub requests: u64,
    #[serde(flatten)]
    pub tokens: Tokens,
}

/// Requests and tokens per (local day, hour of day, agent), for the weekly rhythm view.
#[derive(Clone, Debug, Serialize)]
pub struct HourRow {
    pub date: String,
    pub hour: u32,
    pub agent: &'static str,
    pub requests: u64,
    pub tokens: u64,
}

#[derive(Clone, Debug, Serialize)]
pub struct SourceStatus {
    pub agent: &'static str,
    pub paths: Vec<String>,
    pub found: bool,
    pub events: usize,
    pub errors: Vec<String>,
}

#[derive(Clone, Debug, Serialize)]
pub struct Report {
    pub rows: Vec<DailyRow>,
    pub hours: Vec<HourRow>,
    pub sources: Vec<SourceStatus>,
    pub generated_at: String,
    pub scan_ms: u128,
}

/// Local calendar day and hour of `ts_ms`.
pub fn local_date_hour(ts_ms: i64) -> (String, u32) {
    use chrono::Timelike;
    match Local.timestamp_millis_opt(ts_ms) {
        chrono::LocalResult::Single(t) | chrono::LocalResult::Ambiguous(t, _) => {
            (t.format("%Y-%m-%d").to_string(), t.hour())
        }
        chrono::LocalResult::None => ("unknown".into(), 0),
    }
}

pub fn parse_ts(s: &str) -> Option<i64> {
    DateTime::parse_from_rfc3339(s)
        .ok()
        .map(|t| t.with_timezone(&Utc).timestamp_millis())
}

/// Accepts epoch seconds or milliseconds.
pub fn epoch_to_ms(v: i64) -> i64 {
    if v > 100_000_000_000 {
        v
    } else {
        v * 1000
    }
}

/// Reads a timestamp that may be an RFC3339 string or an epoch number.
pub fn json_ts(v: &serde_json::Value) -> Option<i64> {
    match v {
        serde_json::Value::String(s) => parse_ts(s),
        serde_json::Value::Number(n) => n.as_i64().map(epoch_to_ms),
        _ => None,
    }
}

pub fn u(v: &serde_json::Value, key: &str) -> u64 {
    v.get(key).and_then(|x| x.as_u64()).unwrap_or(0)
}
