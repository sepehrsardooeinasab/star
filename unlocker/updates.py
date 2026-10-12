"""Updates for STAR itself: checks GitHub for a newer
release, and updates by running the install script again — the same
command that installed it, which replaces the app and the code and keeps
the user's games, ArchiSteamFarm and settings. The script closes the app
while it's replaced and opens it again afterwards (or restarts the page's
server when there's no app); games keep running throughout, but an update
waits until none is."""
import json
import os
import platform
import re
import subprocess
import sys
import threading
import time
import urllib.error
import urllib.request
from pathlib import Path

from unlocker.paths import CODE_DIR, DATA_DIR
from unlocker.state import JSONS_DIR

# The release this code is. Bump it along with the app's version in
# app/src-tauri/tauri.conf.json and Cargo.toml (release v3.01 is 3.0.1).
RELEASE = "v3.06"
REPO = "sepehrsardooeinasab/star"
LATEST_URL = f"https://api.github.com/repos/{REPO}/releases/latest"
INSTALL_URL = f"https://raw.githubusercontent.com/{REPO}/main/install.sh"
UPDATE_LOG = JSONS_DIR / ".update.log"
CHECK_EVERY = 6 * 3600

_check = {"latest": None, "error": None, "checked_at": 0.0}
_check_lock = threading.Lock()
_update_proc = None


def _key(tag):
    """v3.01 -> (3, 1); None if it isn't a release tag."""
    m = re.fullmatch(r"v(\d+)\.(\d+)", tag or "")
    return (int(m[1]), int(m[2])) if m else None


def has_app():
    """Whether the desktop app is installed: on macOS this code is inside
    it; on Linux the install script keeps the AppImage in the data folder."""
    if sys.platform == "darwin":
        return CODE_DIR.parent.name == "Contents" and CODE_DIR.parent.parent.suffix == ".app"
    return (DATA_DIR / "STAR.AppImage").exists() or (DATA_DIR / "Steam Auto Unlocker.AppImage").exists()


def _app_asset_suffix():
    """The release file install.sh would pick for this computer's app."""
    machine = platform.machine().lower()
    if sys.platform == "darwin":
        return "_aarch64.dmg" if machine == "arm64" else "_x64.dmg"
    return "_aarch64.AppImage" if machine in ("aarch64", "arm64") else "_amd64.AppImage"


def _latest_release():
    req = urllib.request.Request(LATEST_URL, headers={
        "User-Agent": "star", "Accept": "application/vnd.github+json"})
    with urllib.request.urlopen(req, timeout=15) as r:
        release = json.loads(r.read())
    # A release's app is built after the release is made; until it's there,
    # updating would leave the old app in place.
    if has_app() and not any(a.get("name", "").endswith(_app_asset_suffix())
                             for a in release.get("assets", [])):
        return None
    return release.get("tag_name")


def can_update():
    """Only installs made by the install script (which sets UNLOCKER_HOME)
    can update themselves; a git checkout updates with git."""
    return bool(os.environ.get("UNLOCKER_HOME"))


def updating():
    return _update_proc is not None and _update_proc.poll() is None


def _last_failure():
    """The error the last update ended with, if it failed."""
    try:
        lines = UPDATE_LOG.read_text(errors="replace").strip().splitlines()
    except OSError:
        return None
    last = re.sub(r"\x1b\[[0-9;]*m", "", lines[-1]) if lines else ""
    return last if last.startswith("Error:") else None


def update_state(force=False):
    """This version, the latest release (checked at most every few hours,
    or now when forced) and whether it's newer."""
    with _check_lock:
        if force or time.time() - _check["checked_at"] > CHECK_EVERY:
            try:
                _check.update(latest=_latest_release(), error=None)
            except (urllib.error.URLError, OSError, ValueError):
                _check["error"] = "Couldn't reach GitHub to check for updates."
            _check["checked_at"] = time.time()
        latest, error = _check["latest"], _check["error"]
    newer = bool(_key(latest) and _key(RELEASE) and _key(latest) > _key(RELEASE))
    return {"current": RELEASE, "latest": latest, "available": newer, "error": error,
            "can_update": can_update(), "updating": updating(),
            "failed": None if updating() else _last_failure()}


def start_update():
    """Runs the install script in the background, logging to UPDATE_LOG.
    It's its own process, so it outlives this server, which it stops."""
    global _update_proc
    args = ["--reopen"] if has_app() else ["--reopen", "--no-app"]
    script = ('tmp=$(mktemp) && curl -fsSL "$0" -o "$tmp" && sh "$tmp" "$@"; '
              'status=$?; rm -f "$tmp"; exit $status')
    # The same Python as this one, which the app found for the install.
    env = {**os.environ, "UNLOCKER_HOME": str(DATA_DIR),
           "PATH": f"{Path(sys.executable).parent}:{os.environ.get('PATH', '/usr/bin:/bin')}"}
    JSONS_DIR.mkdir(parents=True, exist_ok=True)
    with open(UPDATE_LOG, "w") as log:
        _update_proc = subprocess.Popen(
            ["/bin/sh", "-c", script, INSTALL_URL, *args], env=env,
            stdin=subprocess.DEVNULL, stdout=log, stderr=subprocess.STDOUT,
            start_new_session=True)
