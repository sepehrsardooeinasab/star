import json
import os
import re
import shutil
import signal
import subprocess
import sys
import time
from pathlib import Path

from unlocker.paths import CODE_DIR, DATA_DIR
from unlocker.settings import SETTINGS

API_URL = f"http://127.0.0.1:{SETTINGS['asf_port']}/Api/Command"
BOT_CONNECT_TIMEOUT = SETTINGS["bot_connect_timeout"]
# Extra request headers, fed to curl on stdin (-H @-) rather than as an
# argument, so the IPC password never shows up in `ps` output.
API_HEADERS = (f"Authentication: {SETTINGS['ipc_password']}\n"
               if SETTINGS["ipc_password"] else "")


def api_request_args(command):
    """(argv, stdin) for a curl call sending one command to ASF's IPC."""
    return (["curl", "-s", "-X", "POST", API_URL,
             "-H", "Content-Type: application/json", "-H", "@-",
             "-d", json.dumps({"Command": command})],
            API_HEADERS)

ASF_DIR = DATA_DIR / "archifarm"
ASF_BINARY = ASF_DIR / "ArchiSteamFarm"
ASF_LOG = ASF_DIR / "log.txt"


def asf_log_position():
    """Current end of ASF's log, to hand to logged_on_since() later."""
    try:
        return ASF_LOG.stat().st_size
    except OSError:
        return 0


def logged_on_since(position):
    """True if the bot logged on to Steam again after `position` (from
    asf_log_position()). Every log-on resets what the bot is playing to
    GamesPlayedWhileIdle, so a game started with "play" before a reconnect
    isn't running anymore. A log shorter than `position` was rotated by an
    ASF restart, which drops the game too."""
    try:
        with open(ASF_LOG, "rb") as log:
            log.seek(0, os.SEEK_END)
            if log.tell() < position:
                return True
            log.seek(position)
            return b"|OnLoggedOn() Successfully logged on" in log.read()
    except OSError:
        return False


def _ps(pid, field):
    return subprocess.run(
        ["ps", "-p", pid, "-o", f"{field}="], capture_output=True, text=True).stdout.strip()


def other_asf_instances():
    """[(pid, command)] for every running ArchiSteamFarm that isn't this
    project's own. Only real ASF processes count — the native binary, or
    `dotnet ArchiSteamFarm.dll` — not anything that merely mentions the
    name, like `tail -f .../ArchiSteamFarm/log.txt` or an editor."""
    pids = subprocess.run(
        ["pgrep", "-f", "ArchiSteamFarm"], capture_output=True, text=True).stdout.split()
    found = []
    for pid in pids:
        command = _ps(pid, "command")
        executable = os.path.basename(_ps(pid, "comm"))
        is_asf = (executable.startswith("ArchiSteamFarm")
                  or (executable == "dotnet" and "ArchiSteamFarm.dll" in command))
        if is_asf and str(ASF_BINARY) not in command:
            found.append((pid, command))
    return found


def _stop_other_asf_instances():
    """Stops other ArchiSteamFarm instances, when stop_other_asf is on.
    Steam only allows one active login per account, and bot1 here may share
    its account with other ASF installs on this machine — leaving one of
    those running would otherwise make this one hang forever trying to
    connect. With the setting off, they're left alone with a warning."""
    others = other_asf_instances()
    if not others:
        return
    if not SETTINGS["stop_other_asf"]:
        for pid, command in others:
            print(f"Warning: another ArchiSteamFarm is running (PID {pid}: {command}). "
                  "If it uses the same Steam account, the bot can't connect.")
        return
    for pid, command in others:
        print(f"Stopping another ArchiSteamFarm (PID {pid}: {command}).")
        subprocess.run(["kill", pid])
    time.sleep(3)


def asf_running():
    return subprocess.run(["pgrep", "-f", str(ASF_BINARY)], capture_output=True).returncode == 0


def ensure_asf_running():
    """Starts ArchiSteamFarm if it isn't already running, and waits a bit
    for it to come up. Mirrors runsteamunlocker's own bash version, but now
    called from here so it only runs after the user has actually confirmed
    they want to proceed, not unconditionally before asking."""
    _stop_other_asf_instances()

    if asf_running():
        return

    print("ArchiSteamFarm isn't running, starting it...")
    with open(ASF_LOG, "a") as log:
        subprocess.Popen(
            [str(ASF_BINARY)], cwd=str(ASF_DIR),
            stdin=subprocess.DEVNULL, stdout=log, stderr=log,
            start_new_session=True)


