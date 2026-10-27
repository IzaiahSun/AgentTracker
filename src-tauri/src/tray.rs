//! Menu bar (macOS) / system tray (Windows, Linux) icon with today's usage.
//!
//! The webview computes the numbers (it owns the price table) and pushes them
//! with `update_tray`; menu clicks other than open/quit are forwarded to it as
//! a `tray` event. Closing the window hides it, so the icon keeps running.

use serde::Deserialize;
use tauri::menu::{CheckMenuItem, Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Emitter, Manager, Wry};

const ID: &str = "main";

pub fn show_main(app: &AppHandle) {
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.unminimize();
        let _ = w.show();
        let _ = w.set_focus();
    }
}

pub fn setup(app: &AppHandle) -> tauri::Result<()> {
    let mut builder = TrayIconBuilder::with_id(ID)
        .tooltip("AgentTracker")
        .menu(&build_menu(app, &TrayState::default())?)
        .on_menu_event(|app, e| match e.id().as_ref() {
            "open" => show_main(app),
            "quit" => app.exit(0),
            id => {
                let _ = app.emit_to("main", "tray", id.to_string());
            }
        });
    if cfg!(target_os = "macos") {
        builder = builder
            .icon(tauri::image::Image::from_bytes(include_bytes!("../icons/tray.png"))?)
            .icon_as_template(true);
    } else {
        // Left click opens the window; the menu is on right click.
        builder = builder
            .icon(app.default_window_icon().cloned().expect("bundle icon"))
            .show_menu_on_left_click(false)
            .on_tray_icon_event(|tray, e| {
                if let TrayIconEvent::Click { button: MouseButton::Left, button_state: MouseButtonState::Up, .. } = e {
                    show_main(tray.app_handle());
                }
            });
    }
    builder.build(app)?;
    Ok(())
}

/// What the webview sends: localized labels plus the numbers to show.
#[derive(Deserialize, Default)]
#[serde(default)]
pub struct TrayState {
    /// Text next to the icon (macOS only); empty for icon only.
    title: String,
    tooltip: String,
    /// Read-only summary lines at the top of the menu.
    lines: Vec<String>,
    /// "tokens" | "cost" | "icon"
    mode: String,
    labels: Labels,
}

#[derive(Deserialize)]
#[serde(default)]
struct Labels {
    show_tokens: String,
    show_cost: String,
    icon_only: String,
    refresh: String,
    open: String,
    quit: String,
}

impl Default for Labels {
    fn default() -> Self {
        Labels {
            show_tokens: "Show today's tokens".into(),
            show_cost: "Show today's cost".into(),
            icon_only: "Icon only".into(),
            refresh: "Refresh".into(),
            open: "Open AgentTracker".into(),
            quit: "Quit AgentTracker".into(),
        }
    }
}

fn build_menu(app: &AppHandle, s: &TrayState) -> tauri::Result<Menu<Wry>> {
    let menu = Menu::new(app)?;
    for (i, line) in s.lines.iter().enumerate() {
        menu.append(&MenuItem::with_id(app, format!("line{i}"), line, false, None::<&str>)?)?;
    }
    if !s.lines.is_empty() {
        menu.append(&PredefinedMenuItem::separator(app)?)?;
    }
    let l = &s.labels;
    if cfg!(target_os = "macos") {
        for (id, text) in [("tokens", &l.show_tokens), ("cost", &l.show_cost), ("icon", &l.icon_only)] {
            let checked = s.mode == id || (s.mode.is_empty() && id == "tokens");
            menu.append(&CheckMenuItem::with_id(app, format!("mode:{id}"), text, true, checked, None::<&str>)?)?;
        }
        menu.append(&PredefinedMenuItem::separator(app)?)?;
    }
    menu.append(&MenuItem::with_id(app, "refresh", &l.refresh, true, None::<&str>)?)?;
    menu.append(&MenuItem::with_id(app, "open", &l.open, true, None::<&str>)?)?;
    menu.append(&PredefinedMenuItem::separator(app)?)?;
    menu.append(&MenuItem::with_id(app, "quit", &l.quit, true, None::<&str>)?)?;
    Ok(menu)
}

#[tauri::command]
pub fn update_tray(app: AppHandle, state: TrayState) -> Result<(), String> {
    let Some(tray) = app.tray_by_id(ID) else { return Ok(()) };
    let menu = build_menu(&app, &state).map_err(|e| e.to_string())?;
    tray.set_menu(Some(menu)).map_err(|e| e.to_string())?;
    let title = (!state.title.is_empty()).then_some(state.title.as_str());
    tray.set_title(title).map_err(|e| e.to_string())?;
    tray.set_tooltip(Some(&state.tooltip)).map_err(|e| e.to_string())?;
    Ok(())
}
