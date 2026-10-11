"""The optional pieces runs use, for Settings: what keeps the computer awake
during a run (caffeinate on macOS, systemd-inhibit on Linux) and what shows
notifications, whether each is there, and how to install what's missing."""
import os
import shutil
import subprocess
import sys

# Apps opened from the Dock or a desktop menu get a minimal PATH, which
# misses Homebrew's tools (terminal-notifier, brew itself).
EXTRA_PATH = ["/opt/homebrew/bin", "/usr/local/bin", os.path.expanduser("~/.local/bin")]


def extend_path():
    """Adds the usual tool folders to PATH, for this process and the runs it
    starts."""
    parts = os.environ.get("PATH", "/usr/bin:/bin").split(":")
    os.environ["PATH"] = ":".join(parts + [p for p in EXTRA_PATH if p not in parts])


def _linux_notify_install():
    """The command that installs notify-send on this Linux, or None."""
    ids = set()
    try:
        for line in open("/etc/os-release"):
            key, _, value = line.strip().partition("=")
            if key in ("ID", "ID_LIKE"):
                ids.update(value.strip('"').split())
    except OSError:
        pass
    for family, command in (("debian", "sudo apt install libnotify-bin"),
                            ("ubuntu", "sudo apt install libnotify-bin"),
                            ("fedora", "sudo dnf install libnotify"),
                            ("rhel", "sudo dnf install libnotify"),
                            ("arch", "sudo pacman -S libnotify"),
                            ("suse", "sudo zypper install libnotify-tools"),
                            ("opensuse", "sudo zypper install libnotify-tools")):
        if family in ids:
            return command
    return None


def status():
    """{"keep_awake": {...}, "notifications": {...}}, each with the tool in
    use (None if there's none), whether that's the full experience, and an
    install command (with can_run: whether the app can run it itself)."""
    if sys.platform == "darwin":
        notifier = shutil.which("terminal-notifier")
        return {
            "keep_awake": {"tool": "caffeinate" if shutil.which("caffeinate") else None, "full": True},
            "notifications": {
                "tool": "terminal-notifier" if notifier else "osascript",
                "full": bool(notifier),
                "install": None if notifier else "brew install terminal-notifier",
                "can_run": bool(not notifier and shutil.which("brew")),
            },
        }
    notify_send = shutil.which("notify-send")
    return {
        "keep_awake": {"tool": "systemd-inhibit" if shutil.which("systemd-inhibit") else None, "full": True},
        "notifications": {
            "tool": "notify-send" if notify_send else None,
            "full": bool(notify_send),
            "install": None if notify_send else _linux_notify_install(),
            "can_run": False,  # needs sudo: shown for the user to run
        },
    }


def install_notifier(report):
    """Installs terminal-notifier with Homebrew (macOS)."""
    brew = shutil.which("brew")
    if not brew:
        raise RuntimeError("Homebrew isn't installed, so terminal-notifier can't be installed from here.")
    report("Installing terminal-notifier with Homebrew… (this can take a minute)")
    result = subprocess.run([brew, "install", "terminal-notifier"], capture_output=True, text=True,
                            env={**os.environ, "HOMEBREW_NO_AUTO_UPDATE": "1"})
    if result.returncode != 0:
        last = (result.stderr or result.stdout).strip().splitlines()[-1:] or ["unknown error"]
        raise RuntimeError(f"Homebrew couldn't install it: {last[0]}")
    report("terminal-notifier is installed.")
