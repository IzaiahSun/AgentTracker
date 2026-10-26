//! Self-update from GitHub releases (`latest.json` on the latest release).
//!
//! `AGENTTRACKER_UPDATE_URL` overrides the endpoint for testing. Downloads are
//! still verified against the configured public key.

use serde::Serialize;
use tauri::{AppHandle, Manager};
use tauri_plugin_updater::{Update, UpdaterExt};

#[derive(Serialize)]
pub struct UpdateInfo {
    pub version: String,
    pub current: String,
    pub notes: Option<String>,
}

async fn find(app: &AppHandle) -> Result<Option<Update>, String> {
    let mut builder = app.updater_builder();
    if let Ok(url) = std::env::var("AGENTTRACKER_UPDATE_URL") {
        let url = url.parse().map_err(|e| format!("AGENTTRACKER_UPDATE_URL: {e}"))?;
        builder = builder.endpoints(vec![url]).map_err(|e| e.to_string())?;
    }
    let updater = builder.build().map_err(|e| e.to_string())?;
    updater.check().await.map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn check_update(app: AppHandle) -> Result<Option<UpdateInfo>, String> {
    Ok(find(&app).await?.map(|u| UpdateInfo {
        version: u.version.clone(),
        current: u.current_version.clone(),
        notes: u.body.clone(),
    }))
}

/// Downloads and installs the latest update, then restarts into it.
#[tauri::command]
pub async fn install_update(app: AppHandle) -> Result<(), String> {
    let Some(update) = find(&app).await? else { return Ok(()) };
    update
        .download_and_install(|_, _| {}, || {})
        .await
        .map_err(|e| e.to_string())?;
    app.restart();
}

/// `agent-tracker --update`: checks for, installs and reports an update without
/// showing the window, then exits.
pub fn run_headless(app: &AppHandle) {
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.hide();
    }
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        let code = match find(&app).await {
            Ok(None) => {
                println!("AgentTracker {} is up to date", app.package_info().version);
                0
            }
            Ok(Some(update)) => {
                println!("Updating {} -> {}", update.current_version, update.version);
                match update.download_and_install(|_, _| {}, || {}).await {
                    Ok(()) => {
                        println!("Installed {}", update.version);
                        0
                    }
                    Err(e) => {
                        eprintln!("Update failed: {e}");
                        1
                    }
                }
            }
            Err(e) => {
                eprintln!("Update check failed: {e}");
                1
            }
        };
        app.exit(code);
    });
}
