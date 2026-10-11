"""First-run setup: downloads ArchiSteamFarm and the ASFAchievementManager
plugin into archifarm/, writes the configs the unlocker expects, and signs
the bot in to Steam (including the Steam Guard code).

ASF and the plugin are pinned to a pair known to work together — the
plugin is built against a specific ASF version — and every download is
checked against the SHA512SUMS file published with its release. Which pair
is installed is recorded, so a new pin (which comes with an app update)
updates both."""
import hashlib
import json
import os
import platform
import shutil
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.request
import zipfile
from pathlib import Path

from unlocker.api import ASF_BINARY, ASF_DIR, asf_running, ensure_asf_running
from unlocker.settings import SETTINGS
from unlocker.state import SESSION_LOCK, acquire_lock, lock_info, release_locks

# The pair this release was tried with: installed, and updated to, by
# itself. A newer pair that's compatible can be installed from Settings.
ASF_VERSION = "6.3.10.3"
PLUGIN_VERSION = "1.1.0.0"
ASF_REPO = "JustArchiNET/ArchiSteamFarm"
PLUGIN_REPO = "CatPoweredPlugins/ASFAchievementManager"

CONFIG_DIR = ASF_DIR / "config"
PLUGIN_DIR = ASF_DIR / "plugins" / "ASFAchievementManager"
BOT_NAME = "bot1"
BOT_CONFIG = CONFIG_DIR / f"{BOT_NAME}.json"
VERSIONS_FILE = ASF_DIR / "unlocker-versions.json"
IPC_URL = f"http://127.0.0.1:{SETTINGS['asf_port']}/Api"

# ASF's EUserInputType: what the bot is waiting for before it can log on.
INPUT_TYPES = {0: None, 1: "Login", 2: "Password", 3: "SteamGuard",
               4: "SteamParentalCode", 5: "TwoFactorAuthentication"}


class SetupError(Exception):
    pass


def asf_asset():
    """ASF's self-contained build for this machine (no .NET needed)."""
    system, machine = sys.platform, platform.machine().lower()
    arch = {"arm64": "arm64", "aarch64": "arm64", "x86_64": "x64", "amd64": "x64",
            "armv7l": "arm"}.get(machine)
    if system == "darwin" and arch in ("arm64", "x64"):
        return f"ASF-osx-{arch}.zip"
    if system.startswith("linux") and arch:
        return f"ASF-linux-{arch}.zip"
    raise SetupError(f"ArchiSteamFarm has no build for {system} {machine}.")


def installed_versions():
    """{"asf": ..., "plugin": ...} as installed by this app. Empty for
    installs from before versions were recorded."""
    try:
        return json.loads(VERSIONS_FILE.read_text())
    except (OSError, ValueError):
        return {}


def _record_version(part, version):
    versions = installed_versions()
    versions[part] = version
    VERSIONS_FILE.write_text(json.dumps(versions, indent=2) + "\n")


def _version_key(version):
    try:
        return tuple(int(p) for p in version.split("."))
    except (AttributeError, ValueError):
        return ()


def _needs(part, wanted=None):
    """Whether ASF ("asf") or the plugin ("plugin") is missing or older than
    wanted (the pinned version by default). A newer one, installed from
    Settings, is kept."""
    installed = ASF_BINARY.exists() if part == "asf" else (PLUGIN_DIR / "ASFAchievementManager.dll").exists()
    wanted = wanted or (ASF_VERSION if part == "asf" else PLUGIN_VERSION)
    return not installed or _version_key(installed_versions().get(part)) < _version_key(wanted)


def status():
    bot = {}
    if BOT_CONFIG.exists():
        try:
            bot = json.loads(BOT_CONFIG.read_text())
        except (OSError, json.JSONDecodeError):
            pass
    asf = ASF_BINARY.exists()
    plugin = (PLUGIN_DIR / "ASFAchievementManager.dll").exists()
    return {
        "asf": asf,
        "plugin": plugin,
        "asf_version": installed_versions().get("asf") if asf else None,
        "plugin_version": installed_versions().get("plugin") if plugin else None,
        "asf_wanted": ASF_VERSION,
        "plugin_wanted": PLUGIN_VERSION,
        # Installed, but older than the pinned pair: install() updates it.
        "outdated": asf and plugin and (_needs("asf") or _needs("plugin")),
        "bot": bool(bot.get("SteamLogin")),
        "account": bot.get("SteamLogin"),
    }


