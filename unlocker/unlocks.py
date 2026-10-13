"""The app's Library: this Steam account's games (with their achievement
progress) and the achievements it unlocked, newest first, with their
exact times, read from Steam.

Each game's unlocks come from its public stats page (as in achievements),
so the account's game details need to be public. Which games to read:

- the games in STAR, and finished ones in completed/;
- with a Steam Web API key (steam_api_key in settings.json), also every
  game in the library that has achievements and has been played, from
  Steam's GetOwnedGames. Without one, Steam won't list a library.

The account is the one ArchiSteamFarm signs in to: its Steam ID is saved
the first time it's seen (STEAMID_PATH), so this works with ASF closed.

Like SteamHunters and co., what's read is kept (STORE_PATH: each game's
name, when it was last played and its unlocks), and a check reads again
only what changed: library games played since they were last read (one
GetOwnedGames call says which), games played in the last day, and STAR's
games once the saved copy is CACHE_FOR old. The first check reads every
game, which can be hundreds of pages, so checks run in the background
(SYNC says how far along) and the saved unlocks show meanwhile. Without
internet, what's saved is shown.

Games hidden in the Steam client (its "hidden" collection) are marked:
Steam keeps that list on the computer, not online, so it's read from the
Steam client's own files when Steam is installed here.
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
from pathlib import Path

from unlocker.state import COMPLETED_DIR, JSONS_DIR, list_profiles

STEAMID_PATH = JSONS_DIR / ".steamid"
STORE_PATH = JSONS_DIR / ".unlocks.json"
SHOWN = 50000      # unlocks returned (all saved, in practice)
CACHE_FOR = 300    # seconds between checks with Steam, unless refreshed
LIVE_FOR = 86400   # a game played this recently may still be unlocking
KEY_RE = re.compile(r"[0-9A-Fa-f]{32}")

_lock = threading.Lock()
# The check in the background: running, games read so far of how many,
# and what to say when it couldn't be done (notice) or nothing's saved
# to show instead (error: title, message).
SYNC = {"running": False, "done": 0, "total": 0, "notice": None, "error": None}


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
    """Every game in the library: [{"appid", "name", "icon" (URL),
    "played": when it was last played (0: never), "playtime" (minutes),
    "stats": whether it has achievements}]."""
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
    return [{"appid": g["appid"], "name": g.get("name") or "",
             "icon": (achievements.ICON_URL.format(appid=g["appid"], icon=g["img_icon_url"])
                      if re.fullmatch(r"[0-9a-f]{40}", str(g.get("img_icon_url") or "")) else None),
             "played": g.get("rtime_last_played") or 0, "playtime": g.get("playtime_forever") or 0,
             "stats": bool(g.get("has_community_visible_stats"))} for g in games if isinstance(g.get("appid"), int)]


STEAM_DIRS = [Path.home() / "Library/Application Support/Steam", Path.home() / ".steam/steam",
              Path.home() / ".local/share/Steam", Path.home() / ".var/app/com.valvesoftware.Steam/.local/share/Steam"]


def hidden_games(sid):
    """The appids hidden in this account's Steam client (its "hidden"
    collection), from the client's files on this computer; empty when
    Steam isn't installed here."""
    account = str(int(sid) - 76561197960265728)
    for base in STEAM_DIRS:
        path = base / "userdata" / account / "config" / "cloudstorage" / "cloud-storage-namespace-1.json"
        try:
            entries = json.loads(path.read_text())
        except (OSError, ValueError):
            continue
        for entry in entries if isinstance(entries, list) else []:
            if isinstance(entry, list) and len(entry) == 2 and entry[0] == "user-collections.hidden":
                try:
                    value = json.loads(entry[1].get("value") or "{}")
                except (ValueError, AttributeError):
                    return set()
                return {a for a in value.get("added") or [] if isinstance(a, int)}
        return set()
    return set()


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
    return stats["game"], len(stats["achievements"]), [
        {"name": a["name"], "description": a["description"], "icon": a["icon"], "time": a["unlock_time"]}
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
    """The appids worth reading (again), STAR's first, then the most
    recently played: library games not read yet or played since, games
    played in the last day, and STAR's when the saved copy is old."""
    now = time.time()
    games = store["games"]
    want = {}
    for g in owned or []:
        if not g["stats"] or not g["played"]:
            continue  # no achievements, or never played: nothing unlocked
        saved = games.get(str(g["appid"]))
        if (saved is None or g["played"] != saved.get("played") or "total" not in saved
                or (g["played"] >= now - LIVE_FOR and (refresh or now - saved["read"] >= CACHE_FOR))):
            want[g["appid"]] = g["played"]
    for appid in star:
        saved = games.get(str(appid))
        if appid not in want and (saved is None or refresh or "total" not in saved or now - saved["read"] >= CACHE_FOR):
            want[appid] = saved.get("played") if saved else None
    order = sorted(want, key=lambda appid: want[appid] or 0, reverse=True)
    return [a for a in order if a in star] + [a for a in order if a not in star], want


def _games_list(store, key, hidden):
    """Every game, for the Library's Games: the library's (with a key) and
    those read, each with its achievement progress, most recently played
    first."""
    games = store["games"]
    owned = {g["appid"]: g for g in (store.get("owned") or [])} if key else {}
    out = []
    for appid in set(owned) | {int(a) for a in games}:
        o, saved = owned.get(appid, {}), games.get(str(appid), {})
        unlocks = saved.get("unlocks") or []
        out.append({
            "appid": appid, "name": saved.get("game") or o.get("name") or achievements.app_title(appid) or f"App {appid}",
            "icon": o.get("icon") or achievements.app_icon(appid),
            "played": o.get("played") or saved.get("played") or 0, "playtime": o.get("playtime"),
            "stats": o.get("stats", True), "read": bool(saved) and "total" in saved,
            "unlocked": len(unlocks), "total": saved.get("total"),
            "last_unlock": max((u["time"] for u in unlocks), default=None),
            "unreadable": bool(saved.get("unreadable")), "hidden": appid in hidden})
    out.sort(key=lambda g: (g["played"] or 0, g["last_unlock"] or 0), reverse=True)
    return out


def _result(store):
    games = store["games"]
    hidden = hidden_games(store["steamid"])
    unlocks = [{**u, "appid": int(appid), "game": g.get("game") or "", "hidden": int(appid) in hidden}
               for appid, g in games.items() for u in g.get("unlocks") or []]
    unlocks.sort(key=lambda u: u["time"], reverse=True)
    key = bool(_key())
    return {"unlocks": unlocks[:SHOWN], "games_list": _games_list(store, key, hidden),
            "has_key": key, "library": store.get("library") if key else None,
            "games": len(games), "unreadable": sum(1 for g in games.values() if g.get("unreadable")),
            "unreadable_games": sorted(g.get("game") or achievements.app_title(int(appid)) or f"App {appid}"
                                       for appid, g in games.items() if g.get("unreadable")),
            "fetched_at": int(store["checked"]),
            "offline": SYNC["notice"] or (f"{SYNC['error'][0]}: showing what was saved." if SYNC["error"] else None),
            "syncing": {"done": SYNC["done"], "total": SYNC["total"]} if SYNC["running"] else None}


def recent(refresh=False):
    """The saved unlocks, starting a check with Steam in the background
    when one is due (or on refresh): {"unlocks": [...] newest first,
    "has_key", "library": counts of the library's games (with a key),
    "games": how many are saved, "unreadable": how many Steam doesn't
    show, "fetched_at": when Steam was last asked, "offline": a message
    when it couldn't be, "syncing": how far a running check is}."""
    sid = steamid()
    if not sid:
        raise Problem("STAR doesn't know your Steam account yet",
                      "It learns it from ArchiSteamFarm while that runs: run a game, or check a game's "
                      "achievement numbers in Schedule, then try again.")
    with _lock:
        store = _load_store(sid)
        if SYNC["error"] and not SYNC["running"] and not store["games"]:
            title, message = SYNC["error"]
            SYNC["error"] = None  # asked again on the next look
            raise Problem(title, message)
        if not SYNC["running"] and (refresh or time.time() - store["checked"] >= CACHE_FOR):
            SYNC.update(running=True, done=0, total=0, notice=None, error=None)
            threading.Thread(target=_sync, args=(sid, refresh), daemon=True).start()
        return _result(store)


def _sync(sid, refresh):
    """Reads from Steam what changed (see the top), saving as it goes so
    the app shows the unlocks while the rest is read."""
    try:
        store = _load_store(sid)
        key = _key()
        owned = None
        if key:
            try:
                owned = _owned_games(key, sid)
            except Problem as e:
                if e.title == "Couldn't reach Steam" and store["games"]:
                    SYNC["notice"] = "Couldn't reach Steam: showing what was saved."
                else:
                    SYNC["error"] = (e.title, str(e))
                return
            with_stats = sum(1 for g in owned if g["stats"])
            store["library"] = {"games": len(owned), "with_achievements": with_stats,
                                "without_achievements": len(owned) - with_stats}
            store["owned"] = owned
        appids, played = _to_read(store, _star_appids(), owned, refresh)
        SYNC["total"] = len(appids)
        failed = 0
        # A few at a time: Steam turns away many requests at once.
        with ThreadPoolExecutor(max_workers=3) as pool:
            for done, (appid, got) in enumerate(zip(appids, pool.map(lambda a: _game_unlocks(sid, a), appids)), 1):
                SYNC["done"] = done
                if got == FAILED:
                    failed += 1
                    continue  # keeps what was saved; read again next check
                saved = store["games"].setdefault(str(appid), {"game": "", "unlocks": []})
                saved.update(read=time.time(), played=played[appid], unreadable=got is None)
                if got:
                    saved["game"], saved["total"], saved["unlocks"] = got
                if done % 10 == 0:
                    _save_store(store)
        if appids and failed == len(appids) and store["games"] and not _steam_reachable():
            SYNC["notice"] = "Couldn't reach Steam: showing what was saved."
        store["checked"] = time.time()
        _save_store(store)
    except Exception as e:  # never leave the check marked running
        SYNC["error"] = ("Couldn't read your unlocks", str(e))
    finally:
        SYNC["running"] = False


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
