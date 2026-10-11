// The desktop app is a window around the local Unlock Scheduler page. It
// starts the page's server (the same one `runsteamunlocker --ui` starts),
// using the code and data the install script put in the user's folder,
// then shows the page. Games run as their own background processes, so
// closing the window — or quitting the app — never stops them.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::env;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::thread;
use std::time::Duration;

use tauri::{WebviewUrl, WebviewWindowBuilder};

/// Where the install script keeps the code (app/) and the user's games,
/// ArchiSteamFarm and settings. UNLOCKER_HOME overrides it, as it does for
/// the Python side.
fn home_dir() -> PathBuf {
    if let Ok(home) = env::var("UNLOCKER_HOME") {
        if !home.is_empty() {
            return PathBuf::from(home);
        }
    }
    let user_home = PathBuf::from(env::var("HOME").unwrap_or_default());
    if cfg!(target_os = "macos") {
        user_home.join("Library/Application Support/Steam Auto Unlocker")
    } else {
        env::var("XDG_DATA_HOME")
            .map(PathBuf::from)
            .unwrap_or_else(|_| user_home.join(".local/share"))
            .join("steam-auto-unlocker")
    }
}

/// The Python the install script found. Apps opened from the Dock or a
/// desktop menu get a minimal PATH, so a bare "python3" may not be the one
/// the user has.
fn python(home: &Path) -> String {
    if let Ok(path) = std::fs::read_to_string(home.join("python-path")) {
        let path = path.trim();
        if !path.is_empty() && Path::new(path).exists() {
            return path.to_string();
        }
    }
    ["/opt/homebrew/bin/python3", "/usr/local/bin/python3", "/usr/bin/python3"]
        .iter()
        .find(|p| Path::new(p).exists())
        .map(|p| p.to_string())
        .unwrap_or_else(|| "python3".to_string())
}

/// Starts the server if it isn't running and returns its URL.
fn start_server(home: &Path) -> Result<String, String> {
    let script = home.join("app/unlocker/run_unlocker.py");
    if !script.exists() {
        return Err(format!(
            "Steam Auto Unlocker isn't installed in {}. Run the install command from the project's page, then open the app again.",
            home.display()
        ));
    }
    let output = Command::new(python(home))
        .arg(&script)
        .args(["--ui", "--no-browser"])
        .env("UNLOCKER_HOME", home)
        .output()
        .map_err(|e| format!("Couldn't start Python 3 ({e}). Install Python 3, then open the app again."))?;
    let stdout = String::from_utf8_lossy(&output.stdout);
    let url = stdout.lines().rev().find(|l| l.starts_with("http://"));
    match (output.status.success(), url) {
        (true, Some(url)) => Ok(url.trim().to_string()),
        _ => Err(format!(
            "The app's server didn't start.\n\n{}{}",
            stdout.trim(),
            String::from_utf8_lossy(&output.stderr).trim()
        )),
    }
}

fn main() {
    tauri::Builder::default()
        .setup(|app| {
            // Starts on the bundled "Starting…" page, then moves to the
            // server's page once it's up.
            let window = WebviewWindowBuilder::new(app, "main", WebviewUrl::App("index.html".into()))
                .title("Steam Auto Unlocker")
                .inner_size(1180.0, 860.0)
                .min_inner_size(420.0, 560.0)
                .build()?;
            thread::spawn(move || match start_server(&home_dir()) {
                Ok(url) => {
                    if let Ok(url) = url.parse() {
                        let _ = window.navigate(url);
                    }
                }
                Err(message) => {
                    // Give the starting page a moment to load first.
                    thread::sleep(Duration::from_millis(400));
                    let text = serde_json::to_string(&message).unwrap_or_default();
                    let _ = window.eval(&format!("showError({text})"));
                }
            });
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running the app");
}
