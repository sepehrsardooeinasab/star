#!/bin/sh
# Exits 0 when no game is running or waiting to run, else says which and
# exits 1. For guarding anything that could disturb a run:
#
#   tools/no-session.sh && stardev
#
# Checks the installed app's data folder and this checkout's, whoever
# started the run (the app, stardev or a terminal), through the same locks
# the runs hold (lock_info in unlocker/state.py).
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
exec python3 - "$ROOT" <<'PYEOF'
import fcntl, os, sys
from pathlib import Path

home = Path.home()
dirs = [Path(sys.argv[1]),
        home / "Library/Application Support/STAR",
        Path(os.environ.get("XDG_DATA_HOME") or home / ".local/share") / "star"]
if os.environ.get("UNLOCKER_HOME"):
    dirs.insert(0, Path(os.environ["UNLOCKER_HOME"]).expanduser())

def holder(path):
    """The lock's "<pid> <label>" while a process holds it, else None."""
    try:
        with open(path) as f:
            try:
                fcntl.flock(f, fcntl.LOCK_SH | fcntl.LOCK_NB)
            except BlockingIOError:
                return f.read().strip() or "?"
            fcntl.flock(f, fcntl.LOCK_UN)
    except OSError:
        pass
    return None

running = set()
for jsons in {d.resolve() / "jsons" for d in dirs}:
    if jsons.is_dir():
        for lock in jsons.iterdir():
            if lock.name in (".game.lock", ".session.lock") or lock.name.startswith((".lock_", ".auto_")):
                held = holder(lock)
                if held:
                    pid, _, label = held.partition(" ")
                    running.add(f"{label or lock.name} (pid {pid})")
if running:
    sys.stderr.write("A session is running: " + ", ".join(sorted(running))
                     + ". Try again after it ends.\n")
    sys.exit(1)
PYEOF
