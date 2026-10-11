//! macOS notifications posted as the app's own, so they show its icon and
//! name. Runs call the app's binary with --notify (no window opens); the
//! app asks for permission when it starts, so the prompt shows up there
//! rather than in the middle of a run.

use std::sync::mpsc;
use std::time::Duration;

use block2::RcBlock;
use objc2::runtime::Bool;
use objc2_foundation::{NSArray, NSError, NSString};
use objc2_user_notifications::{
    UNAuthorizationOptions, UNMutableNotificationContent, UNNotificationRequest, UNNotificationSound,
    UNUserNotificationCenter,
};

/// Notifications need the app's bundle: outside one (a dev build), macOS
/// raises an exception instead.
fn in_bundle() -> bool {
    std::env::current_exe().is_ok_and(|exe| exe.to_string_lossy().contains(".app/Contents/MacOS/"))
}

/// Asks for permission to show notifications (macOS asks once). Returns
/// whether they're allowed, or None if there was no answer in time.
pub fn authorize(wait: Duration) -> Option<bool> {
    if !in_bundle() {
        return None;
    }
    let center = UNUserNotificationCenter::currentNotificationCenter();
    let (tx, rx) = mpsc::channel();
    let done = RcBlock::new(move |granted: Bool, _error: *mut NSError| {
        let _ = tx.send(granted.as_bool());
    });
    center.requestAuthorizationWithOptions_completionHandler(
        UNAuthorizationOptions::Alert | UNAuthorizationOptions::Sound,
        &done,
    );
    rx.recv_timeout(wait).ok()
}

/// `--notify <id> <title> <subtitle> <message>`: shows it and returns the
/// exit code (0 shown, 2 not allowed, 3 failed). `--notify-remove <id>`
/// takes a shown one away again.
pub fn run(args: &[String]) -> i32 {
    if !in_bundle() {
        return 3;
    }
    let center = UNUserNotificationCenter::currentNotificationCenter();
    match args {
        [flag, id] if flag == "--notify-remove" => {
            center.removeDeliveredNotificationsWithIdentifiers(&NSArray::from_retained_slice(&[NSString::from_str(id)]));
            0
        }
        [flag, id, title, subtitle, message] if flag == "--notify" => {
            if authorize(Duration::from_secs(10)) != Some(true) {
                return 2;
            }
            let content = UNMutableNotificationContent::new();
            content.setTitle(&NSString::from_str(title));
            content.setSubtitle(&NSString::from_str(subtitle));
            content.setBody(&NSString::from_str(message));
            content.setSound(Some(&UNNotificationSound::defaultSound()));
            let request =
                UNNotificationRequest::requestWithIdentifier_content_trigger(&NSString::from_str(id), &content, None);
            let (tx, rx) = mpsc::channel();
            let done = RcBlock::new(move |error: *mut NSError| {
                let _ = tx.send(error.is_null());
            });
            center.addNotificationRequest_withCompletionHandler(&request, Some(&done));
            if rx.recv_timeout(Duration::from_secs(10)) == Ok(true) { 0 } else { 3 }
        }
        _ => 64,
    }
}
