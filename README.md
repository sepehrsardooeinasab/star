# STAR

**Steam Timed Achievement Replayer.** Paces out Steam achievement unlocks for a game through [ArchiSteamFarm](https://github.com/JustArchiNET/ArchiSteamFarm) (ASF), spreading them across realistic delays and sessions instead of firing them all at once.

Runs on macOS and Linux (not Windows).

**[Unlock Scheduler](https://sepehrsardooeinasab.github.io/star/)** — paste a SteamHunters achievement export in the browser and it generates a delay/session config for you.

## Install

On macOS or Linux, paste this into a terminal:

```sh
curl -fsSL https://raw.githubusercontent.com/sepehrsardooeinasab/star/main/install.sh | sh
```

It installs the desktop app and ArchiSteamFarm with its achievement plugin (downloaded from their official releases and checked against their published checksums). Then open **STAR** and sign in to Steam; it asks for the Steam Guard code if needed. Python 3.8+ is the only requirement; on macOS, the installer offers to install it if it's missing. Nothing needs `sudo`. It also adds the `runsteamunlocker` command, which you don't need with the app (see [Command line](#command-line)).

- Your games, ArchiSteamFarm and settings live in `~/Library/Application Support/STAR` (macOS) or `~/.local/share/star` (Linux). Updating from before the rename moves them there. Running the command again updates the app and keeps them.
- The code and the page itself ship inside the app on macOS (`STAR.app/Contents/Resources`), and go in `~/.local/lib/star` on Linux or with `--no-app`, kept apart from your data.
- `... | sh -s -- --uninstall` removes the app, the command and the code, and keeps your data. `--no-app` skips the desktop app.
- Downloading the macOS app by hand from Releases instead means macOS asks you to allow it once in **System Settings > Privacy & Security**; the install command avoids that.

Prefer to set everything up yourself? See [Manual setup](#manual-setup) below.

## The app

The app starts on two buttons: **New schedule** and **Run a game**. On first launch it sets up ArchiSteamFarm and signs in to Steam instead.

- Paste an export and check the timeline as on the public page, then **Save to project** writes the config and CSV into the data folder (`jsons/` and `csvs/`).
- The **Settings** tab in the top bar (or **Settings…**, ⌘, / Ctrl+, in the app's menu) shows the installed ArchiSteamFarm and plugin versions with **Check for updates**, the Steam account (**Use another account**), whether keeping the computer awake and notifications work here (**Test keep awake**, **Send a test notification**, and help installing what's missing on Linux), and the data folder (**Show in Finder**). Theme and accent are under the palette button.
- The app checks for a new release when it opens, and from **Check for Updates…** in its menu (the app menu on macOS, **Help** on Linux). **Update now** runs the install command for you: the app closes, updates and opens again. Games waiting between sessions keep going; only a session that's playing has to end first.
- ArchiSteamFarm and its plugin are pinned to versions known to work together, and ASF's own auto-update is turned off so it can't drift from the plugin. When an app update pins newer ones, they're swapped in between sessions, never during one: a session that comes due meanwhile waits a moment for the swap.
- **Schedule** and **Runs** in the top bar switch between making schedules and running them; saving keeps you on Schedule. **Runs** lists every game with its progress, current session and when the next one starts. **Run** plays every remaining session back to back, waiting out the breaks on its own; **Stop** ends it right away (the bot stops playing, progress is kept) and **Stop after this session** lets the current one finish first. Each game's output is shown live, and **Timeline** shows its schedule with what's already unlocked dimmed: **Edit** unlocks the delays still ahead for changing, **Save** writes them back.

Runs are background processes, so closing the app doesn't stop them; open it again any time to see where they are. The app's page is served on `127.0.0.1` only and only accepts requests from itself. The computer has to stay on for a run to continue; it's kept awake while a run is going.

## How it works

1. On **Schedule**, paste a SteamHunters achievement export (or use the public [Unlock Scheduler](https://sepehrsardooeinasab.github.io/star/)), check the sessions and breaks, and **Save to project**: that writes `jsons/config_<name>.json` and its CSV.
2. On **Runs**, press **Run**. It makes sure ArchiSteamFarm is running, then walks the achievement list, calling `aset <appid> <achievement>` through ASF's local API with the configured delays between unlocks and breaks between sessions.
3. Progress is saved to `jsons/progress_<name>.json`, so a run can be stopped and resumed without re-unlocking or losing its place. Once every achievement is unlocked, the game's config and CSV move to `completed/<name>/`.

## Command line

The app covers everyday use. The `runsteamunlocker` command the installer adds runs the same code, and is there for:

- computers without the app (installed with `--no-app`, or a Linux machine with no app build): `runsteamunlocker --ui` opens the same interface in the browser;
- computers without a screen, such as a Linux box reached over SSH;
- when something's wrong: `runsteamunlocker -k` stops ArchiSteamFarm and every running game even if the app won't open, and `--ui-stop` stops a stuck app server;
- a few extras: starting later (`-in 2h`), or printing the next session's timing for scripts (`-t`).

```sh
runsteamunlocker <config-name>      # run the unlocker using jsons/config_<config-name>.json
runsteamunlocker -f <config-name>   # same, but skip the confirmation prompt
runsteamunlocker -w <config-name>   # confirm now, wait until the session can run, then start it
runsteamunlocker --auto <config-name>  # run every remaining session back to back, waiting out the breaks
runsteamunlocker -u / --ui          # open the app in the browser (starts it in the background if needed)
runsteamunlocker --setup            # download ArchiSteamFarm + plugin, write configs, sign in to Steam
runsteamunlocker --ui-stop          # stop the app; games it started keep running
runsteamunlocker -in 2h <config-name>  # confirm now, start in 2h (also 30, 45m, 1h30m)
runsteamunlocker -t <config-name>   # print the next session's wait/duration and exit, without running
runsteamunlocker -s <config-name>   # show achievements from the current session onward (names, done/next)
runsteamunlocker -s <config-name> all  # every session; or a number for just that session
runsteamunlocker -k                 # stop ArchiSteamFarm and any running unlocker session
runsteamunlocker -a / --all         # list available jsons/config_*.json profiles
runsteamunlocker -ls / --status     # every game's next session and when it can run
runsteamunlocker -h                 # help
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

### 2. Generate a config from SteamHunters

- On [SteamHunters](https://steamhunters.com), in settings enable **show hidden achievements**, and prefer showing time in seconds.
- Open the page for the game you own and want achievements unlocked for. Find a player with a legitimate, completed profile for it, and use the default sort (normal in-game achievement order, not grouped).
- Select and copy the achievement list text, from the first achievement through the last.
- Paste it into the [Unlock Scheduler](https://sepehrsardooeinasab.github.io/star/), generate the config, and save the resulting file into `jsons/`.

This step is manual because SteamHunters has no public API for per-player achievement data and blocks automated access (Cloudflare-protected, `robots.txt` disallows crawlers) — the Unlock Scheduler exists specifically to make pasted, human-copied text quick to turn into a config.

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

### Notifications

Runs send a desktop notification when a session finishes, when every achievement is done, and when a run stops unexpectedly: an ASF error, a crash, or the terminal being closed. Stopping it yourself with Ctrl-C or `-k` doesn't send one. Notifications never affect a run. If no notification tool is available, they're skipped.

- **macOS:** nothing to install. With the app (3.0.4 or later), notifications come from **STAR**, with its icon; it asks for permission the first time it opens. "Done" notifications remove themselves after 30 minutes, while errors stay until you dismiss them. Without the app, or until it's allowed, the built-in notifications are used instead: they're shown as coming from **Script Editor** (allow it in System Settings → Notifications if nothing appears) and errors get their own sound. (terminal-notifier isn't used any more: its notifications don't show on current macOS.)
- **Linux:** needs `notify-send`. Install `libnotify-bin` on Debian/Ubuntu, or `libnotify` on Fedora/Arch. Errors are marked critical. "Done" notifications ask to expire after 30 minutes, though some desktops (e.g. GNOME) ignore that. Sounds depend on your desktop.

### Keeping the system awake

While a session runs (including any `-w` / `-in` wait before it), the unlocker keeps the computer from sleeping so delays aren't stretched by a suspended machine.

- **macOS:** uses the built-in `caffeinate`. Nothing to install.
- **Linux:** uses `systemd-inhibit` (part of systemd) to hold a sleep/idle inhibitor. If it's missing or can't take the inhibitor (e.g. no logind session), the run goes ahead without it. Closing a laptop lid may still suspend it, depending on your desktop's lid settings.

### Settings (optional)

The defaults work with the setup above. To change any of them, copy `settings.example.json` to `settings.json` (gitignored) and keep only the keys you want to change. An unknown key or a wrong type stops the unlocker with an error, so a typo never quietly falls back to a default.

| Key | Default | What it does |
| --- | --- | --- |
| `asf_port` | `1243` | Port ASF's IPC listens on. Must match `IPC.config`. |
| `ipc_password` | `null` | ASF's `IPCPassword` from `ASF.json`, if you set one. |
| `ui_port` | `8788` | Port of the local app (`--ui`), at `http://127.0.0.1:<port>`. |
| `bot_connect_timeout` | `60` | Seconds a command keeps retrying while ASF starts or the bot connects to Steam. |
| `warm_settle_delay` | `10` | Seconds between `play` and the first unlock when the bot was already connected. |
| `reconnect_settle_delay` | `60` | The same pause after a fresh (re)connect. Shorter values have produced offline-looking timestamps. |
| `play_check_interval` | `900` | How often (seconds) a session checks whether the bot reconnected to Steam, which drops the game it was playing. It's also checked before every unlock; when it happened, `play` is sent again. |
| `simultaneous_max_delay` | `1` | Unlocks this many seconds apart or less are sent together in a single `aset`. |
| `asf_shutdown_delay` | `300` | Seconds after a session ends before ASF is shut down, if it's idle. |
| `stop_other_asf` | `true` | Stops other ArchiSteamFarm installs on this machine when a session starts, since Steam allows only one login per account. Turn it off if they use other accounts (e.g. a card-farming install). Either way, they're listed before you confirm. |
| `jitter_enabled` | `false` | Turns on randomness, so a run doesn't replay the source player's timings to the second. |
| `jitter_min_delay` | `60` | Only delays longer than this many seconds get randomness. Shorter ones are kept exact. |
| `jitter_percent` | `10` | How far a delay can move, in either direction, as a percentage of itself (0–100). With the defaults, a 10-minute delay becomes anywhere from 9 to 11 minutes. |

With randomness on, it applies to the delays between achievements and to the gaps between sessions. The random value is picked when that delay is scheduled and saved with your progress, so stopping and resuming doesn't pick a new one. Unlocks that happened together in the source data (see `simultaneous_max_delay`) are still sent together. Estimates such as `-t`, `-ls` and the session length shown before you confirm still use the config's exact values.

### Safety checks

- **Config check:** before anything else, the config is checked for a valid `appid` and, on every achievement, a whole-number `id` (no duplicates), a `delay` of 0 or more and a true/false `new_session`. A broken config stops with a list of what's wrong, instead of failing partway through a session.
- **Config changed:** progress is saved as a position in the config's achievement list, together with a fingerprint of that list's order. If the order changes later (e.g. you regenerate the config from another player), you're asked before continuing, and `-f` refuses. Editing delays or session breaks doesn't count as a change. `-ls` and `-s` show the same warning.
- **One run at a time:** the same game can't run twice at once. While a session is talking to ASF, other games wait too, since ASF can only play one game at a time. Running another game then is refused, while `-w` / `-in` wait for the first session to finish. `-ls` shows a running game as `running now`. A game running with `--auto` (or from the app) is locked for its whole run, breaks included. The locks are released automatically when a run exits, even if it's killed.
- **Safe progress saves:** progress is written to a temporary file and then swapped in, so stopping a run mid-save can't corrupt it.

## Layout

- `unlocker/` — the Python package that drives unlocking:
  - `runner.py` — the unlock loop: delays, session breaks, resuming from saved progress
  - `api.py` — talks to ArchiSteamFarm's local Web API (`aset`, `play`, `reset`)
  - `state.py` — reads/writes `jsons/config_*.json` and `jsons/progress_*.json`
  - `settings.py` — defaults for `settings.json` and its validation
  - `server.py` — the local app (`--ui`): serves `docs/` and the API it uses to save configs and start, stop and follow runs
  - `asf_setup.py` — first-run setup: downloads ArchiSteamFarm and the plugin (and updates them to the pinned versions), writes their configs, signs in to Steam
  - `updates.py` — checks GitHub for a newer release and updates by running the install script again
  - `paths.py` — where the code and the data live (`UNLOCKER_HOME`)
  - `run_unlocker.py` — entry point for runs, the app's server and the command line
- `runsteamunlocker` — bash launcher: starts ArchiSteamFarm if needed, then runs the unlocker for a given config
- `runsteamunlocker.zsh-completion` — tab-completion for available configs
- `docs/` — the Unlock Scheduler web page (published via GitHub Pages, and the app's interface)
- `app/` — the desktop app (Tauri): a window that starts the local server and shows the page
- `install.sh` — the one-line installer; `.github/workflows/release.yml` builds the app for each `v*` tag
- `tools/check_asf_pins.py` — says whether a newer ArchiSteamFarm + plugin pair can replace the pinned one (the newest ASF in the series the latest plugin is built against); `.github/workflows/asf-versions.yml` runs it weekly and fails when the pins should be bumped
- `jsons/`, `csvs/`, `archifarm/` — per-machine runtime data (ASF install, bot credentials, generated configs); gitignored, not part of the repo
- `completed/` — finished games: each game's config and CSV are moved to `completed/<name>/` once every achievement is unlocked (gitignored)

## Disclaimer

This doesn't violate Steam's own terms of service, but it does violate the rules of achievement-tracking/ranking sites (e.g. SteamHunters) that expect achievements to reflect legitimate play. Use at your own risk.
