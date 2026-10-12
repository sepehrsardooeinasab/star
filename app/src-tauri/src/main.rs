// The desktop app is a window around the local Unlock Scheduler page. It
// starts the page's server (the same one `runsteamunlocker --ui` starts)
// and shows the page. On macOS the code and page ship inside the app; on
// Linux they're installed next to it (an AppImage's files are only there
// while it's open, and runs outlive the window). The user's games and
// ArchiSteamFarm live in a separate data folder. Games run as their own background processes, so
// closing the window — or quitting the app — never stops them.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

#[cfg(target_os = "macos")]
mod notify;

use std::env;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::thread;
use std::time::Duration;

#[cfg(target_os = "macos")]
use tauri::menu::AboutMetadata;
use tauri::menu::{Menu, MenuEvent, MenuItem, PredefinedMenuItem, Submenu};
use tauri::webview::NewWindowResponse;
use tauri::{AppHandle, Manager, WebviewUrl, WebviewWindowBuilder};

/// The user's games, ArchiSteamFarm and settings. UNLOCKER_HOME overrides
/// it, as it does for the Python side.
fn home_dir() -> PathBuf {
    if let Ok(home) = env::var("UNLOCKER_HOME") {
        if !home.is_empty() {
            return PathBuf::from(home);
        }
    }
    let user_home = PathBuf::from(env::var("HOME").unwrap_or_default());
    let (root, name, old_name) = if cfg!(target_os = "macos") {
        (user_home.join("Library/Application Support"), "STAR", "Steam Auto Unlocker")
    } else {
        let root = env::var("XDG_DATA_HOME").map(PathBuf::from).unwrap_or_else(|_| user_home.join(".local/share"));
        (root, "star", "steam-auto-unlocker")
    };
    // The install script moves the folder from before the rename; an app
    // installed by hand keeps using it until then.
    let (home, old) = (root.join(name), root.join(old_name));
    if !home.exists() && old.is_dir() { old } else { home }
}

