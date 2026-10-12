"""The optional pieces runs use, for Settings: what keeps the computer awake
during a run (caffeinate on macOS, systemd-inhibit on Linux) and what shows
notifications (built in on macOS, notify-send on Linux), whether each is
there, and how to install what's missing."""
import os
import shutil
import subprocess
import sys
import time

# Apps opened from the Dock or a desktop menu get a minimal PATH, which
# misses Homebrew's and the user's own tool folders.
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
        return {
            "keep_awake": {"tool": "caffeinate" if shutil.which("caffeinate") else None, "full": True},
            "notifications": {"tool": "osascript", "full": True, "install": None, "can_run": False},
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



def test_keep_awake():
    """Takes keep-awake the way runs do, checks the system really holds it
    (macOS: pmset's power assertions; Linux: logind's inhibitor list), then
    lets go. Returns (works, what was found)."""
    from unlocker.api import start_keep_awake, stop_keep_awake
    proc = start_keep_awake(force=True)
    if proc is None:
        return False, "it couldn't be started"
    try:
        time.sleep(0.5)
        if sys.platform == "darwin":
            out = subprocess.run(["pmset", "-g", "assertions"], capture_output=True, text=True, timeout=10).stdout
            held = any(f"pid {proc.pid}(" in line and "PreventUserIdleSystemSleep" in line
                       for line in out.splitlines())
            return held, "macOS reports caffeinate preventing sleep" if held else "macOS doesn't show it preventing sleep"
        out = subprocess.run(["systemd-inhibit", "--list", "--no-legend"], capture_output=True, text=True,
                             timeout=10).stdout
        held = any("STAR" in line and "sleep" in line for line in out.splitlines())
        return held, "systemd lists it blocking sleep" if held else "systemd doesn't list it blocking sleep"
    except (OSError, subprocess.SubprocessError) as e:
        return False, f"it couldn't be checked ({e})"
    finally:
        stop_keep_awake(proc)
