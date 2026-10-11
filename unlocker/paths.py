import os
from pathlib import Path

# Where the code and the Unlock Scheduler page (docs/) live.
CODE_DIR = Path(__file__).resolve().parent.parent

# Where games, ArchiSteamFarm and settings.json live: the project folder
# itself, unless UNLOCKER_HOME points elsewhere (the app and the install
# script use a per-user folder, so the code can be replaced on update).
DATA_DIR = (Path(os.environ["UNLOCKER_HOME"]).expanduser()
            if os.environ.get("UNLOCKER_HOME") else CODE_DIR)