def start_keep_awake():
    """Keeps the system (and display) from sleeping or locking for the
    duration of a run: `caffeinate` on macOS, `systemd-inhibit` on Linux.
    Returns the process to hand to stop_keep_awake(), or None if neither
    tool is available or the inhibitor couldn't be taken — callers should
    skip printing anything about it then.

    Either way the process watches this one and exits on its own once it's
    gone, so a run that's force-killed (kill -9, Force Quit) — which never
    gets to call stop_keep_awake() — can't leave the system awake forever."""
    pid = str(os.getpid())
    if shutil.which("caffeinate"):
        # -w: exit when that process exits.
        cmd = ["caffeinate", "-d", "-i", "-m", "-s", "-w", pid]
    elif shutil.which("systemd-inhibit"):
        # Holds the sleep/idle inhibitor for as long as the wrapped command
        # runs; the command polls this process and ends once it's gone.
        cmd = ["systemd-inhibit", "--what=sleep:idle", "--mode=block",
               "--who=STAR", "--why=Unlocking achievements",
               "sh", "-c", 'while kill -0 "$0" 2>/dev/null; do sleep 5; done', pid]
    else:
        return None
    # Own process group, so stopping it also takes down systemd-inhibit's
    # child instead of orphaning it.
    proc = subprocess.Popen(
        cmd, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
        start_new_session=True)
    # systemd-inhibit exits right away when it isn't allowed to take the
    # inhibitor (e.g. no logind session) — report that as unavailable.
    try:
        proc.wait(timeout=0.5)
        return None
    except subprocess.TimeoutExpired:
        return proc


def stop_keep_awake(proc):
    """Stops a process started by start_keep_awake(), if any."""
    if proc is None:
        return
    if proc.poll() is None:
        try:
            os.killpg(proc.pid, signal.SIGTERM)
        # Already gone. macOS reports a group whose only member has exited
        # but not been reaped yet as EPERM rather than ESRCH.
        except (ProcessLookupError, PermissionError):
            pass
    proc.wait()


NOTIFY_TITLE = "STAR"
NOTIFY_ICON = CODE_DIR / "docs" / "logo.png"
NOTIFY_REMOVE_AFTER = 1800  # "done" notifications clear themselves after 30 min


