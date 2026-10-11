#!/bin/sh
# STAR (Steam Timed Achievement Replayer) installer, for macOS and Linux:
#
#   curl -fsSL https://raw.githubusercontent.com/sepehrsardooeinasab/star/main/install.sh | sh
#
# Installs the desktop app, the `runsteamunlocker` command, and
# ArchiSteamFarm with its achievement plugin. The code and page ship inside
# the app on macOS and go in ~/.local/lib/star otherwise;
# your games, ArchiSteamFarm and settings live in a separate data folder.
# Nothing needs sudo. Running it again updates everything and keeps your data.
#
# Options, passed as `... | sh -s -- <options>`:
#   --ref <tag|branch>  install that version instead of the latest release
#   --no-app            skip the desktop app (use `runsteamunlocker --ui`)
#   --uninstall         remove the app, the command and the code; your
#                       games, ArchiSteamFarm and settings are kept
#   --source <dir>      install the code from a local folder (for testing)
#   --app-file <path>   install the app from a local .app, .dmg or .AppImage
#   --reopen            (used by the app's Check for Updates) close the app
#                       while it's replaced and open it again afterwards, or
#                       restart the page's server when there's no app
set -eu

REPO="sepehrsardooeinasab/star"
APP_NAME="STAR"
# Its name before 3.04: that app is replaced, and its data folder kept.
OLD_APP_NAME="Steam Auto Unlocker"

say() { printf '\033[1m==>\033[0m %s\n' "$*"; }
note() { printf '    %s\n' "$*"; }
fail() { printf '\033[31mError:\033[0m %s\n' "$*" >&2; exit 1; }

REF="" NO_APP=0 UNINSTALL=0 SOURCE="" APP_FILE="" REOPEN=0
while [ $# -gt 0 ]; do
    case "$1" in
        --ref) REF="${2:?--ref needs a tag or branch}"; shift 2 ;;
        --no-app) NO_APP=1; shift ;;
        --uninstall) UNINSTALL=1; shift ;;
        --source) SOURCE="${2:?--source needs a folder}"; shift 2 ;;
        --app-file) APP_FILE="${2:?--app-file needs a path}"; shift 2 ;;
        --reopen) REOPEN=1; shift ;;
        *) fail "Unknown option: $1" ;;
    esac
done

OS=$(uname -s)
ARCH=$(uname -m)
case "$OS" in
    Darwin) DATA_ROOT="$HOME/Library/Application Support" HOME_NAME="$APP_NAME" OLD_HOME_NAME="$OLD_APP_NAME" ;;
    Linux) DATA_ROOT="${XDG_DATA_HOME:-$HOME/.local/share}" HOME_NAME=star OLD_HOME_NAME=steam-auto-unlocker ;;
    *) fail "Only macOS and Linux are supported." ;;
esac
HOME_DIR="${UNLOCKER_HOME:-$DATA_ROOT/$HOME_NAME}"
# Data from before the rename moves to the new folder. The old path is left
# as a link to it, so games still running from before keep writing to it.
OLD_HOME_DIR="$DATA_ROOT/$OLD_HOME_NAME"
if [ -z "${UNLOCKER_HOME:-}" ] && [ -d "$OLD_HOME_DIR" ] && [ ! -L "$OLD_HOME_DIR" ] && [ ! -e "$HOME_DIR" ]; then
    mv "$OLD_HOME_DIR" "$HOME_DIR" && ln -s "$HOME_DIR" "$OLD_HOME_DIR"
fi
BIN_DIR="${BIN_DIR:-$HOME/.local/bin}"
# The code when it isn't inside the app (Linux, or --no-app). The Linux app
# looks for it here too, so it stays put however the app is opened.
LIB_DIR="${UNLOCKER_CODE:-$HOME/.local/lib/star}"
OLD_LIB_DIR="$HOME/.local/lib/steam-auto-unlocker"  # before the rename
DESKTOP_FILE="${XDG_DATA_HOME:-$HOME/.local/share}/applications/star.desktop"
OLD_DESKTOP_FILE="${XDG_DATA_HOME:-$HOME/.local/share}/applications/steam-auto-unlocker.desktop"

mac_app_dir() {
    if [ -n "${APP_DIR:-}" ]; then
        echo "$APP_DIR"
    elif [ -d "/Applications/$APP_NAME.app" ] || [ -d "/Applications/$OLD_APP_NAME.app" ] || [ -w /Applications ]; then
        echo /Applications
    else
        echo "$HOME/Applications"
    fi
}

