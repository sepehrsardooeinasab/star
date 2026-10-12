import json
import os
import random
import signal
import subprocess
import sys
import time
from datetime import datetime, timedelta

from unlocker.api import (
    API_URL,
    api_request_args,
    asf_log_position,
    logged_on_since,
    send_command,
    send_aset,
    send_alist,
    ensure_asf_running,
    notify,
    other_asf_instances,
    schedule_asf_kill,
    start_keep_awake,
    stop_keep_awake)
from unlocker.settings import SETTINGS
from unlocker.state import (
    DEFAULT_PROGRESS,
    SESSION_LOCK,
    acquire_lock,
    auto_lock_path,
    cleanup_profile,
    hold_game_lock,
    config_fingerprint,
    config_problems,
    list_profiles,
    load_config,
    load_progress,
    lock_holder,
    profile_lock_path,
    profile_paths,
    release_locks,
    save_progress,
    stop_after_path)

# See unlocker/settings.py for what each of these is for.
ASF_SHUTDOWN_DELAY = SETTINGS["asf_shutdown_delay"]
WARM_SETTLE_DELAY = SETTINGS["warm_settle_delay"]
RECONNECT_SETTLE_DELAY = SETTINGS["reconnect_settle_delay"]
PLAY_CHECK_INTERVAL = SETTINGS["play_check_interval"]
SIMULTANEOUS_MAX_DELAY = SETTINGS["simultaneous_max_delay"]
JITTER_ENABLED = SETTINGS["jitter_enabled"]
JITTER_MIN_DELAY = SETTINGS["jitter_min_delay"]
JITTER_PERCENT = SETTINGS["jitter_percent"]


def _jitter(seconds):
    """A configured delay with the optional randomness applied: delays
    longer than JITTER_MIN_DELAY move by up to ±JITTER_PERCENT of
    themselves, when jitter is on. Shorter ones (and everything, when it's
    off) come back unchanged."""
    if not JITTER_ENABLED or seconds <= JITTER_MIN_DELAY:
        return seconds
    spread = seconds * JITTER_PERCENT / 100
    return max(0, round(seconds + random.uniform(-spread, spread)))


def _session_bounds(achievements):
    """Splits achievements into (start, end) index ranges, one per session."""
    bounds = []
    start = 0
    for i in range(1, len(achievements) + 1):
        if i == len(achievements) or achievements[i]["new_session"]:
            bounds.append((start, i))
            start = i
    return bounds


class _Signalled(Exception):
    """Raised from a SIGHUP/SIGTERM handler, so the run unwinds through its
    finally (stopping keep-awake) instead of dying on the spot."""
    def __init__(self, signum):
        super().__init__(signal.Signals(signum).name)
        self.signum = signum


def _raise_signalled(signum, frame):
    raise _Signalled(signum)


def _stop_playing():
    """Best-effort cleanup for a run stopped mid-session (Ctrl+C, terminal
    closed, -k, crash): tells the bot to stop "playing" the game and
    schedules the usual idle ASF shutdown. One quick attempt rather than
    send_command's long retry loop, since the user is waiting for it to quit.
    Prints nothing — after SIGHUP there's no terminal left to print to."""
    signal.signal(signal.SIGINT, signal.SIG_IGN)  # a second Ctrl+C can't cut it short
    argv, headers = api_request_args("resume")
    try:
        subprocess.run(argv, input=headers, capture_output=True, text=True, timeout=10)
    except (subprocess.TimeoutExpired, OSError):
        pass
    _schedule_asf_shutdown()


