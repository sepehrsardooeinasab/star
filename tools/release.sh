#!/bin/sh
# Releases what's on dev and installs it on this computer:
#
#   tools/release.sh            # the next version (v3.25 -> v3.26)
#   tools/release.sh 3.30       # or this one
#   tools/release.sh --no-install   # don't install it here
#   tools/release.sh --keep-old     # don't delete the older releases
#   tools/release.sh --yes          # push without asking
#
# Runs the tests, sets the version in the four places that hold it, commits
# that on dev, merges dev into main as "vX.YY" and tags it, pushes (after
# asking), and waits for the Release workflow. Once it's built, deletes every
# other release and tag, and every deployment but the newest (the live
# website). Then installs it the way Check for Updates does: STAR closes and
# opens again on it. Running games are their own processes and keep going.
# Needs git, gh (signed in), python3, node.
set -eu

REPO="sepehrsardooeinasab/star"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

say() { printf '\033[1m==>\033[0m %s\n' "$*"; }
note() { printf '    %s\n' "$*"; }
fail() { printf '\033[31mError:\033[0m %s\n' "$*" >&2; exit 1; }

WANT="" INSTALL=1 PRUNE=1 YES=0
while [ $# -gt 0 ]; do
    case "$1" in
        --no-install) INSTALL=0; shift ;;
        --keep-old) PRUNE=0; shift ;;
        --yes) YES=1; shift ;;
        -h|--help) sed -n '2,16p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
        v[0-9]*.[0-9]*|[0-9]*.[0-9]*) WANT="${1#v}"; shift ;;
        *) fail "Unknown option: $1" ;;
    esac
done

# ---- Checks: nothing is changed unless they all pass ------------------------
"$ROOT/tools/no-session.sh" || exit 1
[ "$(git branch --show-current)" = dev ] || fail "Run this on dev."
[ -z "$(git status --porcelain)" ] || fail "Commit or stash your changes first."
say "Fetching"
git fetch --quiet origin
git merge-base --is-ancestor origin/dev dev || fail "dev is behind origin/dev; pull first."
[ "$(git rev-parse main)" = "$(git rev-parse origin/main)" ] || fail "main differs from origin/main; sync it first."
[ -n "$(git log --oneline main..dev)" ] || fail "dev has nothing that main doesn't."