if [ "$UNINSTALL" -eq 1 ]; then
    say "Uninstalling"
    rm -f "$BIN_DIR/runsteamunlocker"
    rm -rf "$LIB_DIR" "$OLD_LIB_DIR" "$HOME_DIR/app" "$HOME_DIR/python-path"
    if [ "$OS" = Darwin ]; then
        rm -rf "$(mac_app_dir)/$APP_NAME.app" "$(mac_app_dir)/$OLD_APP_NAME.app"
    else
        rm -f "$HOME_DIR/$APP_NAME.AppImage" "$HOME_DIR/$OLD_APP_NAME.AppImage" "$DESKTOP_FILE" "$OLD_DESKTOP_FILE"
    fi
    note "Kept your games, ArchiSteamFarm and settings in: $HOME_DIR"
    note "Delete that folder too to remove everything."
    exit 0
fi

# ---- Python 3.8+ ----------------------------------------------------------
PY=$(command -v python3 || true)
if [ "$OS" = Darwin ] && [ "$PY" = /usr/bin/python3 ] && ! xcode-select -p >/dev/null 2>&1; then
    # /usr/bin/python3 is only a placeholder until the developer tools are in.
    say "Python 3 is needed. macOS will now offer to install it (Command Line Tools)."
    xcode-select --install >/dev/null 2>&1 || true
    fail "Once that finishes, run this install command again."
fi
[ -n "$PY" ] || fail "Python 3 is needed. Install it with your package manager (e.g. sudo apt install python3), then run this again."
"$PY" -c 'import sys; sys.exit(sys.version_info < (3, 8))' || fail "Python 3.8 or newer is needed ($PY is older)."
command -v curl >/dev/null || fail "curl is needed."

# With --reopen: the app, once this script closed it, opens again however
# the script ends (the new app, or the old one if replacing it failed).
APP_CLOSED=0
quit_app() {  # its games are separate processes and keep running
    [ "$REOPEN" -eq 1 ] || return 0
    if [ "$OS" = Darwin ]; then
        pkill -f "/($APP_NAME|$OLD_APP_NAME).app/Contents/MacOS/" && APP_CLOSED=1
    else
        # The AppImage's launcher, and the app it runs from its mount.
        pkill -f "$HOME_DIR/($APP_NAME|$OLD_APP_NAME).AppImage|/usr/bin/(star|steam-auto-unlocker)" && APP_CLOSED=1
    fi
    [ "$APP_CLOSED" -eq 0 ] || sleep 1
}
reopen_app() {
    if [ "$OS" = Darwin ] && [ -d "$(mac_app_dir)/$APP_NAME.app" ]; then
        open "$(mac_app_dir)/$APP_NAME.app"
    elif [ "$OS" = Linux ] && [ -x "$HOME_DIR/$APP_NAME.AppImage" ]; then
        nohup "$HOME_DIR/$APP_NAME.AppImage" >/dev/null 2>&1 &
    fi
}

TMP=$(mktemp -d)
cleanup() {
    rm -rf "$TMP"
    if [ "$APP_CLOSED" -eq 1 ]; then reopen_app; fi
}
trap cleanup EXIT
trap 'exit 1' INT TERM

# ---- Version ----------------------------------------------------------------
RELEASE_JSON="$TMP/release.json"
if [ -z "$REF" ] && [ -z "$SOURCE" ]; then
    if curl -fsSL "https://api.github.com/repos/$REPO/releases/latest" -o "$RELEASE_JSON" 2>/dev/null; then
        REF=$("$PY" -c 'import json,sys; print(json.load(open(sys.argv[1]))["tag_name"])' "$RELEASE_JSON")
    else
        REF=main
        rm -f "$RELEASE_JSON"
    fi
elif [ -n "$REF" ]; then
    curl -fsSL "https://api.github.com/repos/$REPO/releases/tags/$REF" -o "$RELEASE_JSON" 2>/dev/null \
        || rm -f "$RELEASE_JSON"
fi

# ---- Download ---------------------------------------------------------------
mkdir -p "$HOME_DIR"
if [ -n "$SOURCE" ]; then
    say "Installing the code from $SOURCE"
    SRC="$SOURCE"
