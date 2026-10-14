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
games. A check runs at the times of day library_check sets (a setting;
every 6 hours from midnight unless changed), in the background or when
the Library opens, and on Refresh.
The first check reads every
game, which can be hundreds of pages, so checks run in the background
(SYNC says how far along) and the saved unlocks show meanwhile. Without
internet, what's saved is shown.

Games marked Private in the Steam client are marked: Steam keeps that
list on the computer, so it's read from the Steam client's own files
when Steam is installed here (and, with a key, asked of the Web API).
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
# Games the player marked finished (done with, for good), from the
# Library: a list of appids.
FINISHED_PATH = JSONS_DIR / ".finished.json"
SHOWN = 50000      # unlocks returned (all saved, in practice)
# How often Steam is checked (settings' library_check), in hours, unless
# refreshed: at set times of day counted from midnight (every 6 hours:
# 12 AM, 6 AM, 12 PM, 6 PM); "manual": only on Refresh (and a first check).
CHECK_EVERY = {"1h": 1, "3h": 3, "6h": 6, "12h": 12, "24h": 24, "manual": None}
LIVE_FOR = 86400   # a game played this recently may still be unlocking…
LIVE_EVERY = 1800  # …so it's read again this often (or on refresh)
KEY_RE = re.compile(r"[0-9A-Fa-f]{32}")
# What a saved game was read with; one read with less (older STAR) is
# read again once. 2: counts unlocks Steam keeps no time for; 3: keeps
# every achievement (locked ones too), for a game's own page; 4: asks the
# Web API whether a game with nothing unlocked is Private (only those are
# read again: a v3 read with unlocks is still current).
READ_VERSION = 4

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


def _check_every():
    """Hours between checks with Steam, from settings.json; None: only on
    Refresh."""
    try:
        choice = settings_module.read_overrides().get("library_check")
    except ValueError:
        choice = None
    return CHECK_EVERY.get(choice, CHECK_EVERY[settings_module.DEFAULTS["library_check"]])


