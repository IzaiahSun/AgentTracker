mod collectors;
mod model;

use collectors::FileCache;
use model::{local_date, DailyRow, Event, Report, SourceStatus, Tokens};
use rayon::prelude::*;
use std::collections::{HashMap, HashSet};
use std::time::Instant;

type Collector = fn(&FileCache) -> (Vec<Event>, SourceStatus);

const COLLECTORS: &[Collector] = &[
    collectors::claude::collect,
    collectors::codex::collect,
    collectors::opencode::collect,
    collectors::openclaw::collect,
    collectors::dsh::collect,
];

pub fn build_report(cache: &FileCache) -> Report {
    let start = Instant::now();
    let results: Vec<(Vec<Event>, SourceStatus)> =
        COLLECTORS.par_iter().map(|c| c(cache)).collect();

    let mut seen: HashSet<String> = HashSet::new();
    let mut buckets: HashMap<(String, &'static str, String), (u64, Tokens)> = HashMap::new();
    let mut sources = Vec::new();
    for (events, status) in results {
        for e in events {
            if let Some(k) = e.key {
                if !seen.insert(k) {
                    continue;
                }
            }
            let b = buckets
                .entry((local_date(e.ts_ms), e.agent, e.model))
                .or_default();
            b.0 += 1;
            b.1.add(&e.tokens);
        }
        sources.push(status);
    }

    let mut rows: Vec<DailyRow> = buckets
        .into_iter()
        .map(|((date, agent, model), (requests, tokens))| DailyRow {
            date,
            agent,
            model,
            requests,
            tokens,
        })
        .collect();
    rows.sort_by(|a, b| {
        b.date
            .cmp(&a.date)
            .then(a.agent.cmp(b.agent))
            .then(a.model.cmp(&b.model))
    });

    Report {
        rows,
        sources,
        generated_at: chrono::Local::now().to_rfc3339(),
        scan_ms: start.elapsed().as_millis(),
    }
}

#[tauri::command]
async fn get_report(app: tauri::AppHandle) -> Result<Report, String> {
    use tauri::Manager;
    // Parsing is CPU-bound; keep it off the async runtime's workers.
    tauri::async_runtime::spawn_blocking(move || build_report(&app.state::<FileCache>()))
        .await
        .map_err(|e| e.to_string())
}

/// OS locale (e.g. "zh-CN"). The webview's navigator.language follows the app
/// bundle's localizations on macOS rather than the system language.
#[tauri::command]
fn system_locale() -> Option<String> {
    sys_locale::get_locale()
}

/// Headless mode: `agent-tracker --report` prints the report as JSON.
pub fn print_report() {
    let report = build_report(&FileCache::default());
    println!("{}", serde_json::to_string_pretty(&report).unwrap());
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .manage(FileCache::default())
        .invoke_handler(tauri::generate_handler![get_report, system_locale])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
