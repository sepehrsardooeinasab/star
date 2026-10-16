import fcntl
import hashlib
import os
import sys
import json
import shutil
import time
from datetime import datetime
from pathlib import Path

from unlocker.paths import DATA_DIR

PROJECT_DIR = DATA_DIR
JSONS_DIR = PROJECT_DIR / "jsons"
CSVS_DIR = PROJECT_DIR / "csvs"
COMPLETED_DIR = PROJECT_DIR / "completed"

DEFAULT_PROGRESS = {
    "appid": 0,
    "last_completed": -1,
    "next_unlock_at": None,
    "session_ends_at": None,
    # Fingerprint of the config's achievement order when progress was saved
    # (see config_fingerprint). None in progress files from before it existed.
    "config_hash": None,
}

# Held while a session talks to ASF, by whichever game is running: ASF can
# only "play" one game at a time.
SESSION_LOCK = JSONS_DIR / ".session.lock"

# Held by whichever game is running, for its whole run (breaks included):
# only one game runs at a time.
GAME_LOCK = JSONS_DIR / ".game.lock"


def profile_paths(game_name):
    """config/progress paths for a game, sharing the same jsons/ folder."""
    return (JSONS_DIR / f"config_{game_name}.json",
            JSONS_DIR / f"progress_{game_name}.json")


def list_profiles():
    """Game names for every config_*.json in jsons/, with their appid."""
    if not JSONS_DIR.exists():
        return []

    profiles = []
    for path in sorted(JSONS_DIR.glob("config_*.json")):
        name = path.stem[len("config_"):]
        try:
            appid = json.loads(path.read_text()).get("appid")
        except (json.JSONDecodeError, OSError):
            appid = None
        profiles.append((name, appid))

    return profiles


def config_problems(config):
    """Everything wrong with a config's shape, as messages (empty when it's
    fine) — checked up front so a bad field can't surface as a KeyError
    halfway through a session, after "play" was already sent."""
    if not isinstance(config, dict):
        return ["the file must be a JSON object"]
    problems = []
    appid = config.get("appid")
    if isinstance(appid, bool) or not isinstance(appid, int) or appid <= 0:
        problems.append(f"appid must be a positive whole number (got {appid!r})")

    achievements = config.get("achievements")
    if not isinstance(achievements, list) or not achievements:
        return problems + ["no achievements found"]

    seen = set()
    for n, ach in enumerate(achievements, 1):
        where = f"achievement #{n}"
        if not isinstance(ach, dict):
            problems.append(f"{where} isn't an object")
            continue
        ach_id, delay, new_session = ach.get("id"), ach.get("delay"), ach.get("new_session")
        if isinstance(ach_id, bool) or not isinstance(ach_id, int) or ach_id <= 0:
            problems.append(f"{where}: id must be a positive whole number (got {ach_id!r})")
        elif ach_id in seen:
            problems.append(f"{where}: id {ach_id} appears more than once")
        else:
            seen.add(ach_id)
        if isinstance(delay, bool) or not isinstance(delay, int) or delay < 0:
            problems.append(f"{where}: delay must be a whole number of seconds, 0 or more (got {delay!r})")
        if not isinstance(new_session, bool):
            problems.append(f"{where}: new_session must be true or false (got {new_session!r})")
    return problems


def load_config(path):
    if not path.exists():
        print(f"Missing {path}")
        sys.exit(1)

    try:
        config = json.loads(path.read_text())
    except json.JSONDecodeError as e:
        print(f"{path.name} isn't valid JSON ({e}).")
        sys.exit(1)
    problems = config_problems(config)
    if problems:
        print(f"{path.name} has problems:")
        for problem in problems[:10]:
            print(f"  - {problem}")
        if len(problems) > 10:
            print(f"  ...and {len(problems) - 10} more.")
        sys.exit(1)

    return config


def config_fingerprint(config):
    """Short hash of the appid and the order of achievement ids. Progress is
    stored as a position in that list, so a change here means the saved
    position may now point at a different achievement. Delay and session
    edits don't change it, since they leave every position in place."""
    ids = [a["id"] for a in config["achievements"]]
    return hashlib.sha256(json.dumps([config["appid"], ids]).encode()).hexdigest()[:16]


def load_progress(path):
    if not path.exists():
        return dict(DEFAULT_PROGRESS)
    return {**DEFAULT_PROGRESS, **json.loads(path.read_text())}