def notify(game, message, error=False):
    """Desktop notification: title "Steam unlocker", the game as subtitle,
    a different sound for errors. Uses the best tool available and quietly
    does nothing when there's none — a missing tool never affects a run.

    - macOS + terminal-notifier (brew): project logo, and non-error
      notifications are removed again after NOTIFY_REMOVE_AFTER.
    - macOS without it: plain osascript notification (no logo, stays in
      Notification Center).
    - Linux + notify-send: logo; errors are marked critical, others ask to
      expire after NOTIFY_REMOVE_AFTER (some desktops ignore that)."""
    icon = str(NOTIFY_ICON) if NOTIFY_ICON.exists() else None
    try:
        if sys.platform == "darwin" and shutil.which("terminal-notifier"):
            group = f"steam-unlocker-{game}-{time.time_ns()}"
            cmd = ["terminal-notifier", "-title", NOTIFY_TITLE, "-subtitle", game,
                   "-message", message, "-sound", "Basso" if error else "Glass", "-group", group]
            if icon:
                cmd += ["-contentImage", icon]
            subprocess.run(cmd, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=10)
            if not error:
                subprocess.Popen(
                    [sys.executable, "-c",
                     f"import time, subprocess; time.sleep({NOTIFY_REMOVE_AFTER}); "
                     f"subprocess.run(['terminal-notifier', '-remove', {group!r}], timeout=30)"],
                    start_new_session=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        elif sys.platform == "darwin":
            # Passed as argv rather than spliced into the script, so quotes
            # in achievement/game names can't break the AppleScript.
            subprocess.run(
                ["osascript",
                 "-e", "on run argv",
                 "-e", "display notification (item 3 of argv) with title (item 1 of argv) "
                       "subtitle (item 2 of argv) sound name (item 4 of argv)",
                 "-e", "end run",
                 NOTIFY_TITLE, game, message, "Basso" if error else "Glass"],
                stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=10)
        elif shutil.which("notify-send"):
            cmd = ["notify-send", "-a", NOTIFY_TITLE,
                   "-h", f"string:sound-name:{'dialog-error' if error else 'complete'}"]
            if error:
                cmd += ["-u", "critical"]
            else:
                cmd += ["-t", str(NOTIFY_REMOVE_AFTER * 1000)]
            if icon:
                cmd += ["-i", icon]
            cmd += [f"{NOTIFY_TITLE} · {game}", message]
            subprocess.run(cmd, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=10)
    except (OSError, subprocess.SubprocessError):
        pass


def schedule_asf_kill(delay_seconds=60):
    """Detached background timer: force-kills ArchiSteamFarm (same as
    runsteamunlocker's own `pkill -f`) after delay_seconds, regardless of
    whether its API is reachable. Used after an unlock fails outright, so a
    stuck or unreachable bot doesn't stay connected to Steam indefinitely."""
    subprocess.Popen(
        [sys.executable, "-c",
         f"import time, subprocess; time.sleep({delay_seconds}); "
         f"subprocess.run(['pkill', '-f', {str(ASF_BINARY)!r}])"],
        start_new_session=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)


def send_command(command):
    """Returns (result, reconnected). result is the response's Result string,
    or None if ASF wasn't reachable. reconnected is True if this call had to
    sit through the retry loop below before getting a real response — i.e.
    Steam only just (re)established the bot's session, whether because ASF
    was just started fresh or because it silently reconnected after a
    mid-session network blip (including one triggered by the retried command
    itself — see the "exception" handling below).

    Retries for a while if: the IPC server itself isn't up yet (e.g. right
    after ASF was just started — it can take longer than any fixed guess to
    finish loading plugins and bind its port); the bot is still connecting to
    Steam; or the command itself came back as a plugin-side exception (this
    has been observed to happen — and to force-disconnect the bot — when a
    command is sent right as the bot finishes connecting, e.g.
    ASFAchievementManager's alist throwing AsyncJobFailedException before the
    Steam session is fully ready). Bailing out on the first attempt instead
    would let that exception text be mistaken for real (e.g. empty-looking)
    command output by callers like send_alist."""
    argv, headers = api_request_args(command)
    deadline = time.monotonic() + BOT_CONNECT_TIMEOUT
    printed_waiting = False
    reconnected = False

    while True:
        try:
            proc = subprocess.run(
                argv, input=headers, capture_output=True, text=True, timeout=30)
            response = json.loads(proc.stdout)
        except (subprocess.TimeoutExpired, json.JSONDecodeError):
            response = None

        result = (response.get("Result") or "") if response is not None else ""
        not_connected = (
            response is None
            or "not connected" in result.lower()
            or "exception" in result.lower())

        if not_connected and time.monotonic() < deadline:
            reconnected = True
            if not printed_waiting:
                if response is None:
                    print("ArchiSteamFarm isn't reachable yet, waiting...")
                elif "exception" in result.lower():
                    print("ArchiSteamFarm returned an error, retrying...")
                else:
                    print("Bot isn't connected to Steam yet, waiting...")
                printed_waiting = True
            time.sleep(2)
            continue

        return (result if response is not None else None), reconnected


def send_aset(appid, ach_ids):
    """ach_ids is one achievement id or a list of them. A list goes out as a
    single comma-separated aset, which ASF pushes to Steam as one stats
    update — so achievements that really unlock together (e.g. "beat the
    game on easy/medium/hard") share one timestamp instead of drifting a
    second apart per separate API round trip."""
    if isinstance(ach_ids, (list, tuple)):
        ach_ids = ",".join(str(a) for a in ach_ids)
    result, _ = send_command(f"aset {appid} {ach_ids}")

    if result is None:
        return "unreachable", ""
    # Checked before "already unlocked": a batch can legitimately mix both.
    if "success" in result.lower():
        return "success", result
    if "already unlocked" in result.lower():
        return "already_unlocked", result
    return "unknown", result


def send_alist(appid):
    """Returns ({achievement_number: is_unlocked}, reconnected), or (None,
    reconnected) if ASF wasn't reachable. Doesn't modify anything, unlike
    aset. See send_command for what reconnected means."""
    result, reconnected = send_command(f"alist {appid}")

    if result is None:
        return None, reconnected

    statuses = {}
    for line in result.splitlines():
        match = re.match(r"\s*(\d+)\s*\[(✅|❌)\]", line)
        if match:
            statuses[int(match.group(1))] = match.group(2) == "✅"

    return statuses, reconnected