def _schedule_asf_shutdown(delay_seconds=ASF_SHUTDOWN_DELAY):
    """Detached background timer: after delay_seconds, shuts ArchiSteamFarm
    down entirely — but only if it still looks idle by then, so it isn't
    killed out from under an interleaved session for another game that
    might get started in the meantime."""
    (status_argv, headers), (exit_argv, _) = api_request_args("status"), api_request_args("exit")
    # Headers (which may hold the IPC password) go through the environment,
    # not the -c code below, which is visible in `ps`.
    child_code = f"""
import json, os, subprocess, time

def request(argv):
    p = subprocess.run(argv, input=os.environ["UNLOCKER_API_HEADERS"],
                       capture_output=True, text=True, timeout=30)
    return json.loads(p.stdout).get("Result", "")

def cmd(c, attempts=5, retry_delay=5):
    # A blip (e.g. Steam reconnecting) can make a single check fail;
    # retry the request itself a few times before giving up, so a
    # transient hiccup doesn't get treated as "still busy" and strand
    # ASF (and its Steam session) running forever.
    for attempt in range(attempts):
        try:
            return request(c)
        except Exception:
            if attempt == attempts - 1:
                return ""
            time.sleep(retry_delay)

time.sleep({delay_seconds})
if "not farming anything" in cmd({status_argv!r}).lower():
    cmd({exit_argv!r})
"""
    subprocess.Popen(
        [sys.executable, "-c", child_code],
        env={**os.environ, "UNLOCKER_API_HEADERS": headers},
        start_new_session=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)


def _estimate_session(achievements, start_from, progress, first_run):
    """Returns (end_index, wait_seconds, duration_seconds) for the session
    starting at start_from: every achievement up to (not including) the next
    one that starts a new session, or the end of the list.

    Every achievement in the session is waited out in order regardless of
    whether it turns out to already be unlocked — only whether an aset is
    actually sent depends on that — so this is purely positional. wait_seconds
    is how long until achievements[start_from] can fire — mirrors the real
    loop's delay rule for it exactly, including the first-run/just-resumed-
    from-cooldown "fires immediately" cases. duration_seconds is the
    configured delay for every achievement after that one, i.e. the active
    time once the session has actually started."""
    end = start_from + 1
    while end < len(achievements) and not achievements[end]["new_session"]:
        end += 1

    if first_run:
        wait = 0
    elif progress["next_unlock_at"] is not None:
        unlock_at = datetime.fromisoformat(progress["next_unlock_at"])
        wait = max(0, int((unlock_at - datetime.now()).total_seconds()))
    else:
        wait = achievements[start_from]["delay"]

    duration = sum(achievements[i]["delay"] for i in range(start_from + 1, end))

    return end, wait, duration


def config_changed(config, progress):
    """True when progress was saved against a different achievement order
    than the config has now, so its saved position may point at a
    different achievement. Progress from before fingerprints existed, or
    for another appid (which gets reset anyway), doesn't count."""
    return (progress["appid"] == config["appid"]
            and progress["last_completed"] >= 0
            and progress["config_hash"] is not None
            and progress["config_hash"] != config_fingerprint(config))


def _format_duration(seconds):
    hours, rem = divmod(int(seconds), 3600)
    minutes = rem // 60
    if hours:
        return f"{hours}h {minutes}m"
    if minutes:
        return f"{minutes}m"
    return f"{int(seconds)}s"


def _session_status(config, progress):
    """Read-only summary of a profile's next session, for listing: returns
    None when every achievement is done, else (session_number, session_total,
    count, duration_seconds, wait_seconds). Mirrors run()'s wait rules
    without touching ASF or writing progress."""
    achievements = config["achievements"]
    if progress["appid"] != 0 and progress["appid"] != config["appid"]:
        progress = dict(DEFAULT_PROGRESS)

    start_from = progress["last_completed"] + 1
    if start_from >= len(achievements):
        return None

    session_bounds = _session_bounds(achievements)
    session_index = next(idx for idx, (s, e) in enumerate(session_bounds) if s <= start_from < e)
    first_run = progress["last_completed"] == -1
    end, wait, duration = _estimate_session(achievements, start_from, progress, first_run)

    if progress["session_ends_at"] is not None:
        # Past cooldown, run() resets next_unlock_at to now, so it's ready.
        remaining = datetime.fromisoformat(progress["session_ends_at"]) - datetime.now()
        wait = max(0, int(remaining.total_seconds()))

    return session_index + 1, len(session_bounds), end - start_from, duration, wait


