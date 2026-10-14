// While a game is running or waiting out a break (macOS):
//
// - a STAR icon in the menu bar says so, with each game's state, Open STAR
//   and Stop after this session;
// - closing the window hides it instead of quitting, leaving just that
//   icon (no Dock icon), so it stays in sight until the runs are done; then
//   the app and its server quit as they do when nothing runs;
// - logging out, restarting or shutting down first asks whether to go on.
//
// Runs are their own processes; this only shows them and asks. It reads
// their state from the server's /api/games every few seconds.
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use std::thread;
use std::time::Duration;

use tauri::image::Image;
use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::{TrayIcon, TrayIconBuilder};
use tauri::{ActivationPolicy, AppHandle, Manager};

use crate::server_request;

/// True while any game is running or waiting to start a session.
static ACTIVE: AtomicBool = AtomicBool::new(false);
/// What the menu shows: one line per game, and the games whose run can be
/// told to stop after the current session.
static SUMMARY: Mutex<Vec<String>> = Mutex::new(Vec::new());

pub fn active() -> bool {
    ACTIVE.load(Ordering::Relaxed)
}

/// "1h 5m", "12m", "45s".
fn span(seconds: f64) -> String {
    let s = seconds.max(0.0) as u64;
    let (d, h, m) = (s / 86400, s % 86400 / 3600, s % 3600 / 60);
    if d > 0 {
        format!("{d}d {h}h")
    } else if h > 0 {
        format!("{h}h {m}m")
    } else if m > 0 {
        format!("{m}m")
    } else {
        format!("{s}s")
    }
}

/// A running game's lines in the menu: what's playing, its session, how
/// long the session has left and when the next achievement unlocks (Now
/// until its time is known, as in Runs); between sessions, when the next
/// one starts.
fn game_lines(g: &serde_json::Value, title: &str) -> Vec<String> {
    let playing = g["state"].as_str() == Some("in_session");
    let mut lines = vec![format!("{}: {title}", if playing { "Playing" } else { "Waiting" })];
    if let (Some(s), Some(n)) = (g["session"].as_u64(), g["sessions"].as_u64()) {
        lines.push(format!("Session: {s} of {n}"));
    }
    if playing {
        if let Some(left) = g["session_left"].as_f64() {
            lines.push(format!("Session ends in: {}", span(left)));
        }
        let next = g["next_unlock_in"].as_f64().map_or("Now".to_string(), span);
        lines.push(format!("Next achievement in: {next}"));
    } else {
        let wait = g["starts_in"].as_f64().or(g["ready_in"].as_f64()).unwrap_or(0.0);
        if wait > 0.0 {
            lines.push(format!("Starts in: {}", span(wait)));
        }
    }
    lines
}

/// The running games, as menu lines, and those that can stop after this
/// session ((name, title)).
fn read_games() -> Option<(Vec<String>, Vec<(String, String)>)> {
    let body = server_request("GET", "/api/games", None)?;
    let data: serde_json::Value = serde_json::from_str(&body).ok()?;
    let mut lines = Vec::new();
    let mut stoppable = Vec::new();
    for g in data["games"].as_array()?.iter().filter(|g| g["running"].as_bool() == Some(true)) {
        let name = g["name"].as_str().unwrap_or_default().to_string();
        let title = g["title"].as_str().filter(|t| !t.is_empty()).unwrap_or(&name).to_string();
        lines.extend(game_lines(g, &title));
        if g["auto"].as_bool() == Some(true) && g["stop_after"].as_bool() != Some(true) {
            stoppable.push((name, title));
        }
    }
    Some((lines, stoppable))
}

fn build_menu(app: &AppHandle, lines: &[String], stoppable: &[(String, String)]) -> tauri::Result<Menu<tauri::Wry>> {
    let menu = Menu::new(app)?;
    for line in lines {
        menu.append(&MenuItem::new(app, line, false, None::<&str>)?)?;
    }
    menu.append(&PredefinedMenuItem::separator(app)?)?;
    for (name, title) in stoppable {
        let label = if stoppable.len() == 1 {
            "Stop After This Session".to_string()
        } else {
            format!("Stop {title} After This Session")
        };
        menu.append(&MenuItem::with_id(app, format!("tray-stop:{name}"), label, true, None::<&str>)?)?;
    }
    menu.append(&MenuItem::with_id(app, "tray-open", "Open STAR", true, None::<&str>)?)?;
    Ok(menu)
}

