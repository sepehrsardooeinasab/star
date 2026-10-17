import os
import tempfile
from pathlib import Path

# Where the code and the Unlock Scheduler page (docs/) live.
CODE_DIR = Path(__file__).resolve().parent.parent

# Where games, ArchiSteamFarm and settings.json live: the project folder
# itself, unless UNLOCKER_HOME points elsewhere (the app and the install
# script use a per-user folder, so the code can be replaced on update).
DATA_DIR = (Path(os.environ["UNLOCKER_HOME"]).expanduser()
            if os.environ.get("UNLOCKER_HOME") else CODE_DIR)


def write_atomic(path, text):
    """Writes text to a temp file beside path, then renames it over path,
    which is atomic: a crash, a signal or a full disk mid-write leaves the
    old file as it was (or none), never a part-written one. Each write has
    a temp file of its own, so two writing the same file at once can't
    trip over each other's (the last to finish is what's kept)."""
    fd, tmp = tempfile.mkstemp(dir=path.parent, prefix=path.name + ".", suffix=".tmp")
    tmp = Path(tmp)
    try:
        with os.fdopen(fd, "w") as f:
            f.write(text)
            f.flush()
            os.fsync(f.fileno())
        os.replace(tmp, path)
    except BaseException:
        try:
            tmp.unlink()
        except OSError:
            pass
        raise
