import json
import sys
import threading
from unlocker.paths import DATA_DIR, write_atomic

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
    # reconnect to Steam, which silently drops the game "play" started (it's
    # started again then). It's also checked right before every unlock. Only
    # the log file is read, so it can be often: the game is back within
    # this long, rather than shown as not playing until the next unlock.
    "play_check_interval": 30,
    # How many of a game's runs its log keeps (Runs shows them), newest
    # last; older ones are dropped when a run starts.
    "run_logs_kept": 3,
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
    # How long before a break ends the app's Continue can start a session,
    # waiting out the rest of the break (Steam untouched): "off" (only once
    # it's playable), 1h, 3h, 6h, 12h or 24h.
    "break_wait": "6h",
    # The app's Runs list: show finished games too (at the bottom).
    "show_finished": False,
    # A Steam Web API key (steamcommunity.com/dev/apikey), so the app's
    # Library covers every game played, not just the games in STAR.
    "steam_api_key": None,
    # How the app writes clock times: "12h" (2:30 PM) or "24h" (14:30);
    # "system" until one's picked: the usual one for the computer's
    # language.
    "clock": "system",
    # The app's look (its Appearance menu).
    "theme": "dark",
    "accent": "violet",
    # Games' art behind run cards and a game page's header: "off", "normal"
    # or "blur"; and the colour glows behind a game: "off" or "on".
    "banners": "off",
    "gradient": "off",
    # How far back the app's Library lists achievements: today, this week,
    # this month, this year, or all. Weeks start on week_start's day.
    "unlocks_range": "month",
    "week_start": "monday",
    # How the Library's Games are sorted: by when last played, the last
    # achievement, name or progress; descending (newest, Z–A, most) or not.
    "library_sort": "played",
    "library_order": "desc",
    # How a game's achievements are listed on its page: in Steam's own
    # order ("default"), by date unlocked or name, descending (reversed,
    # newest, Z–A) or not; grouped into unlocked and
    # locked ("status") or all in one list ("none").
    "achievement_sort": "date",
    "achievement_order": "desc",
    "achievement_group": "status",
    # Which games the Library's Games list shows, by group, each "show",
    # "only" (just games in it) or "hide" (games not in it): those marked
    # Private in Steam, those marked finished, those without achievements,
    # and the rest ("active"). A game shows when it fits every group set
    # to "only" or "hide", or with library_match "any", one of them.
    "library_active": "show",
    "library_private": "show",
    "library_no_achievements": "show",
    "library_finished": "show",
    "library_match": "all",
    # Which section the app's Library opens on: achievements or games.
    "library_tab": "achievements",
    # Hidden achievements' descriptions in the Library: shown once
    # unlocked, always ("all"), or never ("none").
    "hidden_descriptions": "unlocked",
    # How often the Library checks Steam for new games and achievements,
    # in the background, at set times of day counted from midnight (6h:
    # 12 AM, 6 AM, 12 PM, 6 PM): 1h, 3h, 6h, 12h, 24h, or "manual" (on
    # Refresh).
    "library_check": "6h",
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
    "run_logs_kept": (int,),
    "simultaneous_max_delay": (int,),
    "asf_shutdown_delay": (int,),
    "stop_other_asf": (bool,),
    "jitter_enabled": (bool,),
    "jitter_min_delay": (int,),
    "jitter_percent": (int, float),
    "keep_awake": (bool,),
    "break_wait": (str,),
    "show_finished": (bool,),
    "steam_api_key": (str, type(None)),
    "clock": (str,),
    "theme": (str,),
    "accent": (str,),
    "banners": (str,),
    "gradient": (str,),
    "unlocks_range": (str,),
    "week_start": (str,),
    "library_sort": (str,),
    "library_order": (str,),
    "achievement_sort": (str,),
    "achievement_order": (str,),
    "achievement_group": (str,),
    "library_active": (str,),
    "library_private": (str,),
    "library_no_achievements": (str,),
    "library_finished": (str,),
    "library_match": (str,),
    "library_tab": (str,),
    "hidden_descriptions": (str,),
    "library_check": (str,),
}


# The ones the app's Settings tab edits, in its order. The ports and the
# IPC password stay in settings.json: they have to match ArchiSteamFarm's
# own config.
APP_EDITABLE = [
    "jitter_enabled", "jitter_percent", "jitter_min_delay",
    "stop_other_asf", "simultaneous_max_delay",
    "warm_settle_delay", "reconnect_settle_delay", "play_check_interval",
    "bot_connect_timeout", "asf_shutdown_delay", "run_logs_kept",
]
# On/off switches the app shows on their own, outside the run settings.
APP_TOGGLES = ["keep_awake", "show_finished"]
# Choices the app shows on their own, with what each can be.
APP_CHOICES = {"clock": ["system", "12h", "24h"], "theme": ["dark", "light"],
               "break_wait": ["off", "1h", "3h", "6h", "12h", "24h"],
               "accent": ["violet", "wine", "blue", "teal", "amber"],
               "banners": ["off", "normal", "blur"],
               "gradient": ["off", "on"],
               "unlocks_range": ["day", "week", "month", "year", "all"],
               "week_start": ["monday", "sunday", "saturday"],
               "library_sort": ["played", "achievement", "name", "progress", "playtime", "duration"],
               "library_order": ["desc", "asc"],
               "achievement_sort": ["default", "date", "name"],
               "achievement_order": ["desc", "asc"],
               "achievement_group": ["status", "none"],
               "library_active": ["show", "only", "hide"],
               "library_private": ["show", "only", "hide"],
               "library_no_achievements": ["show", "only", "hide"],
               "library_finished": ["show", "only", "hide"],
               "library_match": ["all", "any"],
               "library_tab": ["achievements", "games"],
               "hidden_descriptions": ["unlocked", "all", "none"],
               "library_check": ["1h", "3h", "6h", "12h", "24h", "manual"]}

# Settings older versions had, ignored (and dropped on the next save from
# the app) rather than refused as unknown.
RETIRED = {"notifications", "library_hidden", "auto_update",
           # Artwork on/off, briefly, before Banners and Gradient replaced it.
           "art"}


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
    if overrides.get("run_logs_kept", 1) < 1:
        found.append("'run_logs_kept' must be at least 1")
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


# The app's server writes settings.json from request threads (the Settings
# tab, Appearance, Library's choices, the Steam key): each write reads the
# file, changes it and writes it back under this lock, so two at once can't
# lose one another's changes.
WRITE_LOCK = threading.Lock()


def update_overrides(change):
    """Reads settings.json's own keys, has change(overrides) edit them (or
    return the ones to keep instead), and writes the result atomically, or
    removes the file when none are left, all under WRITE_LOCK. Returns
    what was written. Raises ValueError when settings.json isn't valid JSON,
    and whatever change raises, writing nothing then."""
    with WRITE_LOCK:
        overrides = read_overrides()
        kept = change(overrides)
        if kept is not None:
            overrides = kept
        if overrides:
            write_atomic(SETTINGS_PATH, json.dumps(overrides, indent=2) + "\n")
        else:
            SETTINGS_PATH.unlink(missing_ok=True)
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
