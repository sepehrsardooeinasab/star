"""The local app: serves the Unlock Scheduler page from docs/ at
http://127.0.0.1:<ui_port>, plus a small JSON API the page uses when it's
opened from here — save a config straight into jsons/, start a game's
sessions in the background, stop them, and follow their output.

Runs are separate background processes (run_unlocker.py --auto), so closing
the browser — or stopping this server — never stops a run. Everything the
page shows is read back from the files runs already keep (configs, progress,
locks, logs), so reopening the page picks up exactly where things are."""
import json
import os
import re
import signal
import subprocess
import sys
import time
import urllib.request
import webbrowser
from datetime import datetime
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from unlocker.runner import _session_status, config_changed
from unlocker.settings import SETTINGS
from unlocker.state import (
    CSVS_DIR,
    DEFAULT_PROGRESS,
    JSONS_DIR,
    PROJECT_DIR,
    SESSION_LOCK,
    acquire_lock,
    auto_lock_path,
    auto_log_path,
    config_problems,
    list_profiles,
    load_progress,
    lock_info,
    profile_lock_path,
    profile_paths,
    stop_after_path)

PORT = SETTINGS["ui_port"]
URL = f"http://127.0.0.1:{PORT}/"
DOCS_DIR = PROJECT_DIR / "docs"
RUN_SCRIPT = PROJECT_DIR / "unlocker" / "run_unlocker.py"
SERVER_LOCK = JSONS_DIR / ".app.lock"
SERVER_LOG = JSONS_DIR / ".app.log"
APP_ID = "steam-unlocker"

# Game names become file names (config_<name>.json, <name>.csv), so no
# slashes, no leading dot, nothing a shell would trip over badly.
NAME_RE = re.compile(r"[\w][\w .+-]{0,63}")
MAX_BODY = 5 * 1024 * 1024
LOG_TAIL_BYTES = 64 * 1024


class AppError(Exception):
    def __init__(self, message, status=400, **extra):
        super().__init__(message)
        self.status = status
        self.extra = extra


def _seconds_until(iso):
    if not iso:
        return None
    return max(0, int((datetime.fromisoformat(iso) - datetime.now()).total_seconds()))


def _game_state(name, session_label):
    config_path, progress_path = profile_paths(name)
    auto = lock_info(auto_lock_path(name))
    running = auto or lock_info(profile_lock_path(name))
    in_session = bool(running) and session_label == name
    game = {
        "name": name,
        "running": bool(running),
        "auto": bool(auto),
        "in_session": in_session,
        "stop_after": stop_after_path(name).exists(),
        "has_log": auto_log_path(name).exists(),
        "state": "in_session" if in_session else "waiting" if running else "idle",
    }
    try:
        config = json.loads(config_path.read_text())
        problems = config_problems(config)
    except (OSError, json.JSONDecodeError) as e:
        problems = [f"can't be read ({e.__class__.__name__})"]
    if problems:
        game.update(state="invalid", error=problems[0])
        return game

    progress = load_progress(progress_path)
    if progress["appid"] != 0 and progress["appid"] != config["appid"]:
        progress = dict(DEFAULT_PROGRESS)
    total = len(config["achievements"])
    game.update(
        appid=config["appid"],
        copied_from=config.get("copied_from"),
        total=total,
        done=min(progress["last_completed"] + 1, total),
        config_changed=config_changed(config, progress))

    status = _session_status(config, progress)
    if status is None:
        if not running:
            game["state"] = "completed"
        return game
    number, sessions, count, duration, wait = status
    game.update(session=number, sessions=sessions, count=count,
                duration=duration, ready_in=wait)
    if in_session:
        game["next_unlock_in"] = _seconds_until(progress["next_unlock_at"])
    return game


def game_states():
    session = lock_info(SESSION_LOCK)
    session_label = session[1] if session else None
    games, names = [], set()
    for name, _ in list_profiles():
        if name is None:  # a bare config.json, from before named configs
            continue
        names.add(name)
        games.append(_game_state(name, session_label))
    # A game an auto run finished has had its config moved to completed/;
    # its log stays until dismissed, so the result can still be read.
    for log in JSONS_DIR.glob(".run_*.log"):
        name = log.name[len(".run_"):-len(".log")]
        if name not in names:
            games.append({"name": name, "state": "completed", "running": False,
                          "auto": False, "in_session": False, "stop_after": False,
                          "has_log": True, "finished": True})
    games.sort(key=lambda g: g["name"])
    return {"games": games, "session": session_label}