/// The menu bar icon (hidden until a game runs) and the thread that keeps
/// it, and ACTIVE, up to date.
pub fn start(app: &AppHandle) -> tauri::Result<()> {
    let icon = Image::from_bytes(include_bytes!("../icons/tray.png"))?;
    let tray = TrayIconBuilder::with_id("star")
        .icon(icon)
        .icon_as_template(true)
        .tooltip("STAR")
        .menu(&build_menu(app, &[], &[])?)
        .show_menu_on_left_click(true)
        .build(app)?;
    let _ = tray.set_visible(false);
    let app = app.clone();
    thread::spawn(move || loop {
        // No answer (the server isn't up yet, or is restarting): keep what
        // was last seen, and ask again soon.
        let Some((lines, stoppable)) = read_games() else {
            thread::sleep(Duration::from_secs(1));
            continue;
        };
        let now_active = !lines.is_empty();
        ACTIVE.store(now_active, Ordering::Relaxed);
        update_tray(&app, &tray, lines, &stoppable, now_active);
        // Hidden in the menu bar and nothing left to show: quit as closing
        // the window does when nothing runs.
        if !now_active && !window_visible(&app) {
            crate::quit_server();
            app.exit(0);
            return;
        }
        thread::sleep(Duration::from_secs(4));
    });
    Ok(())
}

fn update_tray(app: &AppHandle, tray: &TrayIcon, lines: Vec<String>, stoppable: &[(String, String)], active: bool) {
    let mut shown = SUMMARY.lock().unwrap();
    let key: Vec<String> = lines.iter().cloned().chain(stoppable.iter().map(|s| s.0.clone())).collect();
    if *shown != key {
        if let Ok(menu) = build_menu(app, &lines, stoppable) {
            let _ = tray.set_menu(Some(menu));
        }
        *shown = key;
    }
    let _ = tray.set_visible(active);
}

fn window_visible(app: &AppHandle) -> bool {
    app.get_webview_window("main").and_then(|w| w.is_visible().ok()).unwrap_or(false)
}

/// The window closed while games run: hide it and keep just the menu bar
/// icon. Returns false when nothing runs (the window closes as usual).
pub fn hide_instead_of_close(window: &tauri::Window) -> bool {
    if !active() {
        return false;
    }
    let _ = window.hide();
    let _ = window.app_handle().set_activation_policy(ActivationPolicy::Accessory);
    true
}

/// Open STAR (the menu item, or the Dock icon): the window back, with its
/// Dock icon.
pub fn show_window(app: &AppHandle) {
    let _ = app.set_activation_policy(ActivationPolicy::Regular);
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.show();
        let _ = window.unminimize();
        let _ = window.set_focus();
    }
}

/// The tray menu's own items; false for anything else.
pub fn on_menu(app: &AppHandle, id: &str) -> bool {
    if id == "tray-open" {
        show_window(app);
        return true;
    }
    if let Some(name) = id.strip_prefix("tray-stop:") {
        let body = serde_json::json!({"name": name, "on": true}).to_string();
        let _ = server_request("POST", "/api/stop-after", Some(&body));
        return true;
    }
    false
}

// --- Logging out, restarting or shutting down -------------------------
//
// AppKit asks the app delegate (applicationShouldTerminate:) before
// quitting. Tauri's delegate doesn't answer it, so it's added here: when
// the quit comes from a logout, restart or shutdown while a game runs, it
// asks first, and "Don't" cancels it (macOS then says STAR stopped it).
// Quitting STAR itself (⌘Q) is never asked about: games keep running.

