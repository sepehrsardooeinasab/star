"""Recent unlocks: the achievements this Steam account unlocked lately,
newest first, with their exact times, read from Steam.

Each game's unlocks come from its public stats page (as in achievements),
so the account's game details need to be public. Which games to read:

- the games in STAR, and finished ones in completed/;
- with a Steam Web API key (steam_api_key in settings.json), also every
  game in the library played in the last RECENT_DAYS days, from Steam's
  GetOwnedGames. Without one, Steam won't list a library.

The account is the one ArchiSteamFarm signs in to: its Steam ID is saved
the first time it's seen (STEAMID_PATH), so this works with ASF closed.

Like SteamHunters and co., what's read is kept (STORE_PATH: each game's
name, when it was last played and its unlocks), and a check reads again
only what changed: library games played since they were last read (one
GetOwnedGames call says which), games played in the last day, and STAR's
games once the saved copy is CACHE_FOR old. Without internet, what's
saved is shown.
"""
import json
import re
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from concurrent.futures import ThreadPoolExecutor

from unlocker import achievements, asf_setup
from unlocker import settings as settings_module
from unlocker.api import asf_running
from unlocker.state import COMPLETED_DIR, JSONS_DIR, list_profiles

STEAMID_PATH = JSONS_DIR / ".steamid"
STORE_PATH = JSONS_DIR / ".unlocks.json"
RECENT_DAYS = 30   # library games first read when played this recently
MAX_GAMES = 40     # at most this many library games read in one check
SHOWN = 2000       # unlocks returned (all saved, in practice)
CACHE_FOR = 300    # seconds between checks with Steam, unless refreshed
LIVE_FOR = 86400   # a game played this recently may still be unlocking
KEY_RE = re.compile(r"[0-9A-Fa-f]{32}")

_lock = threading.Lock()


class Problem(Exception):
    """Shown as is: a short title and what to do about it."""

    def __init__(self, title, message):
        super().__init__(message)
        self.title = title


def remember_steamid(steamid):
    try:
        if steamid and (not STEAMID_PATH.exists() or STEAMID_PATH.read_text().strip() != steamid):
            JSONS_DIR.mkdir(parents=True, exist_ok=True)
            STEAMID_PATH.write_text(steamid + "\n")
    except OSError:
        pass


def steamid():
    """The account's Steam ID: ArchiSteamFarm's, if it's running and
    signed in, else the one saved last time; None when never seen."""
    if asf_running():
        try:
            bot = (asf_setup._ipc("GET", f"Bot/{asf_setup.BOT_NAME}").get("Result") or {}).get(asf_setup.BOT_NAME) or {}
            found = str(bot.get("SteamID") or "")
            if found and found != "0":
                remember_steamid(found)
                return found
        except (urllib.error.URLError, OSError, ValueError):
            pass
    try:
        saved = STEAMID_PATH.read_text().strip()
    except OSError:
        return None
    return saved if saved.isdigit() else None


def _key():
    try:
        key = settings_module.read_overrides().get("steam_api_key")
    except ValueError:
        return None
    return key if isinstance(key, str) and key else None