def _download(url, dest):
    req = urllib.request.Request(url, headers={"User-Agent": "star"})
    with urllib.request.urlopen(req, timeout=60) as r, open(dest, "wb") as f:
        shutil.copyfileobj(r, f)


def _github(path):
    req = urllib.request.Request(f"https://api.github.com/repos/{path}", headers={
        "User-Agent": "star", "Accept": "application/vnd.github+json"})
    with urllib.request.urlopen(req, timeout=20) as r:
        return json.loads(r.read())


def latest_compatible():
    """The newest ASF + plugin pair that work together: the latest plugin
    release, with the newest stable ASF in the series (6.3.x) it's built
    against. The plugin's source pins ASF as a submodule, and ASF's plugin
    API holds within a series but not across them. Returns {"asf", "plugin"}
    or raises SetupError."""
    try:
        plugin = _github(f"{PLUGIN_REPO}/releases/latest")
        plugin_tag = plugin["tag_name"]
        if "ASFAchievementManager.zip" not in {a["name"] for a in plugin.get("assets", [])}:
            raise SetupError(f"ASFAchievementManager {plugin_tag} has no download yet.")
        sha = _github(f"{PLUGIN_REPO}/contents/ArchiSteamFarm?ref={plugin_tag}")["sha"]
        built_against = None
        for page in range(1, 6):
            tags = _github(f"{ASF_REPO}/tags?per_page=100&page={page}")
            built_against = next((t["name"] for t in tags if t["commit"]["sha"] == sha), None)
            if built_against or not tags:
                break
        if not built_against:
            raise SetupError(f"Couldn't tell which ArchiSteamFarm ASFAchievementManager {plugin_tag} needs.")
        series = built_against.split(".")[:2]
        asset = asf_asset()
        candidates = [r["tag_name"] for r in _github(f"{ASF_REPO}/releases?per_page=50")
                      if not r["prerelease"] and not r["draft"]
                      and r["tag_name"].split(".")[:2] == series
                      and asset in {a["name"] for a in r.get("assets", [])}]
    except (urllib.error.URLError, OSError, ValueError, KeyError) as e:
        raise SetupError(f"Couldn't check GitHub for updates ({e.__class__.__name__}).")
    if not candidates:
        raise SetupError(f"No ArchiSteamFarm {'.'.join(series)}.x release found.")
    return {"asf": max(candidates, key=_version_key), "plugin": plugin_tag}


def _verified_download(release, name, workdir, report):
    """Downloads release/name into workdir, checked against the release's
    SHA512SUMS. Returns the file's path."""
    report(f"Downloading {name}…")
    path, sums = workdir / name, workdir / f"{name}.SHA512SUMS"
    try:
        _download(f"{release}/{name}", path)
        _download(f"{release}/SHA512SUMS", sums)
    except (urllib.error.URLError, OSError) as e:
        raise SetupError(f"Couldn't download {name}: {e}")
    expected = next((line.split()[0] for line in sums.read_text().splitlines()
                     if line.strip().endswith(name)), None)
    digest = hashlib.sha512(path.read_bytes()).hexdigest()
    if expected is None or expected.lower() != digest:
        raise SetupError(f"{name} didn't match its published checksum; not installing it.")
    return path


def _extract(archive, dest, keep_existing=()):
    """Unzips into dest. Paths under keep_existing that already exist are
    left alone, so a reinstall never overwrites the user's configs."""
    with zipfile.ZipFile(archive) as z:
        for member in z.infolist():
            target = (dest / member.filename).resolve()
            if dest.resolve() not in target.parents and target != dest.resolve():
                raise SetupError(f"Unsafe path in {archive.name}: {member.filename}")
            if any(member.filename.startswith(k) for k in keep_existing) and target.exists():
                continue
            z.extract(member, dest)
            # zipfile drops permission bits; restore the executable ones.
            mode = member.external_attr >> 16
            if mode & 0o111:
                os.chmod(target, mode & 0o777)


