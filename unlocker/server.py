"""The local app: serves the app's page (docs/app.html) at
http://127.0.0.1:<ui_port>, plus a small JSON API the page uses when it's
opened from here — save a config straight into jsons/, start a game's
sessions in the background, stop them, and follow their output.

Runs are separate background processes (run_unlocker.py --auto), so closing
the browser — or stopping this server — never stops a run. Everything the
page shows is read back from the files runs already keep (configs, progress,
locks, logs), so reopening the page picks up exactly where things are."""
import csv
import json
import os
import re
import signal
import subprocess
import sys
import threading
import time
import urllib.request
import webbrowser
from datetime import datetime, timedelta
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from unlocker import achievements, asf_setup, extras, unlocks, updates
from unlocker import settings as settings_module
from unlocker.paths import CODE_DIR, DATA_DIR, write_atomic
from unlocker.runner import _session_bounds, _session_status, config_changed
from unlocker.settings import SETTINGS, SETTINGS_PATH
from unlocker.state import (
    COMPLETED_DIR,
    CSVS_DIR,
    DEFAULT_PROGRESS,
    GAME_LOCK,
    JSONS_DIR,
    PROJECT_DIR,
    SESSION_LOCK,
    acquire_lock,
    auto_lock_path,
    auto_log_path,
    config_fingerprint,
    config_problems,
    list_profiles,
    load_progress,
    lock_info,
    reset_progress,
    profile_lock_path,
    profile_paths,
    stop_after_path)

PORT = SETTINGS["ui_port"]
URL = f"http://127.0.0.1:{PORT}/"
DOCS_DIR = CODE_DIR / "docs"
RUN_SCRIPT = CODE_DIR / "unlocker" / "run_unlocker.py"
SERVER_LOCK = JSONS_DIR / ".app.lock"
SERVER_LOG = JSONS_DIR / ".app.log"
APP_ID = "steam-unlocker"

# Game names become file names (config_<name>.json, <name>.csv), so no
# slashes, no leading dot, nothing a shell would trip over badly.
NAME_RE = re.compile(r"[\w][\w .+-]{0,63}")
MAX_BODY = 5 * 1024 * 1024
LOG_TAIL_BYTES = 256 * 1024
# A game's log: each run starts with a RUN_HEADER line; the newest
# run_logs_kept runs are kept, up to LOG_MAX_BYTES.
RUN_HEADER = "\u2500\u2500 Started "
LOG_MAX_BYTES = 1024 * 1024


class AppError(Exception):
    def __init__(self, message, status=400, **extra):
        super().__init__(message)
        self.status = status
        self.extra = extra


def _starts_path(name):
    """When a run started with a delay starts its first session (ISO)."""
    return JSONS_DIR / f".starts_{name}"


def _seconds_until(iso):
    if not iso:
        return None
    return max(0, int((datetime.fromisoformat(iso) - datetime.now()).total_seconds()))


def _title(config):
    """The game's name: the one saved with it, else Steam's."""
    return ((config.get("game") if isinstance(config.get("game"), str) else None)
            or achievements.app_title(config["appid"]))


def _finished_config(name):
    """The config of a game a run finished, from its newest completed/
    folder, or None."""
    paths = sorted(list(COMPLETED_DIR.glob(f"{name}/config_{name}.json"))
                   + list(COMPLETED_DIR.glob(f"{name}_*/config_{name}.json")),
                   key=lambda p: p.stat().st_mtime, reverse=True)
    for path in paths:
        try:
            config = json.loads(path.read_text())
        except (OSError, json.JSONDecodeError):
            continue
        if not config_problems(config):
            return config
    return None


