mod collectors;
mod model;
mod project;
mod tray;
mod update;

use collectors::FileCache;
use model::{local_date_hour, DailyRow, Event, HourRow, Report, SourceStatus, Tokens};
use rayon::prelude::*;
use std::collections::{HashMap, HashSet};
use std::time::Instant;
use tauri::Manager;

type Collector = fn(&FileCache) -> (Vec<Event>, SourceStatus);

const COLLECTORS: &[Collector] = &[
    collectors::claude::collect,
    collectors::codex::collect,
    collectors::opencode::collect,
    collectors::openclaw::collect,
    collectors::dsh::collect,
    collectors::zcode::collect,
    collectors::hermes::collect,
];

pub fn build_report(cache: &FileCache) -> Report {
    let start = Instant::now();
    let results: Vec<(Vec<Event>, SourceStatus)> =
        COLLECTORS.par_iter().map(|c| c(cache)).collect();

    let mut seen: HashSet<String> = HashSet::new();
    let mut projects = project::Resolver::new();
    type DayKey = (String, &'static str, String, String);
    let mut buckets: HashMap<DayKey, (u64, Tokens)> = HashMap::new();
    let mut hourly: HashMap<(String, u32, &'static str), (u64, u64)> = HashMap::new();
    let mut sources = Vec::new();
    for (events, status) in results {
        for e in events {
            if let Some(k) = e.key {
                if !seen.insert(k) {
                    continue;
                }
            }
            let (date, hour) = local_date_hour(e.ts_ms);
            let project = projects.resolve(e.cwd.as_deref());
            let h = hourly.entry((date.clone(), hour, e.agent)).or_default();
            h.0 += e.requests;
            h.1 += e.tokens.input + e.tokens.output + e.tokens.cache_read + e.tokens.cache_write;
            let b = buckets.entry((date, e.agent, e.model, project)).or_default();
            b.0 += e.requests;
            b.1.add(&e.tokens);
        }
        sources.push(status);
    }

    let mut rows: Vec<DailyRow> = buckets
        .into_iter()
        .map(|((date, agent, model, project), (requests, tokens))| DailyRow {
            date,
            agent,
            model,
            project,
            requests,
            tokens,
        })
        .collect();
    rows.sort_by(|a, b| {
        b.date
            .cmp(&a.date)
            .then(a.agent.cmp(b.agent))
            .then(a.model.cmp(&b.model))
            .then(a.project.cmp(&b.project))
    });
    let mut hours: Vec<HourRow> = hourly
        .into_iter()
        .map(|((date, hour, agent), (requests, tokens))| HourRow { date, hour, agent, requests, tokens })
        .collect();
    hours.sort_by(|a, b| b.date.cmp(&a.date).then(a.hour.cmp(&b.hour)).then(a.agent.cmp(b.agent)));

    Report {
        rows,
        hours,
        sources,
        generated_at: chrono::Local::now().to_rfc3339(),
        scan_ms: start.elapsed().as_millis(),
    }
}

#[tauri::command]
async fn get_report(app: tauri::AppHandle) -> Result<Report, String> {
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

/// Writes an exported image to the Downloads folder (or home) without
/// overwriting, and returns its path.
#[tauri::command]
fn save_image(name: String, bytes: Vec<u8>) -> Result<String, String> {
    let dir = dirs::download_dir()
        .or_else(dirs::home_dir)
        .ok_or("no download directory")?;
    let name = std::path::Path::new(&name)
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("agenttracker.png")
        .to_string();
    let (stem, ext) = name.rsplit_once('.').unwrap_or((&name, "png"));
    let mut path = dir.join(&name);
    let mut i = 2;
    while path.exists() {
        path = dir.join(format!("{stem} ({i}).{ext}"));
        i += 1;
    }
    std::fs::write(&path, bytes).map_err(|e| e.to_string())?;
    Ok(path.display().to_string())
}

/// Shows a file in Finder / Explorer / the file manager.
#[tauri::command]
fn reveal(path: String) -> Result<(), String> {
    use std::process::Command;
    let res = if cfg!(target_os = "macos") {
        Command::new("open").arg("-R").arg(&path).spawn()
    } else if cfg!(windows) {
        Command::new("explorer").arg(format!("/select,{path}")).spawn()
    } else {
        let dir = std::path::Path::new(&path).parent().map(|p| p.to_path_buf()).unwrap_or_default();
        Command::new("xdg-open").arg(dir).spawn()
    };
    res.map(|_| ()).map_err(|e| e.to_string())
}

/// Headless mode: `agent-tracker --report` prints the report as JSON.
pub fn print_report() {
    let report = build_report(&FileCache::default());
    println!("{}", serde_json::to_string_pretty(&report).unwrap());
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let headless_update = std::env::args().any(|a| a == "--update");
    tauri::Builder::default()
        .plugin(tauri_plugin_updater::Builder::new().build())
        .manage(FileCache::default())
        .setup(move |app| {
            if headless_update {
                update::run_headless(app.handle());
            } else {
                tray::setup(app.handle())?;
            }
            Ok(())
        })
        .on_window_event(|window, event| {
            // Keep running in the menu bar / tray; quit from its menu.
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                if window.app_handle().tray_by_id("main").is_some() {
                    api.prevent_close();
                    let _ = window.hide();
                }
            }
        })
        .invoke_handler(tauri::generate_handler![
            get_report,
            system_locale,
            save_image,
            reveal,
            tray::update_tray,
            update::check_update,
            update::install_update
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app, event| {
            // macOS: clicking the Dock icon brings the hidden window back.
            #[cfg(target_os = "macos")]
            if let tauri::RunEvent::Reopen { .. } = event {
                tray::show_main(app);
            }
            let _ = (app, event);
        });
}