/// The code and page: UNLOCKER_CODE if set, else the copy inside the app
/// (macOS), else the one the install script put in ~/.local/lib (Linux),
/// else the data folder's app/ from installs before 3.01.
fn code_dir(resources: Option<PathBuf>, home: &Path) -> Option<PathBuf> {
    let user_home = PathBuf::from(env::var("HOME").unwrap_or_default());
    env::var("UNLOCKER_CODE")
        .ok()
        .filter(|c| !c.is_empty())
        .map(PathBuf::from)
        .into_iter()
        .chain(resources)
        .chain([user_home.join(".local/lib/star"), user_home.join(".local/lib/steam-auto-unlocker"), home.join("app")])
        .find(|dir| dir.join("unlocker/run_unlocker.py").exists())
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
fn start_server(code: Option<PathBuf>, home: &Path) -> Result<String, String> {
    let Some(code) = code else {
        return Err("STAR's files weren't found. Run the install command from the project's page, then open the app again.".to_string());
    };
    let output = Command::new(python(home))
        .arg(code.join("unlocker/run_unlocker.py"))
        .args(["--ui", "--no-browser"])
        .env("UNLOCKER_HOME", home)
        // Writing __pycache__ inside the app would break its signature.
        .env("PYTHONDONTWRITEBYTECODE", "1")
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

/// Where the window buttons sit on macOS, centred in the page's 52px top bar.
#[cfg(target_os = "macos")]
const WINDOW_BUTTONS: (f64, f64) = (18.0, 26.0);

/// Puts the window buttons back in the top bar. AppKit moves them back to
/// their default spot on some window events (focus, theme, …) and Tauri only
/// restores them when its own view redraws, which the page covers; so this
/// does the same placement after those events.
#[cfg(target_os = "macos")]
fn place_window_buttons(window: &tauri::Window) {
    use objc2_app_kit::{NSWindow, NSWindowButton};
    let window = window.clone();
    let _ = window.clone().run_on_main_thread(move || {
        let Ok(ptr) = window.ns_window() else { return };
        // SAFETY: Tauri's NSWindow for this window, used on the main thread.
        let ns_window = unsafe { &*(ptr as *const NSWindow) };
        let buttons = [NSWindowButton::CloseButton, NSWindowButton::MiniaturizeButton, NSWindowButton::ZoomButton]
            .map(|b| ns_window.standardWindowButton(b));
        let [Some(close), Some(minimize), Some(zoom)] = buttons else { return };
        // SAFETY: plain view-hierarchy reads on the main thread.
        let Some(title_bar) = (unsafe { close.superview().and_then(|v| v.superview()) }) else { return };
        let (x, y) = WINDOW_BUTTONS;
        let close_frame = close.frame();
        let mut bar = title_bar.frame();
        bar.size.height = close_frame.size.height + y;
        bar.origin.y = ns_window.frame().size.height - bar.size.height;
        title_bar.setFrame(bar);
        let gap = minimize.frame().origin.x - close_frame.origin.x;
        for (i, button) in [close, minimize, zoom].iter().enumerate() {
            let mut origin = button.frame().origin;
            origin.x = x + i as f64 * gap;
            button.setFrameOrigin(origin);
        }
    });
}

/// STAR's menus: the app menu (About, Check for Updates…, Settings… ⌘,),
/// Edit (for copy and paste), Go (the page's screens, ⌘1–2), Window and
/// Help. Elsewhere than macOS, a STAR menu has Settings, the update check
/// and Quit.
fn menu(app: &AppHandle) -> tauri::Result<Menu<tauri::Wry>> {
    let item = |id: &str, text: &str, key: Option<&str>| MenuItem::with_id(app, id, text, true, key);
    let sep = || PredefinedMenuItem::separator(app);
    let check = item("check-updates", "Check for Updates…", None)?;
    let settings = item("settings", "Settings…", Some("CmdOrCtrl+,"))?;
    let menu = Menu::new(app)?;

    // Rebuilt rather than the default so About, Hide and Quit say "STAR"
    // even when run from the bare binary, and About shows the release name
    // (3.05).
    #[cfg(target_os = "macos")]
    {
        let info = app.package_info();
        let name = info.name.as_str();
        let v = &info.version;
        let about = AboutMetadata {
            name: Some(name.into()),
            version: Some(format!("{}.{}{}", v.major, v.minor, v.patch)),
            // Empty, so the panel doesn't add the build number in brackets.
            short_version: Some(String::new()),
            icon: app.default_window_icon().cloned(),
            ..Default::default()
        };
        menu.append(&Submenu::with_items(app, name, true, &[
            &PredefinedMenuItem::about(app, Some(&format!("About {name}")), Some(about))?,
            &check,
            &settings,
            &sep()?,
            &PredefinedMenuItem::services(app, None)?,
            &sep()?,
            &PredefinedMenuItem::hide(app, Some(&format!("Hide {name}")))?,
            &PredefinedMenuItem::hide_others(app, None)?,
            &PredefinedMenuItem::show_all(app, None)?,
            &sep()?,
            &PredefinedMenuItem::quit(app, Some(&format!("Quit {name}")))?,
        ])?)?;
    }
    #[cfg(not(target_os = "macos"))]
    menu.append(&Submenu::with_items(app, "STAR", true, &[
        &settings,
        &check,
        &sep()?,
        &PredefinedMenuItem::quit(app, None)?,
    ])?)?;

    menu.append(&Submenu::with_items(app, "Edit", true, &[
        &PredefinedMenuItem::undo(app, None)?,
        &PredefinedMenuItem::redo(app, None)?,
        &sep()?,
        &PredefinedMenuItem::cut(app, None)?,
        &PredefinedMenuItem::copy(app, None)?,
        &PredefinedMenuItem::paste(app, None)?,
        &PredefinedMenuItem::select_all(app, None)?,
    ])?)?;
    menu.append(&Submenu::with_items(app, "Go", true, &[
        &item("go-schedule", "Schedule", Some("CmdOrCtrl+1"))?,
        &item("go-runs", "Runs", Some("CmdOrCtrl+2"))?,
    ])?)?;
    menu.append(&Submenu::with_items(app, "Window", true, &[
        &PredefinedMenuItem::minimize(app, None)?,
        &PredefinedMenuItem::maximize(app, None)?,
        #[cfg(target_os = "macos")]
        &PredefinedMenuItem::fullscreen(app, None)?,
        &sep()?,
        &PredefinedMenuItem::close_window(app, None)?,
    ])?)?;
    menu.append(&Submenu::with_items(app, "Help", true, &[
        &item("help-guide", "How STAR Works", None)?,
        &item("help-github", "STAR on GitHub", None)?,
        &item("help-issue", "Report a Problem…", None)?,
    ])?)?;
    Ok(menu)
}

const REPO: &str = "https://github.com/sepehrsardooeinasab/star";

/// The page does the work: it switches screens, or opens its Settings tab,
/// there checking for an update when asked. (Before the page has loaded,
/// nothing happens.) Help links open in the browser.
fn on_menu(app: &AppHandle, event: MenuEvent) {
    let click = |id: &str| format!("document.getElementById('{id}') && document.getElementById('{id}').click()");
    let script = match event.id().as_ref() {
        "settings" => "window.unlockerShowGuide && unlockerShowGuide()".to_string(),
        "check-updates" => "window.unlockerCheckUpdates && unlockerCheckUpdates()".to_string(),
        "go-schedule" => click("switch-schedule"),
        "go-runs" => click("switch-runs"),
        "help-guide" => return open_url("https://sepehrsardooeinasab.github.io/star/"),
        "help-github" => return open_url(REPO),
        "help-issue" => return open_url(&format!("{REPO}/issues/new")),
        _ => return,
    };
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.eval(&script);
    }
}

fn open_url(url: &str) {
    let opener = if cfg!(target_os = "macos") { "open" } else { "xdg-open" };
    let _ = Command::new(opener).arg(url).spawn();
}

/// Links the page opens in a new window (GitHub, …) open in the default
/// browser instead.
fn on_new_window(url: tauri::Url) -> NewWindowResponse<tauri::Wry> {
    if matches!(url.scheme(), "http" | "https") {
        open_url(url.as_str());
    }
    NewWindowResponse::Deny
}

fn main() {
    // Runs post their notifications through the app (see notify.rs).
    #[cfg(target_os = "macos")]
    {
        let args: Vec<String> = env::args().skip(1).collect();
        if args.first().is_some_and(|a| a.starts_with("--notify")) {
            std::process::exit(notify::run(&args));
        }
    }
    tauri::Builder::default()
        .menu(menu)
        .on_menu_event(on_menu)
        .on_window_event(|_window, event| {
            #[cfg(target_os = "macos")]
            if matches!(event, tauri::WindowEvent::Focused(_) | tauri::WindowEvent::Resized(_)
                | tauri::WindowEvent::ThemeChanged(_) | tauri::WindowEvent::ScaleFactorChanged { .. })
            {
                place_window_buttons(_window);
            }
            #[cfg(not(target_os = "macos"))]
            let _ = event;
        })
        .setup(|app| {
            // Starts on the bundled "Starting…" page, then moves to the
            // server's page once it's up.
            let builder = WebviewWindowBuilder::new(app, "main", WebviewUrl::App("index.html".into()))
                .on_new_window(|url, _| on_new_window(url))
                .title("STAR")
                .inner_size(1180.0, 860.0)
                .min_inner_size(960.0, 560.0);
            // macOS: no separate title bar. The page's top bar takes its
            // place, starting after the window buttons, which sit centred
            // in it (it's 52px tall).
            #[cfg(target_os = "macos")]
            let builder = builder
                .title_bar_style(tauri::TitleBarStyle::Overlay)
                .hidden_title(true)
                .traffic_light_position(tauri::LogicalPosition::new(WINDOW_BUTTONS.0, WINDOW_BUTTONS.1));
            let window = builder.build()?;
            // Asks for notification permission now, while the app is open,
            // so runs don't wait on the prompt.
            #[cfg(target_os = "macos")]
            thread::spawn(|| notify::authorize(Duration::from_secs(600)));
            let home = home_dir();
            let code = code_dir(app.path().resource_dir().ok(), &home);
            thread::spawn(move || match start_server(code, &home) {
                Ok(url) => {
                    // Tells the page it's in the app, which lays out its top
                    // bar as the window's title bar. A dev build adds dev=1:
                    // all text selectable and the full right-click menu
                    // (Inspect Element), which release builds don't have.
                    let desktop = if cfg!(target_os = "macos") { "macos" } else { "linux" };
                    let dev = if cfg!(debug_assertions) { "&dev=1" } else { "" };
                    if let Ok(url) = format!("{url}?desktop={desktop}{dev}").parse() {
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