def write_configs():
    """ASF.json, IPC.config and the bot's settings the unlocker relies on,
    merged into whatever is there already."""
    CONFIG_DIR.mkdir(parents=True, exist_ok=True)
    asf_json = CONFIG_DIR / "ASF.json"
    asf = json.loads(asf_json.read_text()) if asf_json.exists() else {}
    # Headless: never block on a terminal prompt (input comes through the
    # API instead). AutoRestart off: the unlocker starts and stops ASF.
    # UpdatePeriod 0: ASF never updates itself, since the plugin only works
    # with the ASF it's built for; install() updates the two together.
    asf.update({"Headless": True, "AutoRestart": False, "UpdatePeriod": 0})
    asf_json.write_text(json.dumps(asf, indent=2) + "\n")

    port = SETTINGS["asf_port"]
    ipc = {"Kestrel": {"Endpoints": {
        "HTTP4": {"Url": f"http://127.0.0.1:{port}"},
        "HTTP6": {"Url": f"http://[::1]:{port}"}}}}
    (CONFIG_DIR / "IPC.config").write_text(json.dumps(ipc, indent=2) + "\n")


def _stop_idle_asf():
    """Stops ASF when no session is using it (it stays up for a while after
    one, in case another follows)."""
    if not asf_running():
        return
    stop_asf()
    deadline = time.monotonic() + 20
    while asf_running() and time.monotonic() < deadline:
        time.sleep(0.5)
    if asf_running():
        subprocess.run(["pkill", "-f", str(ASF_BINARY)])
        time.sleep(2)


def _extract_plugin(archive):
    shutil.rmtree(PLUGIN_DIR, ignore_errors=True)  # no files left from the old version
    PLUGIN_DIR.mkdir(parents=True, exist_ok=True)
    _extract(archive, PLUGIN_DIR)
    # Some releases wrap the files in a folder of their own.
    nested = PLUGIN_DIR / "ASFAchievementManager"
    if nested.is_dir():
        for item in nested.iterdir():
            shutil.move(str(item), PLUGIN_DIR / item.name)
        nested.rmdir()


def install(report=print, versions=None):
    """Downloads and installs ASF and the plugin, or updates them — to the
    pinned versions, or to versions ({"asf", "plugin"}, from
    latest_compatible()) — skipping whichever is already that new, then
    writes the configs.

    Files are swapped while holding the session lock, so never during a
    session: if one is playing, the update is skipped (it's tried again
    later), and a session that comes due meanwhile waits for the swap the
    way it waits for another game's session."""
    asf_version = (versions or {}).get("asf") or ASF_VERSION
    plugin_version = (versions or {}).get("plugin") or PLUGIN_VERSION
    need_asf, need_plugin = _needs("asf", asf_version), _needs("plugin", plugin_version)
    if not (need_asf or need_plugin):
        write_configs()
        report("ArchiSteamFarm is ready.")
        return
    if lock_info(SESSION_LOCK):
        write_configs()
        report("A game is in a session, so ArchiSteamFarm wasn't updated. "
               "It's updated after the session, while the app is open.")
        return
    updating = ASF_BINARY.exists()
    with tempfile.TemporaryDirectory() as tmp:
        tmp = Path(tmp)
        # Downloaded first, so a session waits only for the swap itself.
        asf_zip = need_asf and _verified_download(
            f"https://github.com/{ASF_REPO}/releases/download/{asf_version}", asf_asset(), tmp, report)
        plugin_zip = need_plugin and _verified_download(
            f"https://github.com/{PLUGIN_REPO}/releases/download/{plugin_version}",
            "ASFAchievementManager.zip", tmp, report)
        if not acquire_lock(SESSION_LOCK, "ArchiSteamFarm update"):
            write_configs()
            report("A game's session just started, so ArchiSteamFarm wasn't updated. "
                   "It's updated after the session, while the app is open.")
            return
        try:
            _stop_idle_asf()
            if asf_zip:
                report(f"{'Updating' if updating else 'Installing'} ArchiSteamFarm {asf_version}…")
                ASF_DIR.mkdir(parents=True, exist_ok=True)
                _extract(asf_zip, ASF_DIR, keep_existing=("config/",))
                ASF_BINARY.chmod(0o755)
                _record_version("asf", asf_version)
            if plugin_zip:
                report(f"{'Updating' if updating else 'Installing'} ASFAchievementManager {plugin_version}…")
                _extract_plugin(plugin_zip)
                _record_version("plugin", plugin_version)
            write_configs()
        finally:
            release_locks()
    report("ArchiSteamFarm is ready.")