def _check_name(name):
    if not isinstance(name, str) or not NAME_RE.fullmatch(name):
        raise AppError("Game names can use letters, numbers, spaces and . _ + - "
                       "(up to 64), and can't start with a dot.")
    return name


def _running_pid(name):
    """PID of whatever is running this game — an auto run, or a single
    run started from a terminal — or None."""
    info = lock_info(auto_lock_path(name)) or lock_info(profile_lock_path(name))
    return info[0] if info else None


def save_game(name, config, csv_text, overwrite=False):
    name = _check_name(name)
    problems = config_problems(config)
    if problems:
        raise AppError("The config has problems: " + "; ".join(problems[:3]))
    if not isinstance(csv_text, str):
        raise AppError("Missing the timeline CSV.")
    config_path, _ = profile_paths(name)
    if _running_pid(name):
        raise AppError(f"{name} is running. Stop it before replacing its config.", 409)
    if config_path.exists() and not overwrite:
        raise AppError(f"config_{name}.json already exists.", 409, exists=True)
    JSONS_DIR.mkdir(parents=True, exist_ok=True)
    CSVS_DIR.mkdir(parents=True, exist_ok=True)
    config_path.write_text(json.dumps(config, indent=2) + "\n")
    (CSVS_DIR / f"{name}.csv").write_text(csv_text)
    return {"saved": name}


def start_run(name):
    name = _check_name(name)
    if not profile_paths(name)[0].exists():
        raise AppError(f"There's no config for {name}.", 404)
    if _running_pid(name):
        raise AppError(f"{name} is already running.", 409)
    JSONS_DIR.mkdir(parents=True, exist_ok=True)
    with open(auto_log_path(name), "w") as log:
        proc = subprocess.Popen(
            [sys.executable, "-u", str(RUN_SCRIPT), name, "--auto"],
            cwd=str(PROJECT_DIR), stdin=subprocess.DEVNULL, stdout=log,
            stderr=subprocess.STDOUT, start_new_session=True)
    # Wait until it holds its lock, so the next status already shows it
    # running and a second click can't start (and wipe the log of) another.
    deadline = time.monotonic() + 5
    while not lock_info(auto_lock_path(name)) and proc.poll() is None and time.monotonic() < deadline:
        time.sleep(0.1)
    return {"started": name}


def stop_run(name):
    name = _check_name(name)
    pid = _running_pid(name)
    if not pid:
        raise AppError(f"{name} isn't running.", 409)
    stop_after_path(name).unlink(missing_ok=True)
    try:
        os.kill(pid, signal.SIGTERM)
    except ProcessLookupError:
        pass
    return {"stopped": name}


def set_stop_after(name, on):
    """Asks an auto run to stop once its current session ends. Between
    sessions nothing is playing, so it just stops now."""
    name = _check_name(name)
    if not on:
        stop_after_path(name).unlink(missing_ok=True)
        return {"stop_after": False}
    if not lock_info(auto_lock_path(name)):
        raise AppError(f"{name} isn't running from the app.", 409)
    session = lock_info(SESSION_LOCK)
    if not (session and session[1] == name):
        stop_run(name)
        return {"stopped": name}
    stop_after_path(name).touch()
    return {"stop_after": True}


def dismiss(name):
    name = _check_name(name)
    if _running_pid(name):
        raise AppError(f"{name} is running.", 409)
    auto_log_path(name).unlink(missing_ok=True)
    return {"dismissed": name}


def read_log(name):
    path = auto_log_path(_check_name(name))
    if not path.exists():
        return {"text": ""}
    with open(path, "rb") as f:
        f.seek(0, os.SEEK_END)
        f.seek(max(0, f.tell() - LOG_TAIL_BYTES))
        data = f.read()
    text = data.decode("utf-8", errors="replace")
    if len(data) == LOG_TAIL_BYTES:
        text = text.split("\n", 1)[-1]  # drop the partial first line
    return {"text": text}