def _owned_games(key, sid):
    """Library games with achievements that have been played, most
    recent first: [(appid, when last played)]."""
    url = "https://api.steampowered.com/IPlayerService/GetOwnedGames/v1/?" + urllib.parse.urlencode({
        "key": key, "steamid": sid, "include_appinfo": 1, "include_played_free_games": 1})
    try:
        with urllib.request.urlopen(urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0 (STAR)"}), timeout=20) as r:
            data = json.loads(r.read())
    except urllib.error.HTTPError as e:
        if e.code in (401, 403):
            raise Problem("Steam didn't accept the Web API key", "Check the key, or remove it to list just the games in STAR.")
        raise Problem("Couldn't reach Steam", "Check your connection and try again.")
    except (urllib.error.URLError, OSError, ValueError):
        raise Problem("Couldn't reach Steam", "Check your connection and try again.")
    games = (data.get("response") or {}).get("games")
    if games is None:
        raise Problem("Steam didn't list your games",
                      "Your Steam profile's game details need to be public (Steam: Edit Profile → Privacy Settings).")
    played = [g for g in games if g.get("has_community_visible_stats") and g.get("rtime_last_played")]
    played.sort(key=lambda g: g["rtime_last_played"], reverse=True)
    return [(g["appid"], g["rtime_last_played"]) for g in played]


def _star_appids():
    """The appids of the games in STAR, finished ones too."""
    appids = {appid for _, appid in list_profiles() if isinstance(appid, int)}
    for path in COMPLETED_DIR.glob("*/config_*.json"):
        try:
            appid = json.loads(path.read_text()).get("appid")
        except (OSError, ValueError):
            continue
        if isinstance(appid, int):
            appids.add(appid)
    return appids


# What Steam says when it really won't show a game's achievements; any
# other failure (busy, unreachable, an error page) is worth trying again.
HIDDEN = {"This player's Steam profile is private", "Steam shows no achievements for this player and game"}
FAILED = "failed"


def _game_unlocks(sid, appid):
    """(game name, its unlocked achievements with their times); None when
    Steam won't show them (private, no achievements); FAILED when the read
    failed twice (Steam busy or unreachable), to try again next check."""
    for attempt in range(2):
        try:
            stats = achievements._steam_stats("profiles", sid, appid)
            break
        except achievements.Problem as e:
            if e.title in HIDDEN:
                return None
            if attempt == 0:
                time.sleep(3)
    else:
        return FAILED
    return stats["game"], [{"name": a["name"], "description": a["description"], "icon": a["icon"], "time": a["unlock_time"]}
                           for a in stats["achievements"] if a["unlocked"] and a["unlock_time"]]


def _load_store(sid):
    """What was read before, for this account: {"steamid", "checked": when
    Steam was last asked, "games": {appid: {"game", "played", "read",
    "unlocks", "unreadable"}}}."""
    try:
        store = json.loads(STORE_PATH.read_text())
        if store.get("steamid") == sid and isinstance(store.get("games"), dict):
            return store
    except (OSError, ValueError, AttributeError):
        pass
    return {"steamid": sid, "checked": 0, "games": {}}


def _save_store(store):
    JSONS_DIR.mkdir(parents=True, exist_ok=True)
    tmp = STORE_PATH.with_suffix(".tmp")
    tmp.write_text(json.dumps(store, separators=(",", ":")))
    tmp.replace(STORE_PATH)


def _to_read(store, star, owned, refresh):
    """The appids worth reading again, most recently played first."""
    now = time.time()
    games = store["games"]
    want = {}
    for appid, played in owned or []:
        saved = games.get(str(appid))
        if saved is None:
            if played >= now - RECENT_DAYS * 86400:
                want[appid] = played
        elif played != saved.get("played") or (played >= now - LIVE_FOR and (refresh or now - saved["read"] >= CACHE_FOR)):
            want[appid] = played
    for appid in star:
        saved = games.get(str(appid))
        if appid not in want and (saved is None or refresh or now - saved["read"] >= CACHE_FOR):
            want[appid] = saved.get("played") if saved else None
    order = sorted(want, key=lambda appid: want[appid] or 0, reverse=True)
    star_first = [a for a in order if a in star] + [a for a in order if a not in star]
    return star_first[:MAX_GAMES + len(star)], want


def _result(store, offline):
    games = store["games"]
    unlocks = [{**u, "appid": int(appid), "game": g.get("game") or ""}
               for appid, g in games.items() for u in g.get("unlocks") or []]
    unlocks.sort(key=lambda u: u["time"], reverse=True)
    return {"unlocks": unlocks[:SHOWN], "library": bool(_key()), "has_key": bool(_key()),
            "games": len(games), "unreadable": sum(1 for g in games.values() if g.get("unreadable")),
            "unreadable_games": sorted(g.get("game") or achievements.app_title(int(appid)) or f"App {appid}"
                                       for appid, g in games.items() if g.get("unreadable")),
            "fetched_at": int(store["checked"]), "offline": offline}


def recent(refresh=False):
    """The saved unlocks, after reading again what changed: {"unlocks":
    [...] newest first, "library": whether the library is checked too,
    "has_key", "games": how many are saved, "unreadable": how many Steam
    didn't show, "fetched_at": when Steam was last asked, "offline":
    a message when it couldn't be (what's saved is shown)}."""
    sid = steamid()
    if not sid:
        raise Problem("STAR doesn't know your Steam account yet",
                      "It learns it from ArchiSteamFarm while that runs: run a game, or check a game's "
                      "achievement numbers in Schedule, then try again.")
    with _lock:
        store = _load_store(sid)
        if not refresh and time.time() - store["checked"] < CACHE_FOR:
            return _result(store, None)
        key = _key()
        owned = None
        if key:
            try:
                owned = _owned_games(key, sid)
            except Problem as e:
                if not store["games"] or e.title != "Couldn't reach Steam":
                    raise
                return _result(store, "Couldn't reach Steam: showing what was saved.")
        star = _star_appids()
        appids, played = _to_read(store, star, owned, refresh)
        # A few at a time: Steam turns away many requests at once.
        with ThreadPoolExecutor(max_workers=3) as pool:
            found = list(pool.map(lambda appid: _game_unlocks(sid, appid), appids))
        if appids and all(f == FAILED for f in found) and store["games"] and not _steam_reachable():
            return _result(store, "Couldn't reach Steam: showing what was saved.")
        now = time.time()
        for appid, got in zip(appids, found):
            if got == FAILED:
                continue  # keeps what was saved; read again next check
            saved = store["games"].setdefault(str(appid), {"game": "", "unlocks": []})
            saved.update(read=now, played=played[appid], unreadable=got is None)
            if got:
                saved["game"], saved["unlocks"] = got
        store["checked"] = now
        _save_store(store)
        return _result(store, None)


def _steam_reachable():
    try:
        urllib.request.urlopen(urllib.request.Request("https://steamcommunity.com/", method="HEAD",
                                                      headers={"User-Agent": "Mozilla/5.0 (STAR)"}), timeout=10).close()
        return True
    except (urllib.error.URLError, OSError):
        return False


def save_key(key):
    """Checks a Steam Web API key against Steam, then saves it as
    steam_api_key in settings.json; an empty one removes it."""
    key = (key or "").strip()
    overrides = settings_module.read_overrides()
    if key:
        if not KEY_RE.fullmatch(key):
            raise Problem("That isn't a Steam Web API key", "A key is 32 letters and numbers, from steamcommunity.com/dev/apikey.")
        sid = steamid()
        if sid:
            _owned_games(key, sid)  # raises when Steam refuses it
        overrides["steam_api_key"] = key
    else:
        overrides.pop("steam_api_key", None)
    if overrides:
        settings_module.SETTINGS_PATH.write_text(json.dumps(overrides, indent=2) + "\n")
    else:
        settings_module.SETTINGS_PATH.unlink(missing_ok=True)
    # Check again on the next look, with the library now in or out.
    try:
        store = json.loads(STORE_PATH.read_text())
        store["checked"] = 0
        _save_store(store)
    except (OSError, ValueError, TypeError):
        pass
    return {"has_key": bool(key)}