else
    say "Downloading STAR ($REF)"
    curl -fsSL "https://github.com/$REPO/archive/$REF.tar.gz" | tar -xz -C "$TMP" \
        || fail "Couldn't download version $REF."
    SRC=$(find "$TMP" -mindepth 1 -maxdepth 1 -type d | head -n 1)  # <repo>-<version>
    # A release from before this installer existed can't be set up by it
    # (e.g. while the newest release is still being built): use main.
    if [ -n "$SRC" ] && [ ! -f "$SRC/unlocker/asf_setup.py" ] && [ "$REF" != main ]; then
        note "$REF is older than this installer; installing the latest code (main) instead."
        rm -rf "$SRC" "$RELEASE_JSON"
        REF=main
        curl -fsSL "https://github.com/$REPO/archive/$REF.tar.gz" | tar -xz -C "$TMP" \
            || fail "Couldn't download version $REF."
        SRC=$(find "$TMP" -mindepth 1 -maxdepth 1 -type d | head -n 1)  # <repo>-<version>
    fi
fi
[ -f "$SRC/unlocker/run_unlocker.py" ] || fail "$SRC doesn't look like STAR."

# A running app server would keep serving the old code. It may be any
# earlier install's: inside the app, in LIB_DIR, or (before 3.01) the data
# folder's app/.
for old in "$(mac_app_dir)/$APP_NAME.app/Contents/Resources" "$(mac_app_dir)/$OLD_APP_NAME.app/Contents/Resources" \
           "$LIB_DIR" "$OLD_LIB_DIR" "$HOME_DIR/app"; do
    if [ -f "$old/unlocker/run_unlocker.py" ]; then
        UNLOCKER_HOME="$HOME_DIR" PYTHONDONTWRITEBYTECODE=1 \
            "$PY" "$old/unlocker/run_unlocker.py" --ui-stop >/dev/null 2>&1 || true
    fi
done

# ---- Desktop app ------------------------------------------------------------
asset_url() {  # first release asset whose name ends with one of the suffixes
    [ -f "$RELEASE_JSON" ] || return 0
    "$PY" - "$RELEASE_JSON" "$@" <<'PYEOF'
import json, sys
assets = json.load(open(sys.argv[1])).get("assets", [])
for suffix in sys.argv[2:]:
    for a in assets:
        if a["name"].endswith(suffix):
            print(a["browser_download_url"])
            raise SystemExit
PYEOF
}

install_mac_app() {  # $1: a .app folder or a .dmg
    dest=$(mac_app_dir)
    mkdir -p "$dest"
    quit_app
    case "$1" in
        *.dmg)
            # hdiutil's output (including deprecation warnings on newer
            # macOS) is noise here; failure is still caught.
            hdiutil attach -nobrowse -readonly -mountpoint "$TMP/dmg" "$1" >/dev/null 2>&1 \
                || fail "Couldn't open the downloaded app ($1)."
            app=$(find "$TMP/dmg" -maxdepth 1 -name '*.app' | head -n 1)
            [ -n "$app" ] || fail "The downloaded disk image has no app in it."
            rm -rf "$dest/$APP_NAME.app"
            cp -R "$app" "$dest/$APP_NAME.app"
            hdiutil detach "$TMP/dmg" >/dev/null 2>&1 || true
            ;;
        *)
            rm -rf "$dest/$APP_NAME.app"
            cp -R "$1" "$dest/$APP_NAME.app"
            ;;
    esac
    # The app before its rename: here, and (unless APP_DIR picked a folder)
    # in the other usual place.
    rm -rf "$dest/$OLD_APP_NAME.app"
    if [ -z "${APP_DIR:-}" ]; then
        rm -rf "/Applications/$OLD_APP_NAME.app" "$HOME/Applications/$OLD_APP_NAME.app" 2>/dev/null || true
    fi
    APP_INSTALLED="$dest/$APP_NAME.app"
}

install_linux_app() {  # $1: an .AppImage
    quit_app
    # Copied next to it, then renamed over it: a running AppImage can't be
    # written to, but it can be replaced.
    cp "$1" "$HOME_DIR/$APP_NAME.AppImage.new"
    chmod +x "$HOME_DIR/$APP_NAME.AppImage.new"
    mv "$HOME_DIR/$APP_NAME.AppImage.new" "$HOME_DIR/$APP_NAME.AppImage"
    rm -f "$HOME_DIR/$OLD_APP_NAME.AppImage" "$OLD_DESKTOP_FILE"  # the app before its rename
    cp "$SRC/docs/logo.png" "$HOME_DIR/icon.png"
    mkdir -p "$(dirname "$DESKTOP_FILE")"
    cat > "$DESKTOP_FILE" <<EOF
[Desktop Entry]
Type=Application
Name=$APP_NAME
Comment=Steam Timed Achievement Replayer: replay a real player's achievement timeline
Exec="$HOME_DIR/$APP_NAME.AppImage"
Icon=$HOME_DIR/icon.png
Categories=Utility;
Terminal=false
EOF
    APP_INSTALLED="$HOME_DIR/$APP_NAME.AppImage"
}

