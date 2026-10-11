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
}


def _fail(message):
    print(f"settings.json: {message}")
    sys.exit(1)


def load_settings(path=SETTINGS_PATH):
    """DEFAULTS overlaid with settings.json, if it exists. Exits with a
    message on an unknown key or a wrong type, so a typo never silently
    falls back to a default."""
    if not path.exists():
        return dict(DEFAULTS)

    try:
        overrides = json.loads(path.read_text())
    except json.JSONDecodeError as e:
        _fail(f"not valid JSON ({e})")
    if not isinstance(overrides, dict):
        _fail("must be a JSON object")

    for key, value in overrides.items():
        if key not in DEFAULTS:
            _fail(f"unknown setting {key!r} (known: {', '.join(DEFAULTS)})")
        # bool is an int subclass in Python — don't accept true as 1.
        if (isinstance(value, bool) and bool not in _TYPES[key]) or not isinstance(value, _TYPES[key]):
            _fail(f"{key!r} has the wrong type ({type(value).__name__})")
        if not isinstance(value, bool) and isinstance(value, (int, float)) and value < 0:
            _fail(f"{key!r} can't be negative")
    for port in ("asf_port", "ui_port"):
        if not 1 <= overrides.get(port, 1) <= 65535:
            _fail(f"{port!r} must be between 1 and 65535")
    if overrides.get("play_check_interval", 1) < 1:
        _fail("'play_check_interval' must be at least 1")
    if overrides.get("jitter_percent", 0) > 100:
        _fail("'jitter_percent' can't be more than 100")

    return {**DEFAULTS, **overrides}


SETTINGS = load_settings()