def list_status():
    """Prints a table of every profile's next session: number, length,
    achievement count, and when it can run."""
    profiles = list_profiles()
    if not profiles:
        print("No configs found in jsons/.")
        return

    rows = []
    for name, _ in profiles:
        config_path, progress_path = profile_paths(name)
        label = name
        try:
            config = json.loads(config_path.read_text())
            if config_problems(config):
                rows.append((label, "-", "-", "-", "invalid config (run it to see why)"))
                continue
            progress = load_progress(progress_path)
            status = _session_status(config, progress)
        except (json.JSONDecodeError, OSError, KeyError, ValueError) as e:
            rows.append((label, "-", "-", "-", f"unreadable ({e.__class__.__name__})"))
            continue

        if status is None:
            rows.append((label, "-", "-", "-", "completed"))
            continue

        number, total, count, duration, wait = status
        when = _format_duration(wait) if wait > 0 else "now"
        if lock_holder(profile_lock_path(name)):
            when = "running now"
        elif config_changed(config, progress):
            when += " (config changed)"
        rows.append((label, f"{number}/{total}", f"~{_format_duration(duration)}", str(count), when))

    header = ("NAME", "SESSION", "DURATION", "#ACH", "READY IN")
    widths = [max(len(r[c]) for r in [header] + rows) for c in range(len(header))]
    for r in [header, tuple("-" * w for w in widths)] + rows:
        print("  ".join(r[c].ljust(widths[c]) for c in range(len(header))).rstrip())


def run(*args, **kwargs):
    """Runs a session (see _run), releasing its locks when it returns.
    Returns how it ended: "session_done" (more sessions to go), "all_done",
    "stopped" (signal or Ctrl+C), "cancelled", "busy" (this game or another
    session is running), "not_ready" (still in its break), "refused" (config
    order changed, with -f) or "error"; None for -t."""
    try:
        return _run(*args, **kwargs)
    finally:
        release_locks()


def run_auto(game_name):
    """Plays every remaining session of a game back to back: runs one,
    waits out the break, runs the next, until the game is done. Each
    session is a normal run(), confirmed up front (like -f) and started
    as soon as it can (like -w). Stops after the current session when its
    stop-after flag file appears, and right away on SIGTERM (Stop in the
    app, or -k), which the session itself cleans up after."""
    game_label = game_name
    if not acquire_lock(auto_lock_path(game_name), game_label, keep=True):
        print(f"{game_label} is already running: {lock_holder(auto_lock_path(game_name))}.")
        return
    other = hold_game_lock(game_label, keep=True)
    if other:
        print(f"{other} is running. Only one game runs at a time; stop it first.")
        return
    stop_after = stop_after_path(game_name)
    stop_after.unlink(missing_ok=True)
    # Also set by each run, but a signal can land between runs too.
    signal.signal(signal.SIGHUP, _raise_signalled)
    signal.signal(signal.SIGTERM, _raise_signalled)

    print(f"Running every remaining session of {game_label}, started {datetime.now():%a %H:%M}.")
    try:
        while True:
            outcome = run(game_name, force=True, wait_ready=True)
            if outcome != "session_done":
                break
            if stop_after.exists():
                stop_after.unlink(missing_ok=True)
                print("Stopped after this session, as asked. Progress is saved.")
                notify(game_label, "Stopped after the session, as asked.")
                break
            print()
    except _Signalled:
        print("\nStopped. Progress is saved — run it again to continue.")
    finally:
        stop_after.unlink(missing_ok=True)


