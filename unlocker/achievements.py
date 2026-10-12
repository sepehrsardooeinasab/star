"""Achievement numbers for the schedule builder.

aset unlocks achievements by their number in the plugin's list (alist),
which follows the game's own order. A SteamHunters paste is only in that
order when it's sorted by default, so instead the builder matches what it
was given to the numbers alist reports, by name.

alist prints only number, state and name, and some games reuse a name
(Bongo Cat has four "Item Collector"s). Steam's public stats page for the
bot's own account has each achievement's description and API name, listed
unlocked first and then locked, each part in the game's order. Walking
alist and taking the next unlocked or next locked entry from Steam gives
every number its description and API name, so even reused names can be
told apart. Every step is checked (same counts, same name at each number);
anything that doesn't line up is reported instead of guessed.
"""
import json
import re
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
import xml.etree.ElementTree as ET

from unlocker import asf_setup
from unlocker.api import asf_running, ensure_asf_running, send_command
from unlocker.state import JSONS_DIR, SESSION_LOCK, lock_info

# A player's achievements for a game, from a SteamHunters or Steam link.
LINK_RES = [
    re.compile(r"steamhunters\.com/(id|profiles)/([^/?#]+)/apps/(\d+)", re.I),
    re.compile(r"steamcommunity\.com/(id|profiles)/([^/?#]+)/stats/([^/?#]+)", re.I),
]
ALIST_ROW = re.compile(r"\s*(\d+)\s*\[(✅|❌)\]\s*(⚠️\s*)?(.*)$")
CACHE_FOR = 300  # seconds a game's numbers are reused

_lock = threading.Lock()
_cache = {}


class Problem(Exception):
    """Something the person can act on: a short title saying what happened,
    and what to do about it, both shown as is."""

    def __init__(self, title, message):
        super().__init__(message)
        self.title = title


# For a player Steam won't show: SteamHunters keeps what it saw before.
COPY_INSTEAD = ("SteamHunters may still show their achievements from before: open the player's page there, "
                "select it all (⌘A / Ctrl+A), copy it and paste the text here instead.")


def _clean(text):
    return " ".join((text or "").split())


def _steam_stats(kind, who, app):
    """A player's achievements for a game from Steam's public stats page:
    {"appid", "game", "player", "steamid", "achievements": [...]}, in
    Steam's order (unlocked first, then locked)."""
    query = "?xml=1&l=english"
    url = f"https://steamcommunity.com/{kind}/{who}/stats/{app}/{query}"
    try:
        req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0 (STAR)"})
        with urllib.request.urlopen(req, timeout=20) as r:
            final, body = r.geturl(), r.read()
        # Some games' stats move to their short name (stats/4000 to
        # stats/GarrysMod), and the redirect drops the query: ask again there.
        if "xml=1" not in final:
            req = urllib.request.Request(final.split("?")[0].rstrip("/") + "/" + query, headers=req.headers)
            with urllib.request.urlopen(req, timeout=20) as r:
                body = r.read()
        root = ET.fromstring(body)
    except (urllib.error.URLError, OSError, ET.ParseError):
        raise Problem("Couldn't reach Steam", "Check your connection and try again.")
    error = root.findtext("error")
    if error:
        if "not be found" in error:
            raise Problem("Steam couldn't find this player", "Check the link: the player's name or ID in it may be wrong.")
        raise Problem("Steam couldn't show this player", f"Steam says: {_clean(error)}")
    if _clean(root.findtext("privacyState")) == "private":
        raise Problem("This player's Steam profile is private",
                      "Steam doesn't share a private profile's achievements, so the link can't be read. " + COPY_INSTEAD)
    achievements = []
    for a in root.iter("achievement"):
        stamp = a.findtext("unlockTimestamp")
        achievements.append({
            "name": _clean(a.findtext("name")),
            "description": _clean(a.findtext("description")),
            "apiname": _clean(a.findtext("apiname")),
            "unlocked": a.get("closed") == "1",
            "unlock_time": int(stamp) if stamp and stamp.isdigit() else None,
        })
    if not achievements:
        raise Problem("Steam shows no achievements for this player and game",
                      "Their game details may be private, or they haven't played it. " + COPY_INSTEAD)
    link = root.findtext("game/gameLink") or ""
    appid = re.search(r"/app/(\d+)", link)
    return {
        "appid": int(appid[1]) if appid else None,
        "game": _clean(root.findtext("game/gameName")),
        "player": _clean(root.findtext("player/customURL")) or _clean(root.findtext("player/steamID64")),
        "steamid": _clean(root.findtext("player/steamID64")),
        "achievements": achievements,
    }


def from_link(url):
    """The unlocked achievements of the player and game a SteamHunters or
    Steam link points at, with exact unlock times (seconds)."""
    for pattern in LINK_RES:
        m = pattern.search(url or "")
        if m:
            stats = _steam_stats(m[1].lower(), m[2], m[3])
            break
    else:
        raise Problem("That isn't a link to a player's achievements", "Use a SteamHunters link "
                      "(steamhunters.com/id/<player>/apps/<appid>/achievements) or a Steam one "
                      "(steamcommunity.com/id/<player>/stats/<appid>/achievements).")
    unlocked = [a for a in stats["achievements"] if a["unlocked"] and a["unlock_time"]]
    if not unlocked:
        raise Problem("Nothing to copy", "This player hasn't unlocked any achievements in this game.")
    return {
        "appid": stats["appid"], "game": stats["game"], "player": stats["player"],
        "total": len(stats["achievements"]),
        "achievements": [{k: a[k] for k in ("name", "description", "apiname", "unlock_time")} for a in unlocked],
    }


