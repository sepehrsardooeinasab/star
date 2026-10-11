#!/usr/bin/env python3
"""Checks whether a newer ArchiSteamFarm + ASFAchievementManager pair can
replace the one pinned in unlocker/asf_setup.py.

The plugin's source pins ASF as a git submodule, and ASF's plugin API
holds within a minor series (6.3.x) but not across them. So the newest
usable pair is the latest plugin release with the newest stable ASF in the
series that release was built against.

Prints what it found. Exits 1 when the pins should be bumped, 0 when they
are current, 2 when it can't tell. Uses GITHUB_TOKEN if set.

    python3 tools/check_asf_pins.py"""
import json
import os
import re
import subprocess
import sys
import urllib.request
from pathlib import Path

ASF_REPO = "JustArchiNET/ArchiSteamFarm"
PLUGIN_REPO = "CatPoweredPlugins/ASFAchievementManager"
SETUP_FILE = Path(__file__).resolve().parent.parent / "unlocker" / "asf_setup.py"


def github(path):
    headers = {"User-Agent": "star", "Accept": "application/vnd.github+json"}
    if os.environ.get("GITHUB_TOKEN"):
        headers["Authorization"] = f"Bearer {os.environ['GITHUB_TOKEN']}"
    req = urllib.request.Request(f"https://api.github.com/repos/{path}", headers=headers)
    with urllib.request.urlopen(req, timeout=30) as r:
        return json.loads(r.read())


def version(tag):
    return tuple(int(p) for p in tag.split("."))


def series(tag):
    return ".".join(tag.split(".")[:2])


def pinned():
    text = SETUP_FILE.read_text()
    get = lambda name: re.search(rf'^{name} = "([\d.]+)"', text, re.M)[1]
    return get("ASF_VERSION"), get("PLUGIN_VERSION")


def asf_tag_for(sha):
    """The ASF release tag at this commit, or None."""
    out = subprocess.run(["git", "ls-remote", "--tags", f"https://github.com/{ASF_REPO}.git"],
                         capture_output=True, text=True, check=True).stdout
    for line in out.splitlines():
        commit, ref = line.split("\t")
        if commit == sha:
            return ref.removeprefix("refs/tags/").removesuffix("^{}")
    return None


def main():
    asf_pin, plugin_pin = pinned()
    print(f"Pinned:   ArchiSteamFarm {asf_pin} + ASFAchievementManager {plugin_pin}")

    plugin = github(f"{PLUGIN_REPO}/releases/latest")
    plugin_tag = plugin["tag_name"]
    assets = {a["name"] for a in plugin.get("assets", [])}
    if not {"ASFAchievementManager.zip", "SHA512SUMS"} <= assets:
        print(f"Plugin {plugin_tag} is missing ASFAchievementManager.zip or SHA512SUMS; "
              "the app can't install it.")
        return 2
    submodule = github(f"{PLUGIN_REPO}/contents/ArchiSteamFarm?ref={plugin_tag}")
    built_against = asf_tag_for(submodule["sha"])
    if not built_against:
        print(f"Plugin {plugin_tag} is built against ASF commit {submodule['sha'][:10]}, "
              "which isn't a release; check it by hand.")
        return 2

    stable = sorted((r["tag_name"] for r in github(f"{ASF_REPO}/releases?per_page=50")
                     if not r["prerelease"] and not r["draft"]), key=version)
    in_series = [t for t in stable if series(t) == series(built_against)]
    if not in_series:
        print(f"No stable ASF {series(built_against)}.x release found.")
        return 2
    asf_best = in_series[-1]
    print(f"Latest:   ArchiSteamFarm {asf_best} + ASFAchievementManager {plugin_tag} "
          f"(the plugin is built against ASF {built_against})")
    if series(stable[-1]) != series(asf_best):
        print(f"Note: ASF {stable[-1]} is out, but no plugin release supports "
              f"{series(stable[-1])}.x yet, so stay on {series(asf_best)}.x.")

    if (version(asf_best), version(plugin_tag)) == (version(asf_pin), version(plugin_pin)):
        print("The pins are current.")
        return 0
    if version(asf_best) < version(asf_pin) or version(plugin_tag) < version(plugin_pin):
        print("The pins are newer than what this finds; check them by hand.")
        return 2
    print("\nUpdate the pins in unlocker/asf_setup.py:")
    print(f'    ASF_VERSION = "{asf_best}"')
    print(f'    PLUGIN_VERSION = "{plugin_tag}"')
    print("then try a game with them before releasing.")
    return 1


if __name__ == "__main__":
    sys.exit(main())
