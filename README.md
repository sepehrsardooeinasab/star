# STAR

**Steam Timed Achievement Replayer.** Replays a real player's achievement timeline on your Steam account: the same achievements, in the same order, with the same gaps between them and the same play sessions and breaks. The unlocking itself goes through [ArchiSteamFarm](https://github.com/JustArchiNET/ArchiSteamFarm) (ASF) and its [ASFAchievementManager](https://github.com/CatPoweredPlugins/ASFAchievementManager) plugin.

A desktop app for macOS and Linux (not Windows). **[Website](https://sepehrsardooeinasab.github.io/star/)**: how it works and how to use it. Without the desktop app, `runsteamunlocker --ui` opens the same app in your browser.

## Install

On macOS or Linux, paste this into a terminal:

```sh
curl -fsSL https://raw.githubusercontent.com/sepehrsardooeinasab/star/main/install.sh | sh
```

It installs the **STAR** app and ArchiSteamFarm with its achievement plugin (from their official releases, checked against their published checksums). Open STAR and sign in to Steam; it asks for the Steam Guard code if needed.

- Python 3.8+ is the only requirement. On macOS, the installer offers to install it if it's missing. Nothing needs `sudo`.
- STAR updates itself: when a new release is out, it installs it once no game is in a session, closing and reopening the app. **Check for Updates…** or running the same command again does it right away. Your games and settings are kept.
- `... | sh -s -- --uninstall` removes the app and keeps your data.
- Downloading the macOS app by hand from Releases instead means macOS asks you to allow it once in **System Settings → Privacy & Security**; the install command avoids that.

## Using the app

Open STAR and sign in to Steam. The title bar switches between **Schedule**, **Runs**, **Library** and **Settings** (or the **Go** menu, ⌘1 to ⌘3; Settings is ⌘,). **Library** shows your achievements from Steam, newest first, and your games with their achievement progress; games marked Private or hidden in Steam are faded and marked.

### 1. Make a schedule

Paste into **Schedule** either:

- **A link** to a player's achievements for the game, from SteamHunters (`steamhunters.com/id/<player>/apps/<appid>/achievements`) or Steam (`steamcommunity.com/id/<player>/achievements/<appid>`). Older Steam `/stats/<appid>` links also work. The exact unlock times come straight from Steam, so the player's profile must be public.
- **The page itself**: on SteamHunters, open the player's achievements for the game, select the whole page (⌘A / Ctrl+A), copy and paste. Turn on **Show hidden achievements** in SteamHunters' settings first, or hidden ones come without a name. Any sort or grouping works.

The game's name and App ID fill themselves in where they can. The sessions table beside the paste shows each session's achievements, length and the break before it; **Full timeline** shows every achievement, where breaks can be added or removed and delays changed. **Options** holds the session rules. Then **Save**.

To unlock an achievement, the plugin needs its number in the game (`aset <appid> <number>`). The app asks ArchiSteamFarm for the game's list and matches each achievement by name. Where a game reuses a name (Bongo Cat has four "Item Collector"s), it tells them apart by description; it warns when names repeat, and stops rather than guess when ArchiSteamFarm and Steam disagree.

### 2. Run it

On **Runs**, pick a game in the list and press **Run** (or **Continue**) in the title bar:

- **1 session** plays the game's next session, first waiting for its break to end if needed. **All sessions** plays every remaining session back to back, waiting out the breaks.
- **When ready** can be changed to start in 30 minutes up to 4 hours, or **Other…** for any time (`45m`, `1h30m`, or a clock time like `23:30`).
- While it runs, the same button is **Stop** (the bot stops playing, progress is kept), and **1 session** / **All sessions** switches between stopping after the current session and playing on.
- **One game runs at a time.** The running game is pinned to the top of the list; games still in their break are dimmed with a clock.

The selected game shows a summary (session, this session's length, unlocked so far, when it can play), its sessions with the current one marked, and its activity log as it runs. The arrow at the end of the summary shows its App ID and where it was copied from. **Full timeline** lists every achievement; open its **lock** to change the delays still ahead, then **Save**.

Runs keep going when the window is closed; open the app any time to see where they are. The computer has to stay on, and it's kept awake while a run is going.

### 3. Settings

**Settings** (⌘,) shows the ArchiSteamFarm and plugin versions with **Check for updates**, the Steam account (**Use another account**), a switch (and a test) for keeping the computer awake, whether finished games are listed in Runs, the **Advanced run settings**, and the data folder (**Show in Finder**). Theme and accent are under the palette button.

ArchiSteamFarm and the plugin are pinned to versions known to work together, and ASF's own auto-update is off so it can't drift from the plugin. **Check for updates** offers the newest ASF in the series the latest plugin is built for; newer series need a new plugin first. Updates are swapped in between sessions, never during one.

## Good to know

- **Your data** (schedules, progress, finished games, ArchiSteamFarm, settings) lives in `~/Library/Application Support/STAR` (macOS) or `~/.local/share/star` (Linux). Copy it to back up or move to another computer. Finished games move to `completed/` inside it.
- **Keeping awake:** macOS uses the built-in `caffeinate`; Linux uses `systemd-inhibit`, and a closed laptop lid may still suspend it, depending on your desktop.
- **Privacy:** the app's page is served on `127.0.0.1` only, and only answers the app itself. Your Steam login is saved only in ArchiSteamFarm's own config on this computer.

## Command line

The installer also adds `runsteamunlocker`, which runs the same code. You don't need it with the app; it's there for computers without a screen (a Linux box over SSH), installs without the app (the installer's `--no-app`; `--ui` then opens the interface in the browser), or when something's wrong (`-k` stops ArchiSteamFarm and every run, `--ui-stop` stops a stuck app server). Games are named by their file name (`jsons/config_<name>.json`).

```sh
runsteamunlocker <config-name>         # run the game's next session (jsons/config_<config-name>.json), after asking
runsteamunlocker -f <config-name>      # same, without asking
runsteamunlocker -w <config-name>      # confirm now, wait until the session can run, then start it
runsteamunlocker -in 2h <config-name>  # confirm now, start in 2h (also 30, 45m, 1h30m)
runsteamunlocker --auto <config-name>  # every remaining session back to back, waiting out the breaks (-in works here too)
runsteamunlocker -t <config-name>      # print the next session's wait and length, without running
runsteamunlocker -s <config-name>      # achievements from the current session on (names, done / next)
runsteamunlocker -s <config-name> all  # every session; or a number for just that session
runsteamunlocker -ls / --status        # every game's next session and when it can run
runsteamunlocker -a / --all            # list the saved games (jsons/config_*.json)
runsteamunlocker -u / --ui             # open the app in the browser (starts its server if needed)
runsteamunlocker --ui-stop             # stop the app's server; games it started keep running
runsteamunlocker --setup               # download ArchiSteamFarm + plugin, write configs, sign in to Steam
runsteamunlocker -k                    # stop ArchiSteamFarm and any running session
runsteamunlocker -h                    # help
```

## Manual setup

Only needed without the install command, e.g. when running straight from a clone of this repository.

### 1. ArchiSteamFarm + achievement plugin

`aset` is not a built-in ASF command — it's provided by the [ASFAchievementManager](https://github.com/CatPoweredPlugins/ASFAchievementManager) plugin.

- Download and set up [ArchiSteamFarm](https://github.com/JustArchiNET/ArchiSteamFarm).
- Download [ASFAchievementManager](https://github.com/CatPoweredPlugins/ASFAchievementManager) and drop it into ASF's `plugins/` folder.
- Create a bot following ASF's own setup instructions. ASF supports running multiple bots, but this project only assumes a single one (`bot1`) — unlocking achievements on your own account doesn't need more.
- **Required:** create `archifarm/config/IPC.config` so ASF's local API listens on port `1243` — the port the unlocker talks to by default (changeable with `asf_port` in [Settings](#settings-optional)), not ASF's default `1242`. This keeps it off the default port so it can't collide with any other ASF instance you might run (e.g. one used for card farming); the unlocker won't be able to reach ASF at all without it.
  ```json
  {
      "Kestrel": {
          "Endpoints": {
              "HTTP4": { "Url": "http://127.0.0.1:1243" },
              "HTTP6": { "Url": "http://[::1]:1243" }
          }
      }
  }
  ```
- For steadier performance, tweak the configs:
  - In the bot's config (`archifarm/config/bot1.json`), set `"FarmingEnabled": false` to stop card farming.
  - In `archifarm/config/ASF.json`, set `"AutoRestart": false` to stop ASF from auto-restarting, and `"Headless": true` so it never blocks on an interactive prompt when `runsteamunlocker` starts it in the background.

### 2. Make a schedule

- On [SteamHunters](https://steamhunters.com), in settings enable **show hidden achievements**, and show times with seconds.
- Open the achievements of a player with a legitimate, completed profile for the game, in the default sort (the game's own order, not grouped). The app accepts any sort, or just the page's link.
- Select the whole page, copy it, and paste it into Schedule in STAR (`runsteamunlocker --ui` opens it in your browser). Save saves the config into `jsons/`.

This step is manual because SteamHunters has no public API for per-player achievement data and blocks automated access (Cloudflare-protected, `robots.txt` disallows crawlers) — the schedule builder exists specifically to make pasted, human-copied text quick to turn into a config.

### 3. Python

Python 3 is required. The unlocker only uses the standard library — no extra packages to install.

### 4. Shell integration

Add the launcher to your `PATH` and (if you use zsh) source the completion script:

```sh
export PATH="/path/to/star:$PATH"
source "/path/to/star/runsteamunlocker.zsh-completion"
```

Put these lines in `~/.zshrc` — or, if you use oh-my-zsh, in a file under `~/.oh-my-zsh/custom/` instead, since anything there is auto-sourced. The completion script is zsh-specific; skip the `source` line under bash.

## Details

### Settings (optional)

In the app, **Settings** has the keep-awake and update switches and **Advanced run settings** for most of these; it saves them to `settings.json` in the data folder, keeping only what differs from the defaults. The ports and the IPC password are set in that file directly, since they have to match ArchiSteamFarm's own config. Running from a clone, `settings.json` goes in the project folder (gitignored); `settings.example.json` lists every key. An unknown key or a wrong type stops the unlocker with an error, so a typo never quietly falls back to a default.

| Key | Default | What it does |
| --- | --- | --- |
| `asf_port` | `1243` | Port ASF's IPC listens on. Must match `IPC.config`. |
| `ipc_password` | `null` | ASF's `IPCPassword` from `ASF.json`, if you set one. |
| `ui_port` | `8788` | Port of the local app (`--ui`), at `http://127.0.0.1:<port>`. |
| `bot_connect_timeout` | `60` | Seconds a command keeps retrying while ASF starts or the bot connects to Steam. |
| `warm_settle_delay` | `10` | Seconds between `play` and the first unlock when the bot was already connected. |
| `reconnect_settle_delay` | `60` | The same pause after a fresh (re)connect. Shorter values have produced offline-looking timestamps. |
| `play_check_interval` | `30` | How often (seconds) a session checks whether the bot reconnected to Steam, which drops the game it was playing. Only ASF's log is read, so it can be often. It's also checked before every unlock; when it happened, `play` is sent again. |
| `simultaneous_max_delay` | `1` | Unlocks this many seconds apart or less are sent together in a single `aset`. |
| `asf_shutdown_delay` | `300` | Seconds after a session ends before ASF is shut down, if it's idle. |
| `run_logs_kept` | `3` | How many of a game's runs its log keeps (Runs shows them, up to 1 MB). Each run starts with a "Started" line. |
| `stop_other_asf` | `true` | Stops other ArchiSteamFarm installs on this machine when a session starts, since Steam allows only one login per account. Turn it off if they use other accounts (e.g. a card-farming install). Either way, they're listed before you confirm. |
| `jitter_enabled` | `false` | Turns on randomness, so a run doesn't replay the source player's timings to the second. |
| `jitter_min_delay` | `60` | Only delays longer than this many seconds get randomness. Shorter ones are kept exact. |
| `jitter_percent` | `10` | How far a delay can move, in either direction, as a percentage of itself (0–100). With the defaults, a 10-minute delay becomes anywhere from 9 to 11 minutes. |
| `keep_awake` | `true` | Keeps the computer from sleeping while a run waits or plays. |
| `break_wait` | `"6h"` | How long before a break ends **Continue** can start a session; the run then waits out the rest of the break without touching Steam: `"off"` (only once it's playable), `"1h"`, `"3h"`, `"6h"`, `"12h"` or `"24h"`. Set it in Settings → Run settings. |
| `show_finished` | `false` | Lists finished games in the app's Runs (at the bottom). |
| `steam_api_key` | `null` | A [Steam Web API key](https://steamcommunity.com/dev/apikey), so the app's **Library** covers every game you play, not just the games in STAR. Set it in Settings → Library. |
| `clock` | `"system"` | How the app writes times: `"12h"` (2:30 PM) or `"24h"` (14:30). Until one's set (`"system"`), the usual one for the computer's language. Set it in Settings → Clock. |
| `theme`, `accent` | `"dark"`, `"violet"` | The app's look, from its Appearance menu: `"dark"` or `"light"`; `"violet"`, `"wine"`, `"blue"`, `"teal"` or `"amber"`. |
| `unlocks_range` | `"month"` | How far back the app's **Library** lists achievements: today (`"day"`), this week, this month, this year, or `"all"`. Set it in Settings → Library. |
| `week_start` | `"monday"` | The day **Library**'s Week starts on: `"monday"`, `"sunday"` or `"saturday"`. Set it in Settings → Library. |
| `library_tab` | `"achievements"` | Which section **Library** opens on: `"achievements"` or `"games"`. |
| `library_check` | `"6h"` | How often **Library** checks Steam for new games and achievements, in the background, at set times of day counted from midnight (`"6h"`: 12 AM, 6 AM, 12 PM, 6 PM; a check older than the latest of them is made up at once): `"1h"`, `"3h"`, `"6h"`, `"12h"`, `"24h"`, or `"manual"` (only on Refresh). Set it in Settings → Library. |
| `achievement_sort`, `achievement_order`, `achievement_group` | `"date"`, `"desc"`, `"status"` | How a game's page in **Library** lists its achievements: in Steam's own order (`"default"`, as ArchiSteamFarm's `alist` lists them), by `"date"` unlocked or `"name"`; `"desc"` (reversed, newest, Z–A) or `"asc"`; grouped into unlocked and locked (`"status"`) or not (`"none"`). Set it in Settings → Library. |
| `library_active`, `library_finished`, `library_private`, `library_no_achievements` | `"show"` each | Which games **Library**'s Games lists, by group, each `"show"` or `"hide"`: those you marked finished on their page, those marked Private in Steam, those without achievements, and the rest (`library_active`). A game shows when any group it's in is shown. Set it in Settings → Library, or for a while in Games' Filters. |
| `hidden_descriptions` | `"unlocked"` | When **Library** shows a hidden achievement's description: `"unlocked"` (once you've unlocked it), `"all"` or `"none"`. Set it in Settings → Library. |
| `library_sort`, `library_order` | `"played"`, `"desc"` | How **Library**'s Games are sorted: `"played"` (last played), `"achievement"` (last achievement), `"name"`, `"progress"` or `"playtime"`; `"desc"` (newest, Z–A, most first) or `"asc"`. Set it in Settings → Library. |

With randomness on, it applies to the delays between achievements and to the gaps between sessions. The random value is picked when that delay is scheduled and saved with your progress, so stopping and resuming doesn't pick a new one. Unlocks that happened together in the source data (see `simultaneous_max_delay`) are still sent together. Estimates such as `-t`, `-ls` and the session length shown before you confirm still use the config's exact values.

### Safety checks

- **Config check:** before anything else, the config is checked for a valid `appid` and, on every achievement, a whole-number `id` (no duplicates), a `delay` of 0 or more and a true/false `new_session`. A broken config stops with a list of what's wrong, instead of failing partway through a session.
- **Config changed:** progress is saved as a position in the config's achievement list, together with a fingerprint of that list's order. If the order changes later (e.g. you regenerate the config from another player), you're asked before continuing, and `-f` refuses. Editing delays or session breaks doesn't count as a change. `-ls` and `-s` show the same warning.
- **One game at a time:** while a game is running, breaks included, starting any other game (or the same one again) is refused until it's stopped or finished. The locks are released automatically when a run exits, even if it's killed.
- **Safe progress saves:** progress is written to a temporary file and then swapped in, so stopping a run mid-save can't corrupt it.

## Layout

- `unlocker/` — the Python package that drives unlocking:
  - `runner.py` — the unlock loop: delays, session breaks, resuming from saved progress
  - `api.py` — talks to ArchiSteamFarm's local Web API (`aset`, `play`, `reset`)
  - `state.py` — reads/writes `jsons/config_*.json` and `jsons/progress_*.json`, and the locks that keep one game running at a time
  - `timeline.py` — `-s`: a game's achievements session by session
  - `extras.py` — what keeps the computer awake on this system, and its test
  - `settings.py` — defaults for `settings.json` and its validation
  - `server.py` — the local app (`--ui`): serves `docs/app.html` and the API it uses to save configs and start, stop and follow runs
  - `achievements.py` — the builder's achievement numbers (from the plugin's `alist`, matched with Steam's public stats) and reading a player's achievements from a link
  - `asf_setup.py` — first-run setup: downloads ArchiSteamFarm and the plugin (and updates them to the pinned versions), writes their configs, signs in to Steam
  - `updates.py` — checks GitHub for a newer release and updates by running the install script again
  - `paths.py` — where the code and the data live (`UNLOCKER_HOME`)
  - `run_unlocker.py` — entry point for runs, the app's server and the command line
- `runsteamunlocker` — bash launcher: starts ArchiSteamFarm if needed, then runs the unlocker for a given config
- `runsteamunlocker.zsh-completion` — tab-completion for available configs
- `docs/` — published via GitHub Pages: `index.html` is the website, `app.html` the app's interface (opened on the website, it goes to the website)
- `app/` — the desktop app (Tauri): a window that starts the local server and shows the page
- `install.sh` — the one-line installer; `.github/workflows/release.yml` builds the app for each `v*` tag
- `tools/check_asf_pins.py` — says whether a newer ArchiSteamFarm + plugin pair can replace the pinned one (the newest ASF in the series the latest plugin is built against); `.github/workflows/asf-versions.yml` runs it weekly and fails when the pins should be bumped
- `jsons/`, `csvs/`, `archifarm/` — per-machine data (schedules, progress, ASF install, bot credentials), in the data folder (the project folder when run from a clone; gitignored)
- `completed/` — finished games: each game's config and CSV are moved to `completed/<name>/` once every achievement is unlocked (gitignored)

## Disclaimer

This doesn't violate Steam's own terms of service, but it does violate the rules of achievement-tracking/ranking sites (e.g. SteamHunters) that expect achievements to reflect legitimate play. Use at your own risk.