APP_INSTALLED=""
if [ "$NO_APP" -eq 0 ]; then
    if [ -n "$APP_FILE" ]; then
        say "Installing the app from $APP_FILE"
        if [ "$OS" = Darwin ]; then install_mac_app "$APP_FILE"; else install_linux_app "$APP_FILE"; fi
    else
        case "$OS-$ARCH" in
            Darwin-arm64) url=$(asset_url _aarch64.dmg) ;;
            Darwin-x86_64) url=$(asset_url _x64.dmg) ;;
            Linux-x86_64) url=$(asset_url _amd64.AppImage) ;;
            Linux-aarch64) url=$(asset_url _aarch64.AppImage) ;;
            *) url="" ;;
        esac
        if [ -n "$url" ]; then
            say "Installing the app"
            file="$TMP/$(basename "$url")"
            curl -fsSL "$url" -o "$file" || fail "Couldn't download the app."
            if [ "$OS" = Darwin ]; then install_mac_app "$file"; else install_linux_app "$file"; fi
        else
            note "No desktop app build for this version and computer; use runsteamunlocker --ui instead."
        fi
    fi
fi

# ---- Code -------------------------------------------------------------------
# On macOS the app carries the code; anywhere else it goes in LIB_DIR.
CODE=""
if [ "$OS" = Darwin ] && [ -f "$APP_INSTALLED/Contents/Resources/unlocker/run_unlocker.py" ]; then
    CODE="$APP_INSTALLED/Contents/Resources"
    rm -rf "$LIB_DIR"
else
    rm -rf "$LIB_DIR.new"
    mkdir -p "$LIB_DIR.new"
    for item in unlocker docs runsteamunlocker runsteamunlocker.zsh-completion settings.example.json README.md; do
        cp -R "$SRC/$item" "$LIB_DIR.new/"
    done
    find "$LIB_DIR.new" -name __pycache__ -type d -prune -exec rm -rf {} +
    rm -rf "$LIB_DIR"
    mv "$LIB_DIR.new" "$LIB_DIR"
    CODE="$LIB_DIR"
fi
chmod +x "$CODE/runsteamunlocker"
rm -rf "$HOME_DIR/app"  # where the code lived before 3.01
rm -rf "$OLD_LIB_DIR"   # and before the rename to STAR
# The 3.00 app only looks there, so point it at the code's new place.
if [ "$REF" = v3.00 ] && [ -n "$APP_INSTALLED" ]; then
    ln -s "$CODE" "$HOME_DIR/app"
fi
mkdir -p "$HOME_DIR"
printf '%s\n' "$PY" > "$HOME_DIR/python-path"

# ---- Command ----------------------------------------------------------------
mkdir -p "$BIN_DIR"
cat > "$BIN_DIR/runsteamunlocker" <<EOF
#!/bin/sh
# Installed by STAR's install.sh.
export UNLOCKER_HOME="$HOME_DIR"
export PATH="$(dirname "$PY"):\$PATH"
# Never write __pycache__ into the code (inside the app on macOS).
export PYTHONDONTWRITEBYTECODE=1
exec "$CODE/runsteamunlocker" "\$@"
EOF
chmod +x "$BIN_DIR/runsteamunlocker"

# ---- ArchiSteamFarm + plugin ------------------------------------------------
say "Setting up ArchiSteamFarm"
UNLOCKER_HOME="$HOME_DIR" PYTHONDONTWRITEBYTECODE=1 "$PY" "$CODE/unlocker/run_unlocker.py" --install-asf \
    || fail "Couldn't set up ArchiSteamFarm (see above). Run the install command again to retry."

# ---- Done -------------------------------------------------------------------
# Updated from the page without the app: bring the page's server back.
if [ "$REOPEN" -eq 1 ] && [ -z "$APP_INSTALLED" ]; then
    UNLOCKER_HOME="$HOME_DIR" PYTHONDONTWRITEBYTECODE=1 \
        "$PY" "$CODE/unlocker/run_unlocker.py" --ui --no-browser >/dev/null \
        || note "Couldn't restart the page; open it with runsteamunlocker --ui."
fi
say "Done"