class Handler(SimpleHTTPRequestHandler):
    # Only this app's own page may call the API: requests must be addressed
    # to it by name (blocks DNS rebinding), and a POST from a browser must
    # come from its origin as JSON (blocks other sites posting forms to it).
    ALLOWED_HOSTS = {f"127.0.0.1:{PORT}", f"localhost:{PORT}"}
    ALLOWED_ORIGINS = {f"http://{h}" for h in ALLOWED_HOSTS}

    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(DOCS_DIR), **kwargs)

    def log_message(self, format, *args):
        pass

    def end_headers(self):
        self.send_header("Cache-Control", "no-store")
        super().end_headers()

    def _json(self, status, body):
        data = json.dumps(body).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def _host_ok(self):
        if self.headers.get("Host") in self.ALLOWED_HOSTS:
            return True
        self._json(403, {"error": "Forbidden host."})
        return False

    def do_GET(self):
        if not self._host_ok():
            return
        url = urlparse(self.path)
        if not url.path.startswith("/api/"):
            return super().do_GET()
        query = {k: v[0] for k, v in parse_qs(url.query).items()}
        routes = {
            "/api/ping": lambda: {"app": APP_ID},
            "/api/games": game_states,
            "/api/log": lambda: read_log(query.get("name")),
        }
        self._route(routes.get(url.path))

    def do_POST(self):
        if not self._host_ok():
            return
        origin = self.headers.get("Origin")
        if origin is not None and origin not in self.ALLOWED_ORIGINS:
            return self._json(403, {"error": "Forbidden origin."})
        if self.headers.get("Content-Type", "").split(";")[0].strip() != "application/json":
            return self._json(415, {"error": "Expected JSON."})
        length = int(self.headers.get("Content-Length") or 0)
        if length > MAX_BODY:
            return self._json(413, {"error": "Request too large."})
        try:
            body = json.loads(self.rfile.read(length) or b"{}")
        except json.JSONDecodeError:
            return self._json(400, {"error": "Invalid JSON."})
        if not isinstance(body, dict):
            return self._json(400, {"error": "Expected a JSON object."})
        name = body.get("name")
        routes = {
            "/api/save": lambda: save_game(name, body.get("config"), body.get("csv"),
                                           bool(body.get("overwrite"))),
            "/api/run": lambda: start_run(name),
            "/api/stop": lambda: stop_run(name),
            "/api/stop-after": lambda: set_stop_after(name, bool(body.get("on", True))),
            "/api/dismiss": lambda: dismiss(name),
        }
        self._route(routes.get(urlparse(self.path).path))

    def _route(self, handler):
        if handler is None:
            return self._json(404, {"error": "Not found."})
        try:
            self._json(200, handler())
        except AppError as e:
            self._json(e.status, {"error": str(e), **e.extra})


def serve():
    if not acquire_lock(SERVER_LOCK, "app", keep=True):
        print("The app is already running.")
        return
    server = ThreadingHTTPServer(("127.0.0.1", PORT), Handler)
    print(f"Serving {URL} (started {datetime.now():%a %H:%M}).")
    server.serve_forever()


def _ping():
    try:
        with urllib.request.urlopen(URL + "api/ping", timeout=1) as r:
            return json.loads(r.read()).get("app") == APP_ID
    except (OSError, ValueError):
        return False


def open_app():
    """Starts the app in the background if it isn't running, then opens it
    in the browser."""
    if not _ping():
        JSONS_DIR.mkdir(parents=True, exist_ok=True)
        with open(SERVER_LOG, "a") as log:
            subprocess.Popen(
                [sys.executable, "-u", str(Path(__file__).resolve())],
                cwd=str(PROJECT_DIR), stdin=subprocess.DEVNULL, stdout=log,
                stderr=subprocess.STDOUT, start_new_session=True)
        deadline = time.monotonic() + 5
        while not _ping():
            if time.monotonic() > deadline:
                print(f"Couldn't start the app on port {PORT} (is something else using it?). "
                      f"See {SERVER_LOG.relative_to(PROJECT_DIR)}.")
                sys.exit(1)
            time.sleep(0.2)
        print(f"Started the app at {URL}")
        print("It keeps running in the background; stop it with runsteamunlocker --ui-stop.")
    else:
        print(f"The app is running at {URL}")
    webbrowser.open(URL)


def stop_app():
    """Stops the app's server. Runs it started keep going."""
    info = lock_info(SERVER_LOCK)
    if not info or not info[0]:
        print("The app isn't running.")
        return
    os.kill(info[0], signal.SIGTERM)
    print("Stopped the app. Running games keep going.")


if __name__ == "__main__":
    serve()