def save_login(username, password):
    """Writes the bot's config with this Steam account. Card farming is
    off: the bot is only there to play games and unlock achievements."""
    CONFIG_DIR.mkdir(parents=True, exist_ok=True)
    bot = json.loads(BOT_CONFIG.read_text()) if BOT_CONFIG.exists() else {}
    bot.update({"Enabled": True, "SteamLogin": username, "SteamPassword": password,
                "FarmingEnabled": False, "RemoteCommunication": 0})
    BOT_CONFIG.write_text(json.dumps(bot, indent=2) + "\n")
    BOT_CONFIG.chmod(0o600)


def _ipc(method, path, body=None):
    headers = {"Content-Type": "application/json"}
    if SETTINGS["ipc_password"]:
        headers["Authentication"] = SETTINGS["ipc_password"]
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(f"{IPC_URL}/{path}", data=data, headers=headers, method=method)
    with urllib.request.urlopen(req, timeout=15) as r:
        return json.loads(r.read() or b"{}")


def bot_state():
    """(logged_on, required_input or None), or None if ASF isn't reachable
    or doesn't know the bot yet."""
    try:
        bot = (_ipc("GET", f"Bot/{BOT_NAME}").get("Result") or {}).get(BOT_NAME)
    except (urllib.error.URLError, OSError, ValueError):
        return None
    if not bot:
        return None
    return bool(bot.get("IsConnectedAndLoggedOn")), INPUT_TYPES.get(bot.get("RequiredInput"))


def wait_for_login(timeout=90, report=print):
    """Starts ASF if needed and waits until the bot is logged on or needs a
    code. Returns "logged_on", the input type it needs ("SteamGuard",
    "TwoFactorAuthentication", ...), or "timeout"."""
    ensure_asf_running()
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        state = bot_state()
        if state:
            logged_on, needs = state
            if logged_on:
                return "logged_on"
            if needs:
                return needs
        time.sleep(2)
    return "timeout"


def send_code(input_type, code):
    """Gives the bot the code it asked for and starts it again."""
    number = next(n for n, name in INPUT_TYPES.items() if name == input_type)
    _ipc("POST", f"Bot/{BOT_NAME}/Input", {"Type": number, "Value": code})
    _ipc("POST", f"Bot/{BOT_NAME}/Start")


def stop_asf():
    try:
        _ipc("POST", "ASF/Exit")
    except (urllib.error.URLError, OSError, ValueError):
        pass


def setup_interactive(login=True, report=print):
    """Terminal version of the app's setup: installs ASF and the plugin,
    then (unless login is False) asks for the Steam login and code."""
    install(report)
    if not login:
        return
    current = status()["account"]
    if current and input(f"Signed in as {current}. Sign in again? [y/N] ").strip().lower() != "y":
        return
    import getpass
    username = input("Steam username: ").strip()
    save_login(username, getpass.getpass("Steam password: "))
    print("Signing in to Steam…")
    result = wait_for_login()
    while result in ("SteamGuard", "TwoFactorAuthentication"):
        where = "from your email" if result == "SteamGuard" else "from the Steam mobile app"
        send_code(result, input(f"Steam Guard code {where}: ").strip())
        result = wait_for_login()
    if result == "logged_on":
        print("Signed in. Setup is done.")
        stop_asf()
    elif result == "timeout":
        print("Steam didn't answer in time. If it asked you to approve the sign-in "
              "in the Steam mobile app, do that, then run setup again.")
    else:
        print(f"Couldn't sign in (Steam asked for {result}). Check the username and password.")
