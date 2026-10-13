import json
import sys
from unlocker.paths import DATA_DIR

SETTINGS_PATH = DATA_DIR / "settings.json"

# Every setting, with its default. settings.json only needs the keys being
# changed; anything left out keeps the value here.
DEFAULTS = {
    # Port ArchiSteamFarm's IPC listens on — must match archifarm/config/IPC.config.
    "asf_port": 1243,
    # ASF's IPCPassword (from ASF.json), if one is set. null when there's none.
    "ipc_password": None,
    # Port of the local app (runsteamunlocker --ui), at http://127.0.0.1:<port>.
    "ui_port": 8788,
    # How long a command keeps retrying while ASF starts up or the bot
    # (re)connects to Steam, before giving up.
    "bot_connect_timeout": 60,
    # Pause after "play" before the first unlock, when the bot was already
    # connected to Steam throughout.
    "warm_settle_delay": 10,
    # Same, after a fresh (re)connect. A 10s buffer wasn't enough in practice
    # — it still produced an epoch/offline-looking achievement timestamp once.
    "reconnect_settle_delay": 60,
    # During a session, how often (in seconds) to check ASF's log for a
    # reconnect to Steam, which silently drops the game "play" started.
    # It's also checked right before every unlock.
    "play_check_interval": 900,
    # Unlocks this close together in the source data count as simultaneous
    # (a 1s delay is usually the same event straddling a second boundary),
    # and are batched into a single aset.
    "simultaneous_max_delay": 1,
    # After a session ends, ASF is shut down this long later if it's idle.
    "asf_shutdown_delay": 300,
    # Whether to stop other ArchiSteamFarm instances on this machine when a
    # session starts. Needed when one of them logs into the same Steam
    # account (Steam allows only one login at a time); turn it off if
    # they use other accounts, e.g. a card-farming install.
    "stop_other_asf": True,
    # Randomness on delays: when on, each delay (between achievements, and
    # the gap between sessions) longer than jitter_min_delay seconds is moved
    # by a random amount up to ±jitter_percent of itself, so a run never
    # replays the source player's timings exactly. Off by default.
    "jitter_enabled": False,
    "jitter_min_delay": 60,
    "jitter_percent": 10,
    # Keep the computer from sleeping while a run waits or plays.
    "keep_awake": True,
    # Install a new STAR release by itself, when no game is in a session.
    "auto_update": True,
    # The app's Runs list: show finished games too (at the bottom).
    "show_finished": False,
    # How the app writes clock times: "system" (the computer's way),
    # "12h" (2:30 PM) or "24h" (14:30).
    "clock": "system",
    # The app's look (its Appearance menu).
    "theme": "dark",
    "accent": "violet",
}

# Accepted types per setting; None means null is allowed.
_TYPES = {
    "asf_port": (int,),
    "ipc_password": (str, type(None)),
    "ui_port": (int,),
    "bot_connect_timeout": (int,),
    "warm_settle_delay": (int,),
    "reconnect_settle_delay": (int,),
    "play_check_interval": (int,),
    "simultaneous_max_delay": (int,),
    "asf_shutdown_delay": (int,),
    "stop_other_asf": (bool,),
    "jitter_enabled": (bool,),
    "jitter_min_delay": (int,),
    "jitter_percent": (int, float),
    "keep_awake": (bool,),
    "auto_update": (bool,),
    "show_finished": (bool,),
    "clock": (str,),
    "theme": (str,),
    "accent": (str,),
}


# The ones the app's Settings tab edits, in its order. The ports and the
# IPC password stay in settings.json: they have to match ArchiSteamFarm's
# own config.
APP_EDITABLE = [
    "jitter_enabled", "jitter_percent", "jitter_min_delay",
    "stop_other_asf", "simultaneous_max_delay",
    "warm_settle_delay", "reconnect_settle_delay", "play_check_interval",
    "bot_connect_timeout", "asf_shutdown_delay",
]
# On/off switches the app shows on their own, outside the run settings.
APP_TOGGLES = ["keep_awake", "auto_update", "show_finished"]
# Choices the app shows on their own, with what each can be.
APP_CHOICES = {"clock": ["system", "12h", "24h"], "theme": ["dark", "light"],
               "accent": ["violet", "wine", "blue", "teal", "amber"]}

# Settings older versions had, ignored (and dropped on the next save from
# the app) rather than refused as unknown.
RETIRED = {"notifications"}


def problems(overrides):
    """What's wrong with a settings.json object, as messages (empty when
    it's fine): an unknown key, a wrong type or a value out of range."""
    if not isinstance(overrides, dict):
        return ["must be a JSON object"]
    found = []
    for key, value in overrides.items():
        if key not in DEFAULTS:
            found.append(f"unknown setting {key!r} (known: {', '.join(DEFAULTS)})")
        # bool is an int subclass in Python — don't accept true as 1.
        elif (isinstance(value, bool) and bool not in _TYPES[key]) or not isinstance(value, _TYPES[key]):
            found.append(f"{key!r} has the wrong type ({type(value).__name__})")
        elif not isinstance(value, bool) and isinstance(value, (int, float)) and value < 0:
            found.append(f"{key!r} can't be negative")
    if found:
        return found
    for port in ("asf_port", "ui_port"):
        if not 1 <= overrides.get(port, 1) <= 65535:
            found.append(f"{port!r} must be between 1 and 65535")
    if overrides.get("play_check_interval", 1) < 1:
        found.append("'play_check_interval' must be at least 1")
    if overrides.get("jitter_percent", 0) > 100:
        found.append("'jitter_percent' can't be more than 100")
    for key, choices in APP_CHOICES.items():
        if key in overrides and overrides[key] not in choices:
            found.append(f"{key!r} must be one of: {', '.join(choices)}")
    return found


def read_overrides(path=SETTINGS_PATH):
    """settings.json's own keys (not the defaults, nor RETIRED ones), or {}
    without one. Raises ValueError when it isn't valid JSON."""
    if not path.exists():
        return {}
    try:
        overrides = json.loads(path.read_text())
    except json.JSONDecodeError as e:
        raise ValueError(f"not valid JSON ({e})")
    if isinstance(overrides, dict):
        overrides = {k: v for k, v in overrides.items() if k not in RETIRED}
    return overrides


def _fail(message):
    print(f"settings.json: {message}")
    sys.exit(1)


def load_settings(path=SETTINGS_PATH):
    """DEFAULTS overlaid with settings.json, if it exists. Exits with a
    message on an unknown key or a wrong type, so a typo never silently
    falls back to a default."""
    try:
        overrides = read_overrides(path)
    except ValueError as e:
        _fail(str(e))
    found = problems(overrides)
    if found:
        _fail(found[0])
    return {**DEFAULTS, **overrides}


SETTINGS = load_settings()
