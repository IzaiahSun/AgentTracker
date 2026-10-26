// Prevents an extra console window on Windows in release.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    if std::env::args().any(|a| a == "--report") {
        agent_tracker_lib::print_report();
        return;
    }
    agent_tracker_lib::run()
}