# The release is vM.NN and the app's version M.0.N (v3.01 is 3.0.1).
OLD=$(sed -n 's/^RELEASE = "v\(.*\)"$/\1/p' unlocker/updates.py)
[ -n "$OLD" ] || fail "Couldn't read RELEASE in unlocker/updates.py."
if [ -z "$WANT" ]; then
    WANT="${OLD%%.*}.$(printf '%02d' $(( $(echo "${OLD#*.}" | sed 's/^0*//') + 1 )))"
fi
MAJOR="${WANT%%.*}"
MINOR=$(echo "${WANT#*.}" | sed 's/^0*//')
MINOR="${MINOR:-0}"
TAG="v$MAJOR.$(printf '%02d' "$MINOR")"
OLD_APP="${OLD%%.*}.0.$(echo "${OLD#*.}" | sed 's/^0*//')"
NEW_APP="$MAJOR.0.$MINOR"
if git rev-parse -q --verify "refs/tags/$TAG" >/dev/null || git ls-remote --exit-code --tags origin "$TAG" >/dev/null 2>&1; then
    fail "$TAG already exists."
fi

say "Running the tests"
python3 -m unittest discover -s tests -p "test_*.py" || fail "The Python tests failed; nothing was changed."
node --test tests/*.test.cjs || fail "The page tests failed; nothing was changed."

# ---- Version, commit, merge, tag --------------------------------------------
say "Setting the version: v$OLD -> $TAG ($NEW_APP)"
python3 - "$OLD" "${TAG#v}" "$OLD_APP" "$NEW_APP" <<'PYEOF'
import sys
old, new, old_app, new_app = sys.argv[1:]
edits = [
    ("unlocker/updates.py", f'RELEASE = "v{old}"', f'RELEASE = "v{new}"'),
    ("app/src-tauri/tauri.conf.json", f'"version": "{old_app}"', f'"version": "{new_app}"'),
    ("app/src-tauri/Cargo.toml", f'version = "{old_app}"', f'version = "{new_app}"'),
    ("app/src-tauri/Cargo.lock", f'name = "star"\nversion = "{old_app}"', f'name = "star"\nversion = "{new_app}"'),
]
texts = {}
for path, before, after in edits:  # every file checked before any is written
    text = open(path).read()
    if text.count(before) != 1:
        sys.exit(f"Error: {path} doesn't have {before!r} exactly once.")
    texts[path] = text.replace(before, after)
for path, text in texts.items():
    open(path, "w").write(text)
PYEOF

git commit --quiet -am "Set the app version to $NEW_APP for the $TAG release"
git checkout --quiet main
git merge --quiet --no-ff dev -m "$TAG"
git tag "$TAG"
git checkout --quiet dev

# ---- Push -------------------------------------------------------------------
say "Ready to push dev, main and $TAG to GitHub:"
git log --oneline origin/main..main | sed 's/^/    /'
if [ "$YES" -eq 1 ]; then
    answer=y
else
    printf 'Push now? [y/N] '
    read -r answer < /dev/tty || answer=""
fi
case "$answer" in
    y|Y|yes) ;;
    *)
        note "Not pushed. It's all committed here; push later with:"
        note "  git push origin dev main $TAG"
        note "or undo it with:"
        note "  git tag -d $TAG && git branch -f main origin/main && git reset --hard HEAD~1"
        exit 0 ;;
esac
git push --quiet origin dev main "$TAG"

# ---- Wait for the build -----------------------------------------------------
say "Waiting for the Release workflow"
RUN=""
for _ in $(seq 30); do
    RUN=$(gh run list --repo "$REPO" --workflow release.yml --branch "$TAG" --limit 1 --json databaseId -q '.[0].databaseId' 2>/dev/null || true)
    [ -n "$RUN" ] && break
    sleep 2
done
[ -n "$RUN" ] || fail "Couldn't find the Release run for $TAG; see https://github.com/$REPO/actions"
gh run watch "$RUN" --repo "$REPO" --exit-status --interval 15 >/dev/null \
    || fail "The release failed; see https://github.com/$REPO/actions/runs/$RUN. Your installed STAR wasn't touched."
note "Built: https://github.com/$REPO/releases/tag/$TAG"

# ---- Delete the older ones --------------------------------------------------
# Only once the new release is built, so there's always one to install.
if [ "$PRUNE" -eq 1 ]; then
    say "Deleting older releases, tags and deployments"
    for old in $(gh release list --repo "$REPO" --limit 200 --json tagName -q '.[].tagName'); do
        [ "$old" = "$TAG" ] || gh release delete "$old" --repo "$REPO" --yes --cleanup-tag \
            || note "Couldn't delete release $old."
    done
    # Tags left without a release, on GitHub and here.
    for old in $(git ls-remote --tags origin | sed -n 's|.*refs/tags/\([^^]*\)$|\1|p'); do
        [ "$old" = "$TAG" ] || git push --quiet origin --delete "$old" || note "Couldn't delete tag $old."
    done
    for old in $(git tag); do
        [ "$old" = "$TAG" ] || git tag -d "$old" >/dev/null
    done
    # Newest first: every deployment after the first in its environment.
    # A deployment has to be inactive before it can be deleted.
    gh api --paginate "repos/$REPO/deployments?per_page=100" -q '.[] | [.id, .environment] | @tsv' \
        | awk -F '\t' 'seen[$2]++ { print $1 }' | while read -r id; do
            gh api -X POST "repos/$REPO/deployments/$id/statuses" -f state=inactive >/dev/null 2>&1 || true
            gh api -X DELETE "repos/$REPO/deployments/$id" >/dev/null 2>&1 || note "Couldn't delete deployment $id."
        done
fi

# ---- Install it here --------------------------------------------------------
if [ "$INSTALL" -eq 0 ]; then
    note "Install it with Check for Updates, or run this again without --no-install."
    exit 0
fi
# A run may have started during the build; STAR updates itself after it.
if ! "$ROOT/tools/no-session.sh"; then
    note "Not installing now; STAR installs $TAG by itself once no game is in a session."
    exit 0
fi
say "Installing $TAG on this computer"
curl -fsSL "https://raw.githubusercontent.com/$REPO/$TAG/install.sh" | sh -s -- --ref "$TAG" --reopen

for code in "/Applications/STAR.app/Contents/Resources" "$HOME/Applications/STAR.app/Contents/Resources" "$HOME/.local/lib/star"; do
    if [ -f "$code/unlocker/updates.py" ]; then
        say "Installed: $(sed -n 's/^RELEASE = "\(.*\)"$/\1/p' "$code/unlocker/updates.py")"
        break
    fi
done
