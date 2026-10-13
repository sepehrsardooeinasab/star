"""For Settings: what keeps the computer awake during a run (caffeinate on
macOS, systemd-inhibit on Linux), whether it's there, and a test of it."""
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


def status():
    """{"keep_awake": {"tool": ...}}: the tool runs use to keep the computer
    awake, or None if there's none."""
    tool = "caffeinate" if sys.platform == "darwin" else "systemd-inhibit"
    return {"keep_awake": {"tool": tool if shutil.which(tool) else None, "full": True}}


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