use objc2::rc::Retained;
use objc2::runtime::{AnyObject, Imp, Sel};
use objc2::{msg_send, sel, MainThreadMarker};
use objc2_app_kit::{NSAlert, NSAlertFirstButtonReturn, NSAlertStyle, NSApplication};
use objc2_foundation::{NSAppleEventDescriptor, NSAppleEventManager, NSString};

const NS_TERMINATE_CANCEL: usize = 0;
const NS_TERMINATE_NOW: usize = 1;

/// The four-letter code as AppleScript writes it ('logo' → 0x6c6f676f).
const fn code(s: &[u8; 4]) -> u32 {
    u32::from_be_bytes(*s)
}

/// Whether the quit under way is a logout, restart or shutdown (the quit
/// Apple event says why), and which, for the question.
fn system_quit() -> Option<&'static str> {
    // SAFETY: plain reads of the current Apple event, on the main thread.
    unsafe {
        let event = NSAppleEventManager::sharedAppleEventManager().currentAppleEvent()?;
        let why: Option<Retained<NSAppleEventDescriptor>> = msg_send![&*event, attributeDescriptorForKeyword: code(b"why?")];
        let reason = why?.enumCodeValue();
        match reason {
            r if r == code(b"logo") || r == code(b"rlgo") => Some("log out"),
            r if r == code(b"rrst") || r == code(b"rest") => Some("restart"),
            r if r == code(b"rsdn") || r == code(b"shut") => Some("shut down"),
            _ => None,
        }
    }
}

extern "C-unwind" fn should_terminate(_this: &AnyObject, _cmd: Sel, _sender: *mut AnyObject) -> usize {
    let (Some(action), true) = (system_quit(), active()) else { return NS_TERMINATE_NOW };
    let Some(mtm) = MainThreadMarker::new() else { return NS_TERMINATE_NOW };
    let games = SUMMARY.lock().map(|s| s.iter().filter(|l| !l.starts_with(' ')).cloned().collect::<Vec<_>>()).unwrap_or_default();
    let what = games.first().cloned().unwrap_or_else(|| "A game".to_string());
    let alert = NSAlert::new(mtm);
    alert.setAlertStyle(NSAlertStyle::Warning);
    alert.setMessageText(&NSString::from_str(&format!("{what} is running in STAR")));
    alert.setInformativeText(&NSString::from_str(&format!(
        "If you {action} now, it stops: the game stops playing and progress so far is kept. \
         Run it again later to continue.")));
    let _ = alert.addButtonWithTitle(&NSString::from_str(&format!("Don't {}", capitalized(action))));
    let _ = alert.addButtonWithTitle(&NSString::from_str(&format!("{} Anyway", capitalized(action))));
    NSApplication::sharedApplication(mtm).activate();
    if alert.runModal() == NSAlertFirstButtonReturn { NS_TERMINATE_CANCEL } else { NS_TERMINATE_NOW }
}

fn capitalized(action: &str) -> String {
    action.split(' ').map(|w| {
        let mut c = w.chars();
        c.next().map(|f| f.to_uppercase().collect::<String>() + c.as_str()).unwrap_or_default()
    }).collect::<Vec<_>>().join(" ")
}

/// Adds applicationShouldTerminate: to the app's delegate. Called once the
/// app has finished launching (the delegate is Tauri's by then).
pub fn guard_system_quit() {
    let Some(mtm) = MainThreadMarker::new() else { return };
    let app = NSApplication::sharedApplication(mtm);
    // SAFETY: adds a method to the delegate's class on the main thread;
    // its signature matches applicationShouldTerminate: (NSUInteger, sender).
    unsafe {
        let Some(delegate) = app.delegate() else { return };
        let class = (*(Retained::as_ptr(&delegate) as *const AnyObject)).class();
        let imp: Imp = std::mem::transmute(should_terminate as extern "C-unwind" fn(&AnyObject, Sel, *mut AnyObject) -> usize);
        objc2::ffi::class_addMethod(
            class as *const _ as *mut _,
            sel!(applicationShouldTerminate:),
            imp,
            c"Q@:@".as_ptr(),
        );
    }
}