def _session_left(config, progress, next_unlock_in):
    """Seconds until the session playing ends: until its next unlock, then
    the delays of the rest of the session (the config's; randomness, when
    on, moves them a little)."""
    achievements = config["achievements"]
    following = progress["last_completed"] + 2
    rest = 0
    while following < len(achievements) and not achievements[following].get("new_session"):
        rest += achievements[following]["delay"]
        following += 1
    return (next_unlock_in or 0) + rest


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

    try:
        progress = load_progress(progress_path)
    except (OSError, ValueError) as e:
        # Damaged (a crash, a hand edit): this game needs its progress
        # reset (Reset progress); the others still show.
        game.update(state="invalid", progress_damaged=True, appid=config["appid"], title=_title(config),
                    icon=achievements.app_icon(config["appid"]),
                    error=f"Its progress file {e}. Reset it to start again from its first session; "
                          "achievements Steam already has are skipped.")
        return game
    if progress["appid"] != 0 and progress["appid"] != config["appid"]:
        progress = dict(DEFAULT_PROGRESS)
    total = len(config["achievements"])
    game.update(
        appid=config["appid"],
        copied_from=config.get("copied_from"),
        title=_title(config),
        icon=achievements.app_icon(config["appid"]),
        counters=achievements.app_counters(config["appid"]),
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
    # Stopped partway through a session (a shutdown, a crash, Stop): how
    # much of it played. Running it again picks up from there.
    start, end = _session_bounds(config["achievements"])[number - 1]
    played = progress["last_completed"] + 1 - start
    if not running and played > 0:
        game["cut_short"] = {"played": played, "of": end - start}
    if in_session:
        game["next_unlock_in"] = _seconds_until(progress["next_unlock_at"])
        game["session_left"] = _session_left(config, progress, game["next_unlock_in"])
    elif running:
        try:
            game["starts_in"] = _seconds_until(_starts_path(name).read_text().strip()) or None
        except (OSError, ValueError):
            pass
    return game


def game_states():
    session = lock_info(SESSION_LOCK)
    session_label = session[1] if session else None
    games, names = [], set()
    for name, _ in list_profiles():
        names.add(name)
        games.append(_game_state(name, session_label))
    # A game an auto run finished has had its config moved to completed/;
    # its log stays until dismissed, so the result can still be read.
    for log in JSONS_DIR.glob(".run_*.log"):
        name = log.name[len(".run_"):-len(".log")]
        if name not in names:
            game = {"name": name, "state": "completed", "running": False,
                    "auto": False, "in_session": False, "stop_after": False,
                    "has_log": True, "finished": True}
            config = _finished_config(name)
            if config:
                game.update(appid=config["appid"], copied_from=config.get("copied_from"),
                            title=_title(config), icon=achievements.app_icon(config["appid"]),
                            counters=achievements.app_counters(config["appid"]),
                            total=len(config["achievements"]),
                            done=len(config["achievements"]))
            games.append(game)
    games.sort(key=lambda g: g["name"])
    return {"games": games, "session": session_label}


def run_settings():
    """The settings the app edits: each one's value (settings.json's, else
    the default) and default."""
    try:
        overrides = settings_module.read_overrides()
    except ValueError as e:
        raise AppError(f"settings.json is {e}. Fix it or delete it.")
    return {"settings": [{"key": key, "value": overrides.get(key, settings_module.DEFAULTS[key]),
                          "default": settings_module.DEFAULTS[key]}
                         for key in settings_module.APP_EDITABLE + settings_module.APP_TOGGLES
                         + list(settings_module.APP_CHOICES)]}


def save_run_settings(values):
    """Writes the app's settings into settings.json, keeping its other keys
    and leaving out any that are back at their default. Runs started after
    this use them."""
    editable = settings_module.APP_EDITABLE + settings_module.APP_TOGGLES + list(settings_module.APP_CHOICES)
    if not isinstance(values, dict) or any(k not in editable for k in values):
        raise AppError("Unknown setting.")
    def change(overrides):
        overrides.update(values)
        found = settings_module.problems(overrides)
        if found:
            raise AppError(found[0][0].upper() + found[0][1:] + ".")
        return {k: v for k, v in overrides.items()
                if k not in editable or v != settings_module.DEFAULTS[k]}
    try:
        settings_module.update_overrides(change)
    except ValueError as e:
        raise AppError(f"settings.json is {e}. Fix it or delete it.")
    return run_settings()


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


def _move_break(name, old_config, config):
    """A game in its break waits until progress' session_ends_at, set from
    the break's length when the session ended. Saving a new length for that
    break moves it by the difference (keeping any randomness it got), and a
    break of 0 makes the game playable now. Returns the progress with it
    moved, for save_game to write with the rest, or None when it stays."""
    _, progress_path = profile_paths(name)
    try:
        progress = load_progress(progress_path)
    except (OSError, ValueError):
        return None  # damaged: Reset progress first
    if (old_config is None or progress["session_ends_at"] is None
            or progress["appid"] != config["appid"]
            or config_fingerprint(old_config) != config_fingerprint(config)):
        return None
    i = progress["last_completed"] + 1
    if not 0 < i < len(config["achievements"]):
        return None
    old, new = old_config["achievements"][i]["delay"], config["achievements"][i]["delay"]
    if old == new:
        return None
    ends = (datetime.now() if new == 0 else
            datetime.fromisoformat(progress["session_ends_at"]) + timedelta(seconds=new - old))
    progress["session_ends_at"] = ends.isoformat()
    return progress


# Saving a game's schedule: one save of a game at a time (two at once, say a
# double-clicked Save, can't mix their files or undo each other's), and a
# journal of what its files were, written before any is replaced and
# removed once all are. A save that fails puts them back from it; one cut
# off by a crash (the journal still there) is put back when the server
# next starts (recover_saves), or before that game's next save.
_save_locks, _save_locks_lock = {}, threading.Lock()


def _save_lock(name):
    with _save_locks_lock:
        return _save_locks.setdefault(name, threading.Lock())


def _journal_path(name):
    return JSONS_DIR / f".saving_{name}.json"


def _undo_save(journal, written=None):
    """Puts the files a save's journal lists back as they were before it
    (with written, just those it got to replace), then removes the
    journal. False if one couldn't be (the journal stays, to try again)."""
    restored = True
    for entry in reversed(json.loads(journal.read_text())["files"]):
        path = Path(entry["path"])
        if written is not None and path not in written:
            continue
        try:
            if entry["old"] is None:
                path.unlink(missing_ok=True)
            else:
                write_atomic(path, entry["old"])
        except OSError:
            restored = False
    if restored:
        journal.unlink(missing_ok=True)
    return restored


def recover_saves():
    """Undoes saves a crash cut off (their journals), and removes temp files
    older than a minute that an interrupted write left (newer ones may be a
    run's write going on now)."""
    for journal in JSONS_DIR.glob(".saving_*.json"):
        try:
            _undo_save(journal)
        except (OSError, ValueError, KeyError, TypeError):
            pass
    for folder in (JSONS_DIR, CSVS_DIR):
        for tmp in folder.glob("*.tmp"):
            try:
                if time.time() - tmp.stat().st_mtime > 60:
                    tmp.unlink()
            except OSError:
                pass


def save_game(name, config, csv_text, overwrite=False):
    with _save_lock(_check_name(name)):
        return _save_game(name, config, csv_text, overwrite)


def _save_game(name, config, csv_text, overwrite):
    name = _check_name(name)
    problems = config_problems(config)
    if problems:
        raise AppError("The config has problems: " + "; ".join(problems[:3]))
    if not isinstance(csv_text, str):
        raise AppError("Missing the timeline CSV.")
    config_path, _ = profile_paths(name)
    title = config.get("game") if isinstance(config.get("game"), str) and config.get("game") else name
    if _running_pid(name):
        raise AppError(f"{title} is running. Stop it before replacing its schedule.", 409)
    journal = _journal_path(name)
    if journal.exists():
        recovery_error = (f"Couldn't recover {title}'s previous save. Its recovery data was kept in "
                          f"{_shown_path(journal)}. Fix the file-access problem (or move that file away "
                          "to keep the files as they are now), then save again.")
        try:
            recovered = _undo_save(journal)
        except (OSError, ValueError, KeyError, TypeError) as e:
            raise AppError(recovery_error, 500) from e
        if not recovered:
            raise AppError(recovery_error, 500)
    if config_path.exists() and not overwrite:
        raise AppError(f"{title} is already saved (as {name}).", 409, exists=True)
    old_config = json.loads(config_path.read_text()) if config_path.exists() else None
    JSONS_DIR.mkdir(parents=True, exist_ok=True)
    CSVS_DIR.mkdir(parents=True, exist_ok=True)
    progress_path = profile_paths(name)[1]
    moved = _move_break(name, old_config, config)
    # The timeline, the config and (for a break being changed) the
    # progress are each replaced atomically; the journal (see above) has
    # what they were, so a save that fails, or one a crash cuts off, is
    # put back as it was.
    writes = [(CSVS_DIR / f"{name}.csv", csv_text), (config_path, json.dumps(config, indent=2) + "\n")]
    if moved is not None:
        writes.append((progress_path, json.dumps(moved, indent=2)))
    try:
        write_atomic(journal, json.dumps({"files": [
            {"path": str(path), "old": path.read_text() if path.exists() else None} for path, _ in writes]}))
    except OSError as e:
        raise AppError(f"Couldn't save {title} ({e.strerror or e}). Nothing was changed.", 500)
    written = []
    try:
        for path, text in writes:
            write_atomic(path, text)
            written.append(path)
    except OSError as e:
        restored = _undo_save(journal, written)
        raise AppError(f"Couldn't save {title} ({e.strerror or e}). " + ("Nothing was changed." if restored else
                       "Some of its files may be the new ones; they're put back when STAR next starts."), 500)
    journal.unlink(missing_ok=True)
    achievements.keep_asf_open()  # a Start often follows
    return {"saved": name}


def start_run(name, every=False, delay=None):
    """Runs the game's next session, or with every, all of them back to
    back; delay: minutes to wait before the first one starts."""
    name = _check_name(name)
    if delay is not None and (not isinstance(delay, int) or isinstance(delay, bool)
                              or not 0 <= delay <= 24 * 60):
        raise AppError("Start in: a number of minutes, up to a day.")
    if not profile_paths(name)[0].exists():
        raise AppError(f"There's no config for {name}.", 404)
    if _running_pid(name):
        raise AppError(f"{name} is already running.", 409)
    # A session that ended has its break to wait out first: the run waits
    # for it when it ends within break_wait, and can't start before then
    # (a stopped one can carry on, waiting only for its next unlock).
    state = _game_state(name, None)
    if state.get("state") == "invalid":
        raise AppError(f"{state.get('title') or name}: {state.get('error')}", 409)
    try:
        break_wait = settings_module.read_overrides().get("break_wait", SETTINGS["break_wait"])
    except ValueError:
        break_wait = SETTINGS["break_wait"]
    allowed = 0 if break_wait == "off" else int(break_wait.rstrip("h")) * 3600
    if state.get("ready_in", 0) > allowed and not state.get("cut_short"):
        raise AppError(f"{state.get('title') or name} isn't playable yet: the break after its last "
                       "session isn't over.", 409)
    other = lock_info(GAME_LOCK)
    if other:
        raise AppError(f"{other[1] or 'Another game'} is running. Only one game runs "
                       "at a time; stop it first.", 409)
    if _setup["busy"] == "install":
        raise AppError("ArchiSteamFarm is being installed or updated. Try again once it's done.", 409)
    if updates.updating():
        raise AppError("The app is updating. Try again once it has reopened.", 409)
    JSONS_DIR.mkdir(parents=True, exist_ok=True)
    _starts_path(name).unlink(missing_ok=True)
    if delay:
        _starts_path(name).write_text((datetime.now() + timedelta(minutes=delay)).isoformat())
    log_path = auto_log_path(name)
    try:
        kept = settings_module.read_overrides().get("run_logs_kept", SETTINGS["run_logs_kept"])
    except ValueError:
        kept = SETTINGS["run_logs_kept"]
    _keep_runs(log_path, kept - 1)  # and this one
    with open(log_path, "a") as log:
        log.write(f"{'' if log.tell() == 0 else chr(10)}{RUN_HEADER}{datetime.now():%a %b %-d, %H:%M} \u2500\u2500\n")
        log.flush()
        proc = subprocess.Popen(
            [sys.executable, "-u", str(RUN_SCRIPT), name, "--auto"]
            + ([] if every else ["--once"]) + (["-in", str(delay)] if delay else []),
            cwd=str(PROJECT_DIR), stdin=subprocess.DEVNULL, stdout=log,
            stderr=subprocess.STDOUT, start_new_session=True)
    # Started once it holds its lock (the first thing a run does), so the
    # next status already shows it running and a second click can't start
    # (and wipe the log of) another. One that ends first, or doesn't get
    # there in time (it's stopped then), didn't start: that's the answer,
    # with the last thing it printed.
    deadline = time.monotonic() + 15
    while not lock_info(auto_lock_path(name)) and proc.poll() is None and time.monotonic() < deadline:
        time.sleep(0.1)
    if not lock_info(auto_lock_path(name)):
        if proc.poll() is None:
            proc.terminate()
            try:
                proc.wait(5)
            except subprocess.TimeoutExpired:
                proc.kill()
        said = [line for line in log_path.read_text(errors="replace").splitlines()[-20:]
                if line.strip() and not line.startswith(RUN_HEADER)]
        title = state.get("title") or name
        last = said[-1].strip() if said else ""
        if last and last[-1] not in ".!?":
            last += "."
        raise AppError(f"{title} didn't start" + (f": {last}" if last else ".") + " Its log in Runs has the rest.", 500)
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
    """Makes a run stop once its current (or, between sessions, its next)
    session ends, or with on=False, play every session again."""
    name = _check_name(name)
    if not on:
        stop_after_path(name).unlink(missing_ok=True)
        return {"stop_after": False}
    if not lock_info(auto_lock_path(name)):
        raise AppError(f"{name} isn't running from the app.", 409)
    stop_after_path(name).touch()
    return {"stop_after": True}


def reset_game_progress(name):
    """Moves a game's damaged progress file aside (Reset progress), so it
    starts again from its first session."""
    name = _check_name(name)
    if _running_pid(name):
        raise AppError(f"{name} is running.", 409)
    reset_progress(profile_paths(name)[1])
    return {"reset": name}


def dismiss(name):
    name = _check_name(name)
    if _running_pid(name):
        raise AppError(f"{name} is running.", 409)
    auto_log_path(name).unlink(missing_ok=True)
    _starts_path(name).unlink(missing_ok=True)
    return {"dismissed": name}


def read_timeline(name):
    """The game's timeline CSV as saved with its config: in csvs/, or for a
    finished game, in its newest completed/ folder. Saving an edited one
    goes through save_game()."""
    name = _check_name(name)
    finished = sorted(list(COMPLETED_DIR.glob(f"{name}/{name}.csv"))
                      + list(COMPLETED_DIR.glob(f"{name}_*/{name}.csv")),
                      key=lambda p: p.stat().st_mtime, reverse=True)
    # The config too, for editing the timeline (a finished game's isn't).
    config = None
    config_path = profile_paths(name)[0]
    if config_path.exists():
        try:
            config = json.loads(config_path.read_text())
        except (OSError, json.JSONDecodeError):
            pass
    if config is None:
        config = _finished_config(name)
    for path in [CSVS_DIR / f"{name}.csv"] + finished:
        if path.is_file():
            return {"text": path.read_text(errors="replace"), "found": True, "config": config}
    return {"text": "", "found": False, "config": config, "known": _old_names(name)}


def _old_names(name):
    """Achievement names and the player's times by id, from the folder an
    older version saved instead of one CSV (csvs/<name>/merged.csv, or
    for a finished game, completed/<name>/<name>/merged.csv)."""
    known = {}
    folders = [CSVS_DIR / name] + sorted(COMPLETED_DIR.glob(f"{name}/{name}"))
    for path in [folder / "merged.csv" for folder in folders]:
        try:
            with open(path, newline="", errors="replace") as f:
                for row in csv.DictReader(f):
                    if row.get("ach_id"):
                        known[row["ach_id"]] = [row.get("ach_name") or "", row.get("unlock_time") or ""]
        except (OSError, csv.Error):
            continue
        if known:
            break
    return known


def _keep_runs(path, keep):
    """Drops all but the newest keep runs from a game's log (text from
    before the first header counts as one), then its oldest lines past
    LOG_MAX_BYTES."""
    try:
        text = path.read_text(errors="replace")
    except OSError:
        return
    starts = [m.start() for m in re.finditer("^" + re.escape(RUN_HEADER), text, re.M)]
    if text.strip() and (not starts or starts[0] != 0):
        starts.insert(0, 0)
    cut = text[starts[-keep]:] if keep and len(starts) > keep else ("" if not keep else text)
    if len(cut.encode()) > LOG_MAX_BYTES:
        cut = cut.encode()[-LOG_MAX_BYTES:].decode(errors="replace").split("\n", 1)[-1]
    if cut != text:
        path.write_text(cut)


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


# First-run setup (install ASF, sign in to Steam) runs in the background;
# the page polls setup_state() for its progress.
_setup = {"busy": None, "message": "", "error": None, "needs": None, "signed_in": False}
_setup_lock = threading.Lock()


def setup_state():
    with _setup_lock:
        return {**asf_setup.status(), **_setup, "extras": extras.status(), "asf_latest": _asf_latest,
                "data_dir": _shown_path(DATA_DIR)}


def _setup_update(**fields):
    with _setup_lock:
        _setup.update(fields)


def _setup_task(kind, work):
    with _setup_lock:
        if _setup["busy"]:
            raise AppError("Setup is already doing something; wait for it to finish.", 409)
        _setup.update(busy=kind, error=None, message="")

    def run():
        try:
            work()
        except Exception as e:  # shown on the page; the server keeps going
            _setup_update(error=str(e) or e.__class__.__name__)
        finally:
            _setup_update(busy=None)
    threading.Thread(target=run, daemon=True).start()
    return setup_state()


def _anything_running():
    return any(_running_pid(name) for name, _ in list_profiles())


def setup_install(latest=False):
    """Installs or updates ASF and the plugin: to the pinned pair, or with
    latest, to the newest compatible pair found by asf_check()."""
    versions = None
    if latest:
        if not (_asf_latest and _asf_latest.get("newer")):
            raise AppError("Check for an ArchiSteamFarm update first.", 409)
        versions = {"asf": _asf_latest["asf"], "plugin": _asf_latest["plugin"]}
    report = lambda m: _setup_update(message=m)
    return _setup_task("install", lambda: asf_setup.install(report=report, versions=versions))


# The last check for a newer ASF + plugin pair (from Settings).
_asf_latest = None


def asf_check():
    """Asks GitHub for the newest ASF + plugin pair that work together, and
    whether it's newer than what's installed."""
    global _asf_latest
    try:
        latest = asf_setup.latest_compatible()
    except asf_setup.SetupError as e:
        _asf_latest = {"error": str(e)}
        return setup_state()
    installed = asf_setup.installed_versions()
    key = asf_setup._version_key
    newer = (key(latest["asf"]) > key(installed.get("asf"))
             or key(latest["plugin"]) > key(installed.get("plugin")))
    _asf_latest = {**latest, "newer": newer}
    return setup_state()


def achievement_numbers(appid):
    """The game's achievements in aset's numbering, for the builder."""
    try:
        appid = int(appid)
    except (TypeError, ValueError):
        raise AppError("Enter the game's App ID first.")
    if appid <= 0:
        raise AppError("Enter the game's App ID first.")
    try:
        return achievements.numbers(appid)
    except achievements.Problem as e:
        raise AppError(str(e), 409, title=e.title)


def numbers_progress(appid):
    """The steps of an achievement-numbers check still going, for the
    builder to show while it waits."""
    try:
        steps = achievements.PROGRESS.get(int(appid), [])
    except (TypeError, ValueError):
        steps = []
    return {"steps": [{"text": text, "done": state == "done"} for text, state in steps]}


def achievements_from_link(url):
    """A player's unlocked achievements, from a SteamHunters or Steam link."""
    try:
        return achievements.from_link(str(url or "").strip())
    except achievements.Problem as e:
        raise AppError(str(e), 409, title=e.title)


def app_counters(appid):
    """How many of a game's achievements are counters, for Schedule; None
    while it's looked up."""
    try:
        appid = int(appid)
    except (TypeError, ValueError):
        return {"appid": None, "counters": None}
    return {"appid": appid, "counters": achievements.app_counters(appid)}


def recent_unlocks(refresh):
    """This account's latest unlocks, read from Steam (see unlocks)."""
    try:
        return unlocks.recent(refresh)
    except unlocks.Problem as e:
        raise AppError(str(e), 409, title=e.title, has_key=bool(unlocks._key()))


def change_achievements(appid, unlock, lock):
    try:
        return unlocks.start_change(appid, unlock, lock)
    except unlocks.Problem as e:
        raise AppError(str(e), 409, title=e.title)


def mark_finished(appid, finished):
    try:
        return unlocks.set_finished(appid, finished)
    except unlocks.Problem as e:
        raise AppError(str(e), 400, title=e.title)


def unlocks_game(appid):
    try:
        return unlocks.game_page(appid)
    except unlocks.Problem as e:
        raise AppError(str(e), 404, title=e.title)


def save_unlocks_key(key):
    try:
        return unlocks.save_key(str(key or ""))
    except unlocks.Problem as e:
        raise AppError(str(e), 409, title=e.title)
    except ValueError as e:
        raise AppError(f"settings.json is {e}. Fix it or delete it.")


def test_keep_awake():
    works, found = extras.test_keep_awake()
    return {"works": works, "found": found}


def _shown_path(path):
    """path with the home folder as ~, so it doesn't show the user's name."""
    path, home = path.resolve(), Path.home().resolve()
    try:
        return "~/" + str(path.relative_to(home))
    except ValueError:  # not under it (Path.is_relative_to is Python 3.9+)
        return str(path)


def open_data_folder():
    """Shows the data folder (games, ArchiSteamFarm, settings) in Finder or,
    on Linux, the desktop's file manager."""
    opener = "open" if sys.platform == "darwin" else "xdg-open"
    try:
        # Both return once the file manager has the request.
        ok = subprocess.run([opener, str(DATA_DIR)], stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL,
                            stderr=subprocess.DEVNULL, timeout=10).returncode == 0
    except (OSError, subprocess.SubprocessError):
        ok = False
    if not ok:
        raise AppError(f"Couldn't open the folder. It's at {_shown_path(DATA_DIR)}.", 500)
    return {"opened": True}


def app_update():
    if not updates.can_update():
        raise AppError("This copy wasn't installed with the install command; update it with git pull.", 409)
    # Runs keep their code in memory, so ones waiting between sessions carry
    # on; only a session that's playing has to finish first (the update may
    # swap ArchiSteamFarm, which it's using).
    session = lock_info(SESSION_LOCK)
    if session:
        raise AppError(f"{session[1]} is in a session. Update once the session ends; "
                       "games waiting for their next session are fine.", 409)
    if _setup["busy"]:
        raise AppError("Setup is busy; update once it's done.", 409)
    if not updates.updating():
        updates.start_update()
    return updates.update_state()


def _auto_update():
    """Installs a newer release by itself, the way Update now does, once
    no game is in a session and setup isn't busy. Each release is tried
    once per server; a failed one waits for Update now."""
    tried = set()
    time.sleep(90)  # let the app settle first
    while True:
        state = updates.update_state()  # asks GitHub at most every few hours
        if (state["available"] and state["can_update"] and not state["updating"]
                and state["latest"] not in tried and not lock_info(SESSION_LOCK)
                and not _setup["busy"]):
            tried.add(state["latest"])
            updates.start_update()
        time.sleep(600)


def _check_library():
    """Checks Steam for new games and achievements as often as Settings →
    Library says (library_check), the Library open or not; and soon after
    achievements change (by hand, or a run's unlock)."""
    time.sleep(20)  # let the app settle first
    looked = 0
    while True:
        try:
            unlocks.watch()
            if time.time() - looked >= 300:
                looked = time.time()
                unlocks.auto_check()
        except Exception:  # noqa: BLE001 - a background check never stops the server
            pass
        time.sleep(10)


def _learn_steamid():
    """Saves the account's Steam ID the first time ArchiSteamFarm runs
    signed in (a session, a check), so Unlocks works with it closed."""
    while not unlocks.STEAMID_PATH.exists():
        unlocks.steamid()  # asks ASF only when it's running
        time.sleep(120)


def _finish_login(result):
    if result == "logged_on":
        _setup_update(needs=None, signed_in=True, message="Signed in to Steam.")
        if not _anything_running():
            asf_setup.stop_asf()  # it's started again whenever a game runs
    elif result in ("SteamGuard", "TwoFactorAuthentication"):
        _setup_update(needs=result, message="")
    elif result in ("Login", "Password"):
        _setup_update(needs=None, error="Steam didn't accept that username or password.")
    elif result == "timeout":
        _setup_update(needs=None, error="Steam didn't answer in time. If it asked you to approve "
                      "the sign-in in the Steam mobile app, do that, then try again.")
    else:
        _setup_update(needs=None, error=f"Steam asked for {result}, which the app can't enter yet.")


def setup_login(username, password):
    if not (isinstance(username, str) and username.strip() and isinstance(password, str) and password):
        raise AppError("Enter your Steam username and password.")
    if not asf_setup.status()["asf"]:
        raise AppError("Install ArchiSteamFarm first.", 409)
    if _anything_running():
        raise AppError("A game is running. Stop it before changing the Steam account.", 409)

    def work():
        _setup_update(needs=None, signed_in=False, message="Signing in to Steam…")
        asf_setup.save_login(username.strip(), password)
        _finish_login(asf_setup.wait_for_login())
    return _setup_task("login", work)


def setup_code(code):
    needs = _setup["needs"]
    if not needs:
        raise AppError("Steam isn't waiting for a code.", 409)
    if not (isinstance(code, str) and code.strip()):
        raise AppError("Enter the code.")

    def work():
        _setup_update(message="Checking the code…")
        asf_setup.send_code(needs, code.strip())
        result = asf_setup.wait_for_login()
        _finish_login(result)
        if result == needs:
            _setup_update(error="That code didn't work. Check it and try again.")
    return _setup_task("code", work)


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
            # The app's page is app.html; index.html is the website's.
            if url.path in ("/", "/index.html"):
                self.path = "/app.html" + (f"?{url.query}" if url.query else "")
            return super().do_GET()
        query = {k: v[0] for k, v in parse_qs(url.query).items()}
        routes = {
            "/api/ping": lambda: {"app": APP_ID, "home": str(DATA_DIR.resolve()),
                                  "code": str(CODE_DIR), "pid": os.getpid()},
            "/api/games": game_states,
            "/api/setup": setup_state,
            "/api/update": lambda: updates.update_state(force=query.get("force") == "1"),
            "/api/log": lambda: read_log(query.get("name")),
            "/api/timeline": lambda: read_timeline(query.get("name")),
            "/api/achievements/progress": lambda: numbers_progress(query.get("appid")),
            "/api/achievements/counters": lambda: app_counters(query.get("appid")),
            "/api/settings": run_settings,
            "/api/unlocks": lambda: recent_unlocks(query.get("refresh") == "1"),
            "/api/unlocks/key": lambda: {"has_key": bool(unlocks._key())},
            "/api/unlocks/game": lambda: unlocks_game(query.get("appid")),
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
            "/api/run": lambda: start_run(name, bool(body.get("every")), body.get("delay")),
            "/api/stop": lambda: stop_run(name),
            "/api/stop-after": lambda: set_stop_after(name, bool(body.get("on", True))),
            "/api/dismiss": lambda: dismiss(name),
            "/api/reset-progress": lambda: reset_game_progress(name),
            "/api/settings": lambda: save_run_settings(body.get("settings")),
            "/api/setup/install": lambda: setup_install(bool(body.get("latest"))),
            "/api/setup/asf-check": asf_check,
            "/api/setup/test-awake": test_keep_awake,
            "/api/open-folder": open_data_folder,
            "/api/achievements/numbers": lambda: achievement_numbers(body.get("appid")),
            "/api/achievements/link": lambda: achievements_from_link(body.get("url")),
            "/api/achievements/appid": lambda: {"appid": achievements.find_appid(str(body.get("name") or "")[:200])},
            "/api/setup/login": lambda: setup_login(body.get("username"), body.get("password")),
            "/api/setup/code": lambda: setup_code(body.get("code")),
            "/api/unlocks/key": lambda: save_unlocks_key(body.get("key")),
            "/api/unlocks/finished": lambda: mark_finished(body.get("appid"), bool(body.get("finished"))),
            "/api/unlocks/achievements": lambda: change_achievements(body.get("appid"), body.get("unlock"), body.get("lock")),
            "/api/update": app_update,
            "/api/quit": quit_server,
        }
        self._route(routes.get(urlparse(self.path).path))

    def _route(self, handler):
        if handler is None:
            return self._json(404, {"error": "Not found."})
        try:
            self._json(200, handler())
        except AppError as e:
            self._json(e.status, {"error": str(e), **e.extra})


def _keep_asf_current():
    """An app update can pin a newer ArchiSteamFarm. Installs it now, or,
    if a game is in a session, once no session is playing (games waiting
    between sessions don't hold it up)."""
    # Settings a newer STAR relies on (like no update check of ASF's own)
    # reach an install that isn't updated too; ASF reads them when it starts
    # (and restarts if they change under it, so not while it's running).
    if asf_setup.ASF_BINARY.exists() and not asf_setup.asf_running():
        try:
            asf_setup.write_configs()
        except (OSError, ValueError):
            pass
    while True:
        if (asf_setup.status()["outdated"] and not lock_info(SESSION_LOCK)
                and not _setup["busy"] and not updates.updating()):
            try:
                setup_install()
            except AppError:
                pass
        time.sleep(600)


_server = None  # the running ThreadingHTTPServer, for quit_server()


def quit_server():
    """The desktop app closing: stops this server, which nothing needs
    once its window is gone (games run on their own and keep going), so
    macOS doesn't list STAR as running in the background. Not while
    ArchiSteamFarm is being installed, which runs in this process."""
    if _setup["busy"]:
        raise AppError("ArchiSteamFarm is being set up; the server stays until it's done.", 409)
    threading.Thread(target=_server.shutdown, daemon=True).start()
    return {"quit": True}


def serve():
    global _server
    if not acquire_lock(SERVER_LOCK, "app", keep=True):
        print("The app is already running.")
        return
    extras.extend_path()  # Homebrew's tools, for this server and its runs
    recover_saves()  # schedule saves a crash cut off
    server = ThreadingHTTPServer(("127.0.0.1", PORT), Handler)
    print(f"Serving {URL} (started {datetime.now():%a %H:%M}).")
    threading.Thread(target=_keep_asf_current, daemon=True).start()
    threading.Thread(target=_auto_update, daemon=True).start()
    threading.Thread(target=_learn_steamid, daemon=True).start()
    threading.Thread(target=_check_library, daemon=True).start()
    _server = server
    server.serve_forever()


def _ping():
    """What the server on our port says about itself, or None if there's
    none (or it isn't this app's)."""
    try:
        with urllib.request.urlopen(URL + "api/ping", timeout=1) as r:
            info = json.loads(r.read())
    except (OSError, ValueError):
        return None
    return info if isinstance(info, dict) and info.get("app") == APP_ID else None


def _ours(info):
    return info.get("home") == str(DATA_DIR.resolve()) and info.get("code") == str(CODE_DIR)


def _replace_other_server(info):
    """The port may be held by another copy's server: an older version for
    the same data (after an update), which is stopped, or one for other data
    (a project folder, say), which is left alone and reported."""
    pid = info.get("pid") if info.get("home") == str(DATA_DIR.resolve()) else None
    if not info.get("home"):  # before 3.04 it didn't say; this data's lock does
        pid = (lock_info(SERVER_LOCK) or [None])[0]
    if pid:
        os.kill(pid, signal.SIGTERM)
        deadline = time.monotonic() + 5
        while _ping():
            if time.monotonic() > deadline:
                break
            time.sleep(0.2)
        else:
            return
    where = info.get("home") or "an older version"
    print(f"Port {PORT} is used by another copy of STAR (data in {where}). "
          f"Stop it with runsteamunlocker --ui-stop from that copy, or set a different ui_port "
          f"in {SETTINGS_PATH}, then try again.")
    sys.exit(1)


def open_app(browser=True):
    """Starts the app in the background if it isn't running, then opens it
    in the browser — or, without browser, just prints its URL (the desktop
    app opens it in its own window)."""
    info = _ping()
    if info and not _ours(info):
        _replace_other_server(info)
        info = None
    if not info:
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
        if browser:
            print(f"Started the app at {URL}")
            print("It keeps running in the background; stop it with runsteamunlocker --ui-stop.")
    elif browser:
        print(f"The app is running at {URL}")
    if browser:
        webbrowser.open(URL)
    else:
        print(URL)


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