def _run(game_name, force=False, time_only=False, delay=None, wait_ready=False):
    """delay: seconds to wait before starting (-in). wait_ready: wait until
    the session can actually run — cooldown over and first unlock due — and
    start then (-w). Either way the wait happens after the confirmation
    prompt, under keep-awake, and before ASF is touched."""
    config_path, progress_path = profile_paths(game_name)
    game_label = game_name

    # One run per game at a time, held until this process exits — including
    # any -w/-in wait. -t only reads, so it doesn't need it.
    if not time_only and not acquire_lock(profile_lock_path(game_name), game_label):
        print(f"{game_label} is already running: {lock_holder(profile_lock_path(game_name))}.")
        return "busy"
    # And one game at a time, so a second game can't start during this
    # one's breaks either.
    if not time_only:
        other = hold_game_lock(game_label)
        if other:
            print(f"{other} is running. Only one game runs at a time; stop it first.")
            return "busy"

    config = load_config(config_path)
    achievements = config["achievements"]
    appid = config["appid"]

    progress = load_progress(progress_path)

    if progress["appid"] != 0 and progress["appid"] != appid:
        if not time_only:
            print(f"New game detected (was {progress['appid']}, now {appid}). Resetting progress.")
        progress = dict(DEFAULT_PROGRESS)

    start_from = progress["last_completed"] + 1
    if start_from >= len(achievements):
        if time_only:
            print("0 0")
            return
        print("All achievements already completed.")
        cleanup_profile(game_name)
        return "all_done"

    if config_changed(config, progress) and not time_only:
        n = progress["last_completed"] + 1
        print(f"The config's achievement order changed since this game was started. "
              f"Progress is saved as {n} achievement{'s' if n != 1 else ''} done by position, "
              f"so it may now point at different achievements.")
        if force:
            print("Not running with -f. Run without -f to confirm, or delete "
                  f"{progress_path.name} to start over.")
            return "refused"
        if input("Continue from the same position anyway? [y/N] ").strip().lower() != "y":
            print("Cancelled.")
            return "cancelled"
    # Every save from here on records the config it was made against.
    progress["config_hash"] = config_fingerprint(config)


    # Cheap, ASF-independent estimate from the config alone, so the user can
    # decide whether to bother connecting at all before we touch ASF. The
    # count/duration part doesn't depend on next_unlock_at, so it's safe to
    # compute before the session_ends_at cooldown check/reset below.
    session_bounds = _session_bounds(achievements)
    session_index = next(idx for idx, (s, e) in enumerate(session_bounds) if s <= start_from < e)
    session_end_i, _, est_duration = _estimate_session(
        achievements, start_from, progress, progress["last_completed"] == -1)
    count = session_end_i - start_from
    session_line = (
        f"Session {session_index + 1}/{len(session_bounds)} "
        f"~{_format_duration(est_duration)} "
        f"({count} achievement{'s' if count != 1 else ''})."
    )


    now = datetime.now()
    # Set when the between-sessions cooldown is still running but -w/-in
    # will wait it out; the cooldown reset below then happens after that wait.
    cooldown_ends = None
    if progress["session_ends_at"] is not None:
        session_start = datetime.fromisoformat(progress["session_ends_at"])
        if now < session_start:
            remaining = session_start - now
            if time_only:
                print(f"{int(remaining.total_seconds())} {est_duration}")
                return
            if not wait_ready and (delay is None or now + timedelta(seconds=delay) < session_start):
                hours, rem = divmod(int(remaining.total_seconds()), 3600)
                minutes = rem // 60
                print(f"Session can be run after {hours}h {minutes}m (at {session_start:%H:%M}).")
                if delay is not None:
                    print(f"-in {_format_duration(delay)} would start before then — use a longer delay, or -w.")
                print(session_line)
                return "not_ready"
            cooldown_ends = session_start
        else:
            progress["session_ends_at"] = None
            progress["next_unlock_at"] = now.isoformat()

    if cooldown_ends is not None:
        # Once the cooldown resets, the first achievement fires immediately.
        ready_at = cooldown_ends
    else:
        _, est_wait, _ = _estimate_session(
            achievements, start_from, progress, progress["last_completed"] == -1)
        if time_only:
            print(f"{est_wait} {est_duration}")
            return
        ready_at = now + timedelta(seconds=est_wait)

    if ready_at > now:
        print(f"Session can be run in {_format_duration((ready_at - now).total_seconds())} "
              f"(at {ready_at:%H:%M}).")
    else:
        print("Session can be run now.")

    if wait_ready:
        start_at = max(ready_at, now)
    elif delay is not None:
        start_at = now + timedelta(seconds=delay)
    else:
        start_at = now
    if start_at > now:
        print(f"Starting in {_format_duration((start_at - now).total_seconds())} (at {start_at:%H:%M}).")

    # Another game's session is talking to ASF right now. ASF plays one game
    # at a time, so this one would have it "play" the wrong game mid-session.
    busy = lock_holder(SESSION_LOCK)
    if busy:
        if not wait_ready and delay is None:
            print(f"Another session is running: {busy}. Run this one after it "
                  "finishes, or use -w / -in to queue it.")
            return "busy"
        print(f"Another session is running: {busy}. If it's still going by then, "
              "this one will wait for it to finish.")

    others = other_asf_instances()
    if others:
        action = ("will be stopped when the session starts" if SETTINGS["stop_other_asf"]
                  else "will be left running (stop_other_asf is off)")
        for pid, command in others:
            print(f"Another ArchiSteamFarm is running (PID {pid}: {command}). It {action}.")

    if JITTER_ENABLED:
        print(f"Randomness on: delays over {_format_duration(JITTER_MIN_DELAY)} "
              f"vary by up to ±{JITTER_PERCENT:g}%.")

    if force:
        print(session_line)
    else:
        answer = input(f"{session_line} Continue? [y/N] ").strip().lower()
        if answer != "y":
            print("Cancelled.")
            return "cancelled"

    # Only touch ASF once the user has actually committed to running —
    # not before, so declining the prompt above never starts it up.
    # SIGHUP: the terminal window was closed. SIGTERM: runsteamunlocker -k.
    signal.signal(signal.SIGHUP, _raise_signalled)
    signal.signal(signal.SIGTERM, _raise_signalled)

    # Nothing to wait out (e.g. a single-achievement session that fires right
    # away) means nothing to stay awake for — the run is over in seconds.
    awake_for = (max(start_at, ready_at) - now).total_seconds() + est_duration
    keep_awake_proc = start_keep_awake() if awake_for > 0 else None
    if keep_awake_proc is not None:
        print(f"Keeping the system awake for {_format_duration(awake_for)}.")

    # True from "play" until the session ends on its own — while it's set, a
    # run that stops early has to tell the bot to stop playing.
    playing = False
    try:
        if start_at > datetime.now():
            print(f"Waiting until {start_at:%H:%M} before starting...")
            # Short sleeps against the absolute target, so drift can't make
            # it start late.
            while (left := (start_at - datetime.now()).total_seconds()) > 0:
                time.sleep(min(left, 60))

        if not acquire_lock(SESSION_LOCK, game_label):
            print(f"Waiting for the other session to finish: {lock_holder(SESSION_LOCK)}...")
            acquire_lock(SESSION_LOCK, game_label, block=True)
            print("It finished, starting.")

        if cooldown_ends is not None:
            progress["session_ends_at"] = None
            progress["next_unlock_at"] = datetime.now().isoformat()

        ensure_asf_running()

        # Real unlock state from Steam, independent of the config's ordering, so
        # achievements already unlocked (in any order) never trigger a wait.
        unlocked, reconnected = send_alist(appid)
        if unlocked is None:
            print(f"ERROR: ArchiSteamFarm isn't reachable at {API_URL}")
            notify(game_label, "Stopped: ArchiSteamFarm isn't reachable.", error=True)
            # ensure_asf_running() may have just started it — don't leave
            # that process orphaned and running for the next session to
            # trip over.
            schedule_asf_kill()
            return "error"

        awaiting_first_unlock = progress["last_completed"] == -1
        _, wait_seconds, _ = _estimate_session(
            achievements, start_from, progress, awaiting_first_unlock)

        if wait_seconds > 0:
            run_at = datetime.now() + timedelta(seconds=wait_seconds)
            print(f"Session can be run in {_format_duration(wait_seconds)} (at {run_at:%H:%M}).")
        else:
            print("Bot is now connected to Steam.")

        log_position = asf_log_position()
        send_command(f"play {appid}")
        playing = True
        # Give Steam a moment to actually register the game as running before
        # the first aset — the first achievement of a session otherwise fires
        # with zero delay, right on top of "play", and unlocks with an epoch
        # (offline-looking) timestamp instead of a real one. A bot that just
        # (re)connected (fresh ASF start, or a reconnect after a mid-session
        # network blip) needs longer for Steam to consider the session
        # properly "online" than one that was already connected throughout.
        time.sleep(RECONNECT_SETTLE_DELAY if reconnected else WARM_SETTLE_DELAY)

        def ensure_playing():
            """Sends "play" again if the bot reconnected to Steam since the
            last one — a reconnect silently stops the game, and an unlock
            without it running looks offline. Waits the reconnect settle
            delay afterwards, like the first "play" of a session."""
            nonlocal log_position
            if not logged_on_since(log_position):
                return
            print(f"Bot reconnected to Steam, starting {game_label} again...")
            log_position = asf_log_position()
            send_command(f"play {appid}")
            time.sleep(RECONNECT_SETTLE_DELAY)

        def advance(i, issued_at):
            """Record achievement i as done and schedule (or end) what's next."""
            nonlocal playing
            progress["last_completed"] = i
            progress["appid"] = appid

            next_i = i + 1
            if next_i < len(achievements) and achievements[next_i]["new_session"]:
                gap = _jitter(achievements[next_i]["delay"])
                progress["next_unlock_at"] = None
                progress["session_ends_at"] = (datetime.now() + timedelta(seconds=gap)).isoformat()
                save_progress(progress_path, progress)
                playing = False
                send_command("resume")
                _schedule_asf_shutdown()
                print(f"Session complete. Next session in {gap // 3600}h {(gap % 3600) // 60}m.")
                next_at = datetime.now() + timedelta(seconds=gap)
                notify(game_label, f"Session {session_index + 1}/{len(session_bounds)} done. "
                              f"Next in {_format_duration(gap)} (at {next_at:%a %H:%M}).")
                return True  # stop the script
            elif next_i < len(achievements):
                progress["next_unlock_at"] = (issued_at + timedelta(seconds=_jitter(achievements[next_i]["delay"]))).isoformat()
            else:
                progress["next_unlock_at"] = None

            save_progress(progress_path, progress)
            return False

        # awaiting_first_unlock (set above): on a brand new profile, the first
        # achievement has no real "previous unlock" to pace a delay from, so
        # it fires immediately instead of waiting out its configured gap.

        i = start_from

        while i < len(achievements):
            ach = achievements[i]

            if awaiting_first_unlock:
                remaining_delay = 0
            else:
                remaining_delay = _jitter(ach["delay"])
                if progress["next_unlock_at"] is not None:
                    unlock_at = datetime.fromisoformat(progress["next_unlock_at"])
                    remaining_delay = max(0, int((unlock_at - datetime.now()).total_seconds()))
                    progress["next_unlock_at"] = None
            awaiting_first_unlock = False

            if remaining_delay > 0:
                print(f"Waiting {remaining_delay}s before unlocking: {ach['id']}...")
                # The last check lands a settle delay before the unlock, so a
                # re-sent "play" and its pause fit inside the wait instead of
                # pushing the unlock later.
                wait_until = time.monotonic() + remaining_delay
                check_until = wait_until - RECONNECT_SETTLE_DELAY
                while (left := check_until - time.monotonic()) > 0:
                    time.sleep(min(left, PLAY_CHECK_INTERVAL))
                    ensure_playing()
                time.sleep(max(0, wait_until - time.monotonic()))

            # Catches a reconnect in the last moments of the wait. Before
            # issued_at, so any pause it adds doesn't shorten the next gap.
            ensure_playing()
            issued_at = datetime.now()

            # Achievements that really unlocked together (delay within
            # SIMULTANEOUS_MAX_DELAY after this one, same session) go out in a
            # single aset, so they share one timestamp instead of drifting a
            # second apart per API call.
            group_end = i + 1
            while (group_end < len(achievements)
                   and not achievements[group_end]["new_session"]
                   and achievements[group_end]["delay"] <= SIMULTANEOUS_MAX_DELAY):
                group_end += 1
            group = achievements[i:group_end]

            # Always wait this achievement's own delay first, then check —
            # so a batch like 1,2,3,4,5,6 with 1,2,5 already unlocked still
            # spends each entry's own configured gap in order, instead of
            # skipping instantly and leaking that entry's delay onto the
            # next one.
            for a in group:
                if unlocked.get(a["id"], False):
                    print(f"Already unlocked, skipping: {a['id']}")
            to_unlock = [a["id"] for a in group if not unlocked.get(a["id"], False)]

            if to_unlock:
                label = ", ".join(str(a) for a in to_unlock)
                status, result = send_aset(appid, to_unlock)

                if status == "unreachable":
                    print(f"ERROR: ArchiSteamFarm isn't reachable at {API_URL} — is it running?")
                    notify(game_label, "Stopped mid-session: ArchiSteamFarm isn't reachable.", error=True)
                    progress["next_unlock_at"] = datetime.now().isoformat()
                    save_progress(progress_path, progress)
                    # "play" was already sent above, so leaving ASF running here
                    # would strand the bot stuck "playing" this game indefinitely.
                    # The API isn't reachable, so there's no graceful way to tell it
                    # to resume/exit — force-kill it directly instead.
                    schedule_asf_kill()
                    return "error"

                if status == "unknown":
                    print(f"ERROR: unexpected response for {label}: {result}")
                    notify(game_label, f"Stopped mid-session: unexpected response for {label}.", error=True)
                    progress["next_unlock_at"] = datetime.now().isoformat()
                    save_progress(progress_path, progress)
                    schedule_asf_kill()
                    return "error"

                if status == "already_unlocked":
                    print(f"Already unlocked, skipping: {label}")
                else:
                    print(f"Unlocked: {label} at [{issued_at:%H:%M:%S}]")

            for gi in range(i, group_end):
                if advance(gi, issued_at):
                    return "session_done"
            i = group_end

        playing = False
        send_command("resume")
        _schedule_asf_shutdown()
        print("\nAll achievements unlocked.")
        notify(game_label, "All achievements unlocked.")
        cleanup_profile(game_name)
        return "all_done"
    except (_Signalled, KeyboardInterrupt) as e:
        # Progress is already on disk (saved after every unlock), so the
        # next run picks up where this one stopped.
        if playing:
            _stop_playing()
        if isinstance(e, _Signalled) and e.signum == signal.SIGHUP:
            notify(game_label, "Stopped: the terminal running it was closed.", error=True)
        else:
            print("\nStopped. Progress is saved — run it again to continue.")
        return "stopped"
    except Exception as e:
        if playing:
            _stop_playing()
        notify(game_label, f"Crashed: {e.__class__.__name__}: {e}", error=True)
        raise
    finally:
        stop_keep_awake(keep_awake_proc)