def save_progress(path, progress):
    """Writes to a temp file and renames it over the real one, which is
    atomic: a signal or crash mid-write leaves the old file intact instead
    of a truncated one that can't be parsed."""
    tmp = path.with_name(path.name + ".tmp")
    with open(tmp, "w") as f:
        f.write(json.dumps(progress, indent=2))
        f.flush()
        os.fsync(f.fileno())
    os.replace(tmp, path)


_held_locks = []  # open lock files, kept referenced so they stay locked
_kept_locks = []  # same, but left alone by release_locks()


def acquire_lock(path, label, block=False, keep=False):
    """Takes an exclusive lock on path, recording label and this PID in it.
    Returns True once held — until this process exits, even if it's killed,
    since the OS drops the lock with the process. Without block, returns
    False when another process holds it. keep: survive release_locks(), for
    a lock held across several runs in one process."""
    path.parent.mkdir(parents=True, exist_ok=True)
    f = open(path, "a+")
    # A few tries: a lock_info() looking right then holds it for a moment.
    for attempt in range(5):
        try:
            fcntl.flock(f, fcntl.LOCK_EX | (0 if block else fcntl.LOCK_NB))
            break
        except BlockingIOError:
            if attempt == 4:
                f.close()
                return False
            time.sleep(0.02)
    f.seek(0)
    f.truncate()
    f.write(f"{os.getpid()} {label}\n")
    f.flush()
    (_kept_locks if keep else _held_locks).append(f)
    return True


def release_locks():
    """Releases every lock acquire_lock() took in this process."""
    while _held_locks:
        _held_locks.pop().close()


def lock_info(path):
    """(pid or None, label) of the process holding path's lock, or None if
    nobody holds it. Read-only: a shared lock for the check itself, so two
    checks at once don't each see the other as the holder."""
    if not path.exists():
        return None
    with open(path, "a+") as f:
        try:
            fcntl.flock(f, fcntl.LOCK_SH | fcntl.LOCK_NB)
        except BlockingIOError:
            f.seek(0)
            pid, _, label = f.read().strip().partition(" ")
            return (int(pid) if pid.isdigit() else None), label
        fcntl.flock(f, fcntl.LOCK_UN)
    return None


def hold_game_lock(game_label, keep=False):
    """Takes GAME_LOCK for this game, or returns the other running game's
    label. Already held by this process (an auto run's next session) counts
    as taken."""
    info = lock_info(GAME_LOCK)
    if info and info[0] == os.getpid():
        return None
    if acquire_lock(GAME_LOCK, game_label, keep=keep):
        return None
    info = lock_info(GAME_LOCK)
    return (info and info[1]) or "another game"


def lock_holder(path):
    """'<label> (PID <pid>)' for the process holding path's lock, or None if
    nobody holds it."""
    info = lock_info(path)
    if info is None:
        return None
    pid, label = info
    return f"{label or '?'} (PID {pid or '?'})"


def profile_lock_path(game_name):
    return JSONS_DIR / f".lock_{game_name}"


# An auto run (--auto, or Run in the app) plays every remaining session of a
# game back to back. Its lock is held for the whole run, its output goes to
# the log, and the flag file asks it to stop once the current session ends.
def auto_lock_path(game_name):
    return JSONS_DIR / f".auto_{game_name}"


def auto_log_path(game_name):
    return JSONS_DIR / f".run_{game_name}.log"


def stop_after_path(game_name):
    return JSONS_DIR / f".stop_after_{game_name}"


def cleanup_profile(game_name):
    """Once a game is finished: moves its config and CSV (the single
    csvs/<name>.csv, or an older export's csvs/<name>/ folder) into
    completed/<name>/, and deletes its progress file. A game finished
    before gets a dated folder instead, so nothing is overwritten."""
    config_path, progress_path = profile_paths(game_name)
    name = game_name

    dest = COMPLETED_DIR / name
    if dest.exists():
        dest = COMPLETED_DIR / f"{name}_{datetime.now():%Y-%m-%d_%H%M%S}"
    dest.mkdir(parents=True)

    moved = []
    if config_path.exists():
        shutil.move(config_path, dest / config_path.name)
        moved.append("config")
    csvs = [p for p in (CSVS_DIR / f"{name}.csv", CSVS_DIR / name) if p.exists()]
    for csv in csvs:
        shutil.move(csv, dest / csv.name)
    if csvs:
        moved.append("CSV")
    progress_path.unlink(missing_ok=True)

    if moved:
        print(f"Moved {' and '.join(moved)} to {dest.relative_to(PROJECT_DIR)}/.")
    if not csvs:
        print(f"Warning: no CSV found for {name} in csvs/ — nothing to move.")