def _last_check_time(every, now=None):
    """The latest of the day's check times (every `every` hours from
    midnight, local time) at or before now."""
    t = time.localtime(now)
    return time.mktime((t.tm_year, t.tm_mon, t.tm_mday, t.tm_hour // every * every, 0, 0, 0, 0, -1))


def _due(store):
    """Never checked, or not since the latest of the day's check times."""
    every = _check_every()
    return not store["checked"] or (every is not None and store["checked"] < _last_check_time(every))


# After achievements change (by hand, or a run's unlock), Steam is checked
# again this long after, once it has them.
REFRESH_AFTER = 15
_soon = {"at": None, "seen": None}  # when that check is due; the runs' last progress


def refresh_soon(after=REFRESH_AFTER):
    """Has Steam checked again in `after` seconds (see watch)."""
    at = time.time() + after
    _soon["at"] = at if _soon["at"] is None else min(_soon["at"], at)


def watch():
    """Every few seconds: notices a run's progress saved (an unlock) and
    has Steam checked again soon after, and starts that check when due."""
    latest = max(_star_appids().values(), default=0)
    if _soon["seen"] is not None and latest > _soon["seen"]:
        refresh_soon()
    _soon["seen"] = latest
    if _soon["at"] is None or time.time() < _soon["at"]:
        return
    sid = steamid()
    if not sid:
        return
    with _lock:
        if SYNC["running"]:
            return  # still due; started once this one ends
        _soon["at"] = None
        SYNC.update(running=True, done=0, total=0, notice=None, error=None)
        threading.Thread(target=_sync, args=(sid, True), daemon=True).start()


def auto_check():
    """Starts a check in the background when one is due, the Library open
    or not (the server asks every few minutes)."""
    sid = steamid()
    if not sid:
        return
    with _lock:
        store = _load_store(sid)
        if not SYNC["running"] and store["games"] and _due(store):
            SYNC.update(running=True, done=0, total=0, notice=None, error=None)
            threading.Thread(target=_sync, args=(sid, False), daemon=True).start()


def _owned_games(key, sid):
    """Every game in the library: [{"appid", "name", "icon" (URL),
    "played": when it was last played (0: never), "playtime" (minutes),
    "stats": whether it has achievements}]."""
    url = "https://api.steampowered.com/IPlayerService/GetOwnedGames/v1/?" + urllib.parse.urlencode({
        "key": key, "steamid": sid, "include_appinfo": 1, "include_played_free_games": 1,
        # Without this, Steam leaves out games it hasn't "vetted" yet.
        "skip_unvetted_apps": 0})
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


def private_marks(sid):
    """The appids this account marked Private in the Steam client
    (PrivateApps_<account> in localconfig.vdf), from the client's files on
    this computer; empty when Steam isn't installed here."""
    account = str(int(sid) - 76561197960265728)
    for base in STEAM_DIRS:
        config = base / "userdata" / account / "config"
        if not config.is_dir():
            continue
        try:
            vdf = (config / "localconfig.vdf").read_text(encoding="utf-8", errors="replace")
            found = re.search(r'"PrivateApps_' + account + r'"\s+"(\[[^"]*\])"', vdf)
            if found:
                return {a for a in json.loads(found.group(1)) if isinstance(a, int)}
        except (OSError, ValueError):
            pass
        return set()
    return set()


def _star_appids():
    """The games in STAR, finished ones too: {appid: when its progress last
    changed}, so a game is read again only after it played."""
    appids = {}
    paths = [(JSONS_DIR / f"config_{name}.json", JSONS_DIR / f"progress_{name}.json") for name, _ in list_profiles()]
    paths += [(c, c.with_name(c.name.replace("config_", "progress_", 1))) for c in COMPLETED_DIR.glob("*/config_*.json")]
    for config, progress in paths:
        try:
            appid = json.loads(config.read_text()).get("appid")
        except (OSError, ValueError):
            continue
        if isinstance(appid, int):
            try:
                changed = progress.stat().st_mtime
            except OSError:
                changed = 0
            appids[appid] = max(appids.get(appid, 0), changed)
    return appids


# What Steam says when it really won't show a game's achievements; any
# other failure (busy, unreachable, an error page) is worth trying again.
HIDDEN = {"This player's Steam profile is private", "Steam shows no achievements for this player and game"}
FAILED = "failed"
PRIVATE = "private"


def _current(saved):
    """Whether a saved game was read with what this STAR reads."""
    return saved.get("v") == READ_VERSION or (saved.get("v") == 3 and bool(saved.get("unlocked")))


def _private(key, sid, appid):
    """Whether the game is marked Private in Steam: the Web API then says
    the (public) profile "is not public" for it alone. Steam's stats page
    can't tell: for a Private game it shows every achievement locked, or
    none. None when Steam can't be asked."""
    player = (_api(key, "ISteamUserStats/GetPlayerAchievements/v1/", steamid=sid, appid=appid) or {}).get("playerstats")
    if not player:
        return None
    return not player.get("success") and player.get("error") == "Profile is not public"


def _game_unlocks(sid, appid, key=None):
    """The game as Steam shows it: {"game", "total", "unlocked" (how many),
    "unlocks" (unlocked, with their times), "untimed" (unlocked, but Steam
    keeps no time for them), "locked"}; None when Steam won't show it
    (no achievements); PRIVATE when it's marked Private (known with a
    key); FAILED when the read failed (Steam busy or unreachable), to try
    again next check. With a key, it's read through the Web API, which is
    current (the public stats page is cached, for up to an hour after an
    unlock); the stats page is the fallback, and the way without one."""
    if key:
        got = _api_unlocks(key, sid, appid)
        if got is not FAILED:
            return got
    for attempt in range(2):
        try:
            stats = achievements._steam_stats("profiles", sid, appid)
            break
        except achievements.Problem as e:
            if e.title in HIDDEN:
                return PRIVATE if key and _private(key, sid, appid) else None
            if attempt == 0:
                time.sleep(3)
    else:
        return FAILED
    if key and stats["achievements"] and not any(a["unlocked"] for a in stats["achievements"]):
        private = _private(key, sid, appid)
        if private is None:
            return FAILED
        if private:
            return PRIVATE
    return _game(stats["game"], [
        (a["name"], a["description"], a["icon"] if a["unlocked"] else a.get("icon_locked") or a["icon"],
         a["unlocked"], a["unlock_time"]) for a in stats["achievements"]])


def _game(name, rows):
    """_game_unlocks' shape, from (name, description, icon, unlocked, time)
    rows."""
    item = lambda r: {"name": r[0], "description": r[1], "icon": r[2]}
    return {"game": name, "total": len(rows), "unlocked": sum(1 for r in rows if r[3]),
            "unlocks": [{**item(r), "time": r[4]} for r in rows if r[3] and r[4]],
            "untimed": [item(r) for r in rows if r[3] and not r[4]],
            "locked": [item(r) for r in rows if not r[3]]}


def _api(key, path, **query):
    url = f"https://api.steampowered.com/{path}?" + urllib.parse.urlencode({"key": key, **query})
    try:
        with urllib.request.urlopen(urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0 (STAR)"}), timeout=20) as r:
            return json.loads(r.read())
    except urllib.error.HTTPError as e:
        try:
            return json.loads(e.read())  # Steam says why, e.g. a profile that isn't public
        except ValueError:
            return None
    except (urllib.error.URLError, OSError, ValueError):
        return None


def _api_unlocks(key, sid, appid):
    """As _game_unlocks, from the Web API: the player's achievements, and
    the game's schema for their icons."""
    player = (_api(key, "ISteamUserStats/GetPlayerAchievements/v1/", steamid=sid, appid=appid, l="english") or {}).get("playerstats")
    if not player:
        return FAILED
    if not player.get("success"):
        # Not public (a Private game) or no achievements: Steam won't show them.
        if player.get("error") == "Profile is not public":
            return PRIVATE
        return None if player.get("error") else FAILED
    got = player.get("achievements") or []
    schema = (_api(key, "ISteamUserStats/GetSchemaForGame/v2/", appid=appid, l="english") or {}).get("game") or {}
    icons = {a.get("name"): (a.get("icon"), a.get("icongray")) for a in (schema.get("availableGameStats") or {}).get("achievements") or []}
    return _game(player.get("gameName") or schema.get("gameName") or "", [
        (a.get("name") or a.get("apiname") or "", a.get("description") or "",
         (icons.get(a.get("apiname")) or ("", ""))[0 if a.get("achieved") else 1] or "",
         bool(a.get("achieved")), a.get("unlocktime") or None) for a in got])


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
    recently played. What's saved is kept and compared, not downloaded
    again: a game is read when it isn't saved yet, when Steam says it was
    played since (with a key), when STAR played it since (its progress
    changed), or, played in the last day and so maybe still unlocking,
    every LIVE_EVERY or on refresh; on refresh, too, a Private game read
    over a day ago, in case it's public again."""
    now = time.time()
    games = store["games"]
    want = {}

    def live(played, saved):
        return played >= now - LIVE_FOR and (refresh or now - saved["read"] >= LIVE_EVERY)

    def unmarked(saved):  # a Private game may have been made public again
        return refresh and saved.get("private") and now - saved["read"] >= LIVE_FOR

    for g in owned or []:
        if not g["stats"] or not g["played"]:
            continue  # no achievements, or never played: nothing unlocked
        saved = games.get(str(g["appid"]))
        if saved is None or g["played"] != saved.get("played") or not _current(saved) or saved.get("stale") or live(g["played"], saved) or unmarked(saved):
            want[g["appid"]] = g["played"]
    owned_ids = {g["appid"] for g in owned or []}
    for appid, changed in star.items():
        saved = games.get(str(appid))
        if appid in want or (appid in owned_ids and saved is not None and _current(saved)):
            continue  # Steam's own last-played time decides, above
        if saved is None or not _current(saved) or saved.get("stale") or changed > saved["read"] or live(changed, saved):
            want[appid] = saved.get("played") if saved else None
    order = sorted(want, key=lambda appid: want[appid] or 0, reverse=True)
    return [a for a in order if a in star] + [a for a in order if a not in star], want


def finished_games():
    """The appids marked finished in the Library."""
    try:
        return {a for a in json.loads(FINISHED_PATH.read_text()) if isinstance(a, int)}
    except (OSError, ValueError, TypeError):
        return set()


def set_finished(appid, finished):
    """Marks a game finished, or not; saved in jsons/.finished.json."""
    try:
        appid = int(appid)
    except (TypeError, ValueError):
        raise Problem("No such game", "Pick a game from the list.")
    with _lock:
        games = finished_games()
        games.add(appid) if finished else games.discard(appid)
        JSONS_DIR.mkdir(parents=True, exist_ok=True)
        tmp = FINISHED_PATH.with_suffix(".tmp")
        tmp.write_text(json.dumps(sorted(games)) + "\n")
        tmp.replace(FINISHED_PATH)
    return {"appid": appid, "finished": appid in games}


def _games_list(store, key, private):
    """Every game, for the Library's Games: the library's (with a key) and
    those read, each with its achievement progress, most recently played
    first."""
    games = store["games"]
    owned = {g["appid"]: g for g in (store.get("owned") or [])} if key else {}
    finished = finished_games()
    out = []
    for appid in set(owned) | {int(a) for a in games}:
        o, saved = owned.get(appid, {}), games.get(str(appid), {})
        unlocks = saved.get("unlocks") or []
        out.append({
            "appid": appid, "name": saved.get("game") or o.get("name") or achievements.app_title(appid) or f"App {appid}",
            "icon": achievements.current_host(o.get("icon")) or achievements.app_icon(appid),
            "played": o.get("played") or saved.get("played") or 0, "playtime": o.get("playtime"),
            "stats": o.get("stats", True), "read": bool(saved) and "total" in saved,
            "counters": achievements.app_counters(appid) if o.get("stats", True) else 0,
            "finished": appid in finished,
            "unlocked": saved.get("unlocked", len(unlocks)), "total": saved.get("total"),
            "last_unlock": max((u["time"] for u in unlocks), default=None),
            "unreadable": bool(saved.get("unreadable")),
            "private": appid in private or bool(saved.get("private"))})
    out.sort(key=lambda g: (g["played"] or 0, g["last_unlock"] or 0), reverse=True)
    return out


def _result(store):
    games = store["games"]
    private = private_marks(store["steamid"])
    unlocks = []
    for appid, g in games.items():
        if not g.get("unlocks"):
            continue
        secret = achievements.app_hidden(int(appid)) or {}  # hidden achievements' descriptions
        unlocks += [{**u, "icon": achievements.current_host(u.get("icon")), "appid": int(appid),
                     "game": g.get("game") or "",
                     "private": int(appid) in private or bool(g.get("private")),
                     **({"secret": True, "description": u.get("description") or secret[u["name"]]}
                        if u.get("name") in secret else {})}
                    for u in g["unlocks"]]
    unlocks.sort(key=lambda u: u["time"], reverse=True)
    key = bool(_key())
    return {"unlocks": unlocks[:SHOWN], "games_list": _games_list(store, key, private),
            "has_key": key, "library": store.get("library") if key else None,
            "games": len(games),
            "fetched_at": int(store["checked"]),
            "offline": SYNC["notice"] or (f"{SYNC['error'][0]}: showing what was saved." if SYNC["error"] else None),
            "syncing": {"done": SYNC["done"], "total": SYNC["total"]} if SYNC["running"] else None}


def change_achievements(appid, unlock, lock):
    """Unlocks (in order) and locks a game's achievements on Steam (see
    achievements.change), then updates what's saved for it, the times
    being now; it's read from Steam again on the next check."""
    try:
        appid = int(appid)
    except (TypeError, ValueError):
        raise Problem("No such game", "Pick a game from the list.")
    unlock = [str(n) for n in unlock or [] if n]
    lock = [str(n) for n in lock or [] if n]
    if not unlock and not lock:
        raise Problem("Nothing to change", "Tick or untick achievements first.")
    try:
        done = achievements.change(appid, unlock, lock)
    except achievements.Problem as e:
        raise Problem(e.title, str(e))
    sid = steamid()
    if sid:
        with _lock:
            store = _load_store(sid)
            saved = store["games"].get(str(appid))
            if saved and "total" in saved:
                now = int(time.time())
                rows = {a["name"]: a for kind in ("unlocks", "untimed", "locked") for a in saved.get(kind) or []}
                for i, name in enumerate(done["unlocked"]):
                    if name in rows:
                        rows[name] = {**rows[name], "time": now + i, "_state": "unlocks"}
                for name in done["locked"]:
                    if name in rows:
                        rows[name] = {**rows[name], "_state": "locked"}
                for kind in ("unlocks", "untimed", "locked"):
                    for a in saved.get(kind) or []:
                        rows[a["name"]].setdefault("_state", kind)
                item = lambda a: {k: v for k, v in a.items() if k not in ("_state", "time")}
                saved["unlocks"] = [{**item(a), "time": a["time"]} for a in rows.values() if a["_state"] == "unlocks"]
                saved["untimed"] = [item(a) for a in rows.values() if a["_state"] == "untimed"]
                saved["locked"] = [item(a) for a in rows.values() if a["_state"] == "locked"]
                saved["unlocked"] = len(saved["unlocks"]) + len(saved["untimed"])
                saved["stale"] = True  # read again from Steam on the next check
                _save_store(store)
    refresh_soon()
    return {**done, "game": game_page(appid)}


def game_page(appid):
    """One game's own page, from what's saved: its achievements (unlocked
    newest first, then those without a time, then locked), its progress,
    and the STAR schedule for it if there is one."""
    sid = steamid()
    try:
        appid = int(appid)
    except (TypeError, ValueError):
        raise Problem("No such game", "Pick a game from the list.")
    store = _load_store(sid) if sid else {"games": {}, "steamid": sid}
    saved = store["games"].get(str(appid), {})
    owned = next((g for g in store.get("owned") or [] if g["appid"] == appid), {})
    private = private_marks(sid) if sid else set()
    star = next((name for name, a in list_profiles() if a == appid), None)
    secret = achievements.app_hidden(appid) or {}

    def icon(u):  # and a hidden achievement's description, marked secret
        u = {**u, "icon": achievements.current_host(u.get("icon"))}
        if u["name"] in secret:
            u.update(secret=True, description=u.get("description") or secret[u["name"]])
        return u
    return {
        "appid": appid, "steamid": sid,
        "name": saved.get("game") or owned.get("name") or achievements.app_title(appid) or f"App {appid}",
        "icon": achievements.current_host(owned.get("icon")) or achievements.app_icon(appid),
        "played": owned.get("played") or saved.get("played") or 0, "playtime": owned.get("playtime"),
        "total": saved.get("total"), "unlocked": saved.get("unlocked", len(saved.get("unlocks") or [])),
        "read": "total" in saved, "full": _current(saved), "unreadable": bool(saved.get("unreadable")),
        "private": appid in private or bool(saved.get("private")), "star": star,
        "counters": achievements.app_counters(appid), "stats": owned.get("stats", True),
        "finished": appid in finished_games(), "order": achievements.app_order(appid),
        "unlocks": sorted((icon(u) for u in saved.get("unlocks") or []), key=lambda u: u["time"], reverse=True),
        "untimed": [icon(u) for u in saved.get("untimed") or []],
        "locked": [icon(u) for u in saved.get("locked") or []],
    }


def recent(refresh=False):
    """The saved unlocks, starting a check with Steam in the background
    when one is due (or on refresh): {"unlocks": [...] newest first,
    "games_list": every game with its progress (see _games_list),
    "has_key", "library": counts of the library's games (with a key),
    "games": how many are saved, "fetched_at": when Steam was last
    asked, "offline": a message when it couldn't be, "syncing": how far a
    running check is}."""
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
        if not SYNC["running"] and (refresh or _due(store)):
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
            for done, (appid, got) in enumerate(zip(appids, pool.map(lambda a: _game_unlocks(sid, a, key), appids)), 1):
                SYNC["done"] = done
                if got == FAILED:
                    failed += 1
                    continue  # keeps what was saved; read again next check
                saved = store["games"].setdefault(str(appid), {"game": "", "unlocks": []})
                saved.update(read=time.time(), played=played[appid], unreadable=got in (None, PRIVATE),
                             private=got == PRIVATE, v=READ_VERSION, stale=False)
                if isinstance(got, dict):
                    saved.update(got)
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