def _alist(appid):
    """alist's rows. Right after ArchiSteamFarm signs in, the plugin can
    answer without a list (it couldn't retrieve the stats yet), so an
    empty answer is asked again a few times before it counts."""
    for attempt in range(4):
        result, _ = send_command(f"alist {appid}")
        if result is None:
            raise Problem("Couldn't check the achievement numbers",
                          "ArchiSteamFarm didn't answer. Check Settings, then try again.")
        rows = []
        for line in result.splitlines():
            m = ALIST_ROW.match(line)
            if m:
                rows.append({"number": int(m[1]), "unlocked": m[2] == "✅",
                             "restricted": bool(m[3]), "name": _clean(m[4])})
        if rows:
            return rows
        time.sleep(3)
    raise Problem("Couldn't check the achievement numbers",
                  f"ArchiSteamFarm couldn't list the achievements of app {appid}. "
                  "Check the App ID; the game needs to be on your Steam account.")


def _bot_steamid():
    try:
        bot = (asf_setup._ipc("GET", f"Bot/{asf_setup.BOT_NAME}").get("Result") or {}).get(asf_setup.BOT_NAME) or {}
    except (urllib.error.URLError, OSError, ValueError):
        bot = {}
    steamid = bot.get("SteamID")
    if not steamid:
        raise Problem("Couldn't check the achievement numbers", "ArchiSteamFarm isn't signed in to Steam yet. Check Settings, then try again.")
    return str(steamid)


def _merge(rows, mine):
    """Every alist number with its description and API name (see the top)."""
    unlocked = [a for a in mine if a["unlocked"]]
    locked = [a for a in mine if not a["unlocked"]]
    lag = ("ArchiSteamFarm and Steam don't agree on this game's achievements yet: Steam's page can "
           "lag a few minutes behind an unlock. Try again in a few minutes.")
    if len(rows) != len(mine) or sum(r["unlocked"] for r in rows) != len(unlocked):
        raise Problem("Couldn't check the achievement numbers", lag)
    merged = []
    for row in rows:
        steam = (unlocked if row["unlocked"] else locked).pop(0)
        if steam["name"].casefold() != row["name"].casefold():
            raise Problem("Couldn't check the achievement numbers", lag + " (Or ArchiSteamFarm shows names in another language: it's set to "
                          "English after the next update of ArchiSteamFarm.)")
        merged.append({**row, "description": steam["description"], "apiname": steam["apiname"]})
    return merged


def numbers(appid):
    """{"appid", "achievements": [{number, name, description, apiname,
    unlocked, restricted}]} for a game, in alist's (aset's) numbering.
    Starts ArchiSteamFarm if needed, and stops it again unless a session
    started meanwhile."""
    with _lock:
        cached = _cache.get(appid)
        if cached and time.monotonic() - cached[0] < CACHE_FOR:
            return cached[1]
        started = not asf_running()
        try:
            ensure_asf_running()
            rows = _alist(appid)
            mine = _steam_stats("profiles", _bot_steamid(), appid)["achievements"]
            result = {"appid": appid, "achievements": _merge(rows, mine)}
        finally:
            if started and not lock_info(SESSION_LOCK):
                asf_setup._stop_idle_asf()  # waits until it's gone
        _cache[appid] = (time.monotonic(), result)
        return result


def find_appid(name):
    """The App ID of the one Steam game named exactly name (ignoring case
    and ®/™), from the store's search; None when there's no such game or
    more than one, rather than a guess."""
    clean = lambda text: re.sub(r"[®™©]", "", text or "").strip().casefold()
    url = "https://store.steampowered.com/api/storesearch/?" + urllib.parse.urlencode(
        {"term": name, "l": "english", "cc": "US"})
    try:
        req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0 (STAR)"})
        with urllib.request.urlopen(req, timeout=15) as r:
            items = json.loads(r.read()).get("items") or []
    except (urllib.error.URLError, OSError, ValueError):
        return None
    exact = {item.get("id") for item in items if clean(item.get("name")) == clean(name)}
    return exact.pop() if len(exact) == 1 else None


TITLES_PATH = JSONS_DIR / ".titles.json"
_titles_lock = threading.Lock()
_titles_pending = set()
_titles_failed = {}  # appid -> when a lookup last failed, so it's retried only now and then
TITLE_RETRY = 600  # seconds


def _fetch_title(appid):
    url = f"https://store.steampowered.com/api/appdetails?appids={appid}&filters=basic&l=english"
    try:
        req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0 (STAR)"})
        with urllib.request.urlopen(req, timeout=15) as r:
            entry = json.loads(r.read()).get(str(appid)) or {}
    except (urllib.error.URLError, OSError, ValueError):
        entry = {}
    title = ((entry.get("data") or {}).get("name") or "").strip() if entry.get("success") else ""
    with _titles_lock:
        _titles_pending.discard(appid)
        if not title:
            _titles_failed[appid] = time.monotonic()
            return
        try:
            titles = json.loads(TITLES_PATH.read_text())
        except (OSError, ValueError):
            titles = {}
        titles[str(appid)] = title
        TITLES_PATH.write_text(json.dumps(titles, indent=1) + "\n")


def app_title(appid):
    """The game's name on Steam's store, for games saved before configs kept
    it. Cached in jsons/.titles.json; looked up in the background, so None
    until it's known (or if the store doesn't list the game)."""
    if not isinstance(appid, int) or appid <= 0:
        return None
    try:
        title = json.loads(TITLES_PATH.read_text()).get(str(appid))
    except (OSError, ValueError):
        title = None
    if title:
        return title
    with _titles_lock:
        failed = _titles_failed.get(appid)
        if appid not in _titles_pending and (failed is None or time.monotonic() - failed > TITLE_RETRY):
            _titles_pending.add(appid)
            threading.Thread(target=_fetch_title, args=(appid,), daemon=True).start()
    return None
