(function () {
  "use strict";

  // ---------------------------------------------------------------
  // Parsing / session-splitting / CSV logic — pure functions.
  // ---------------------------------------------------------------
  var MONTHS = {jan:0,feb:1,mar:2,apr:3,may:4,jun:5,jul:6,aug:7,sep:8,oct:9,nov:10,dec:11};
  var SKIP_LINE_RE = /^\d+\s+guides?$/i;
  // "2,944 / 7,212   197   39.8 %" — unlocked / owners, points (can be
  // a fraction, e.g. 0.6), percentage, sometimes after SteamHunters' tags
  // for the achievement ("Missable", "Main Storyline"). Every achievement
  // has this line, so the parser finds achievements by it.
  var STATS_RE = /(?:^|\s)[\d,]+\s*\/\s*[\d,]+\s+([\d,]+(?:\.\d+)?)\s+(\d+(?:\.\d+)?)\s*%$/;
  var TIME_RE = /(\d{1,2})\s+(\w{3})\s+'(\d{2})\s+@\s+(\d{1,2}):(\d{2})(?::(\d{2}))?\s+(am|pm)/i;

  function parseTimestamp(match) {
    var month = MONTHS[match[2].toLowerCase()];
    if (month === undefined) return null;
    var hour = parseInt(match[4], 10) % 12;
    if (match[7].toLowerCase() === "pm") hour += 12;
    var year = 2000 + parseInt(match[3], 10);
    var d = new Date(year, month, parseInt(match[1], 10), hour, parseInt(match[5], 10), match[6] ? parseInt(match[6], 10) : 0);
    return isNaN(d.getTime()) ? null : d.getTime();
  }

  // Reads achievements from SteamHunters' page text, copied whole (⌘A) or
  // just the list: everything else on the page (menus, the player's
  // banner, the game's description, tags) is ignored. Each achievement is
  // found by its stats line; its name and description are the lines just
  // above it, and its unlock time (if it's unlocked) the line just below.
  function parseExport(text) {
    var lines = text.split(/\r?\n/).map(function (l) { return l.trim(); });
    var achievements = [];
    var entries = []; // every achievement, locked or not, in pasted order
    var seen = {};
    var minutesOnly = false;  // a time without seconds: SteamHunters' setting is off
    var namelessCount = 0;    // unlocked hidden ones without a name: another setting off

    for (var i = 0; i < lines.length; i++) {
      var stats = lines[i].match(STATS_RE);
      if (!stats) continue;
      // Up to two lines above, from this entry only: entries are 3 blank
      // lines apart, and a guide count or another entry's lines end it.
      var above = [], blanks = 0;
      for (var j = i - 1; j >= 0 && above.length < 2; j--) {
        if (lines[j] === "") { if (++blanks >= 2) break; continue; }
        blanks = 0;
        if (STATS_RE.test(lines[j]) || TIME_RE.test(lines[j]) || SKIP_LINE_RE.test(lines[j])) break;
        above.unshift(lines[j]);
      }
      if (!above.length) continue;
      var achName = above[0];
      // SteamHunters notes hidden achievements in their description.
      var description = (above.length > 1 ? above[1] : "").replace(/^This achievement is hidden\.\s*/i, "");

      var unlockTime = null;
      for (var k = i + 1; k < lines.length; k++) {
        if (lines[k] === "") continue;
        var m = lines[k].match(TIME_RE);
        if (m) {
          unlockTime = parseTimestamp(m);
          if (!m[6]) minutesOnly = true;
        }
        break;
      }

      // Grouped by tags, an achievement with several tags is listed once
      // per tag: the same name, description and unlock time again. (Only
      // unlocked ones: locked hidden ones all read "This achievement is
      // hidden.", and each still counts.)
      // Without SteamHunters' "show hidden achievements" setting, a hidden
      // one has no name at all, just this note.
      var nameless = /^This achievement is hidden\.?$/i.test(achName);
      if (unlockTime !== null && !nameless) {
        var key = achName + "\n" + description + "\n" + unlockTime;
        if (seen[key]) continue;
        seen[key] = true;
      }

      var orderIndex = entries.length + 1;
      entries.push({name: achName, points: parseFloat(stats[1].replace(/,/g, "")), percent: parseFloat(stats[2])});
      if (unlockTime !== null) {
        achievements.push({ach_name: achName, ach_id: orderIndex, unlock_time: unlockTime,
                           description: description, order: orderIndex, nameless: nameless});
        if (nameless) namelessCount++;
      }
    }
    var totalCount = entries.length;

    // ach_id is the achievement's position as pasted, which must match the
    // game's default/schema order (same order ASF's alist/aset use) for the
    // generated config to target the right achievements. If the paste comes
    // out fully ordered (either direction) by one of SteamHunters' other
    // sort keys, that's a strong sign the page was sorted by it instead,
    // which would silently scramble ach_id even though the delay/session
    // math below stays correct either way (it re-sorts by real timestamp
    // regardless of paste order).
    var sortedBy = pageOrder(lines) || detectSort(achievements, entries);

    achievements.sort(function (a, b) { return a.unlock_time - b.unlock_time; });
    return {list: achievements, sortedBy: sortedBy, totalCount: totalCount, minutesOnly: minutesOnly,
            namelessCount: namelessCount};
  }

  var NAME_COLLATOR = new Intl.Collator(undefined, {sensitivity: "base", ignorePunctuation: true, numeric: true});

  // True if values are entirely non-decreasing or entirely non-increasing,
  // with at least one real change (so an all-equal list doesn't count).
  // Needs 3+ values: any 2 are trivially "sorted" one way or the other.
  function isMonotonic(values, cmp) {
    if (values.length < 3) return false;
    var asc = true, desc = true, changed = false;
    for (var i = 1; i < values.length; i++) {
      var c = cmp(values[i - 1], values[i]);
      if (c > 0) asc = false;
      if (c < 0) desc = false;
      if (c !== 0) changed = true;
    }
    return changed && (asc || desc);
  }

  // A whole-page paste says how SteamHunters lists it ("… grouped by" /
  // "nothing" / "sorted by" / "default"). Returns how, if it isn't the
  // game's default order, else null.
  function pageOrder(lines) {
    var after = function (label) {
      for (var i = 0; i < lines.length; i++) {
        if (!/(^|\s)(grouped|sorted) by$/i.test(lines[i]) || lines[i].toLowerCase().slice(-label.length) !== label) continue;
        for (var j = i + 1; j < lines.length; j++) if (lines[j]) return lines[j];
      }
      return null;
    };
    var grouped = after("grouped by"), sorted = after("sorted by");
    if (sorted && !/^default$/i.test(sorted)) return "sorted by " + sorted;
    if (grouped && !/^nothing$/i.test(grouped)) return "grouped by " + grouped;
    return null;
  }

  // The game's title in a whole-page paste: the line above its achievement
  // count ("Among Us" / "33Achievements"). Null for a list-only paste.
  function pageGame(text) {
    var lines = String(text || "").split(/\r?\n/).map(function (l) { return l.trim(); });
    for (var i = 0; i < lines.length; i++) {
      if (!/^[\d,]+\s*Achievements$/.test(lines[i])) continue;
      for (var j = i - 1; j >= 0; j--) if (lines[j]) return lines[j];
    }
    return null;
  }

  // Returns how the paste appears ordered ("sorted by name", …), or null.
  function detectSort(unlocked, entries) {
    var byNumber = function (a, b) { return a - b; };
    var known = function (key) {
      var vals = entries.map(function (e) { return e[key]; });
      // Only trust a key if it parsed for every entry.
      return vals.every(function (v) { return v !== null; }) ? vals : [];
    };

    if (isMonotonic(unlocked.map(function (a) { return a.unlock_time; }), byNumber)) return "sorted by unlock date";
    if (isMonotonic(entries.map(function (e) { return e.name; }), NAME_COLLATOR.compare)) return "sorted by name";
    if (isMonotonic(known("percent"), byNumber)) return "sorted by percentage";
    if (isMonotonic(known("points"), byNumber)) return "sorted by points";
    return null;
  }

  // ---- achievement numbers (app only) ----
  // aset unlocks an achievement by its number in the plugin's list, which
  // is the game's own order. In the app those numbers come from
  // ArchiSteamFarm itself (see unlocker/achievements.py), and achievements
  // are matched to them by name; where a game reuses a name, by
  // description, or by Steam's ID for a link. So the paste can be in any
  // sort, or be a link to a player's achievements.
  var LINK_RE = /^https?:\/\/(www\.)?(steamhunters\.com|steamcommunity\.com)\/\S+$/i;
  var linkSources = {};   // url -> {status: "loading" | "ok" | "error", data, message}
  var numberings = {};    // appid -> {status, data, message, at}

  function pastedLink(text) {
    var t = String(text || "").trim();
    return LINK_RE.test(t) ? t : null;
  }

  function gameSlug(name) {
    return String(name || "").toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, "");
  }

  // The name a game's files are saved under: "Grand Theft Auto V" ->
  // "grandtheftautov", or app<id> for a name with no letters to use.
  function fileName(title, appid) {
    return (gameSlug(title) || (title && appid > 0 ? "app" + appid : "")).slice(0, 60);
  }

  // A failure that may pass by itself (Steam busy or out of reach, or
  // STAR's own server), asked again after a few seconds.
  function retryable(title) { return !title || title === "Couldn't reach Steam" || title === "Steam is busy"; }

  function fillLinkFields(d) {
    if (!els.appid.value && d.appid) els.appid.value = d.appid;
    if (!els.gameName.value && d.game) els.gameName.value = d.game;
    if (!els.copiedFrom.value && d.player) els.copiedFrom.value = d.player;
  }

  // A link's achievements, read once. If Steam couldn't be reached (a
  // passing hiccup), it's asked again every few seconds; Steam's own
  // answers (a private profile, no such player) stay.
  function loadLink(url) {
    var known = linkSources[url];
    if (known && !(known.retry && Date.now() - known.at >= 5000)) return known;
    linkSources[url] = {status: "loading"};
    api("/api/achievements/link", {url: url}).then(function (d) {
      linkSources[url] = {status: "ok", data: d};
      if (pastedLink(els.exportText.value) === url) {
        fillLinkFields(d);
      }
    }).catch(function (err) {
      var title = (err.data || {}).title, retry = retryable(title);
      linkSources[url] = {status: "error", message: err.message, title: title, retry: retry, at: Date.now()};
      if (retry) setTimeout(scheduleRecompute, 5000);
    }).then(scheduleRecompute);
    return linkSources[url];
  }

  // Asked once the App ID has stayed the same for a moment, so typing one
  // doesn't check every partial number. A failed check is tried again
  // only when the paste changes (a new App ID is a new check), and by
  // itself a few times when the failure may pass (see retryable): not on
  // other changes, like Copied from or the options.
  var numbersTimer = null, numbersWanted = null, numbersTries = {};
  var RETRY_AFTER = [5000, 15000, 30000];
  function loadNumbers(appid) {
    var n = numberings[appid];
    var retrying = null;  // the failed check this one tries again by itself
    if (n && n.status === "error") {
      if (n.paste === els.exportText.value && !n.retryNow) return n;
      if (n.paste !== els.exportText.value) numbersTries[appid] = 0;
      else retrying = n;
    } else if (n) return n;
    if (numbersWanted !== appid) {
      numbersWanted = appid;
      clearTimeout(numbersTimer);
      numbersTimer = setTimeout(function () {
        var loading = numberings[appid] = {status: "loading", steps: [], retrying: retrying};
        // What the check is doing (starting ArchiSteamFarm, signing in…),
        // shown as it goes.
        var poll = setInterval(function () {
          if (numberings[appid] !== loading) { clearInterval(poll); return; }
          api("/api/achievements/progress?appid=" + appid).then(function (d) {
            if (numberings[appid] !== loading || JSON.stringify(d.steps) === JSON.stringify(loading.steps)) return;
            loading.steps = d.steps;
            scheduleRecompute();
          }).catch(function () {});
        }, 700);
        api("/api/achievements/numbers", {appid: appid}).then(function (d) {
          numberings[appid] = {status: "ok", data: d};
          numbersTries[appid] = 0;
        }).catch(function (err) {
          var title = (err.data || {}).title, tries = numbersTries[appid] = (numbersTries[appid] || 0) + 1;
          var failed = numberings[appid] = {status: "error", message: err.message, title: title, paste: els.exportText.value};
          if (retryable(title) && tries <= RETRY_AFTER.length) {
            setTimeout(function () {
              if (numberings[appid] === failed) { failed.retryNow = true; scheduleRecompute(); }
            }, RETRY_AFTER[tries - 1]);
          }
        }).then(function () {
          if (numbersWanted === appid) numbersWanted = null;
          scheduleRecompute();
        });
      }, 1200);
    }
    return {status: "loading", retrying: retrying};
  }

  function sameText(a, b) {
    return String(a || "").replace(/\s+/g, " ").trim().toLowerCase() === String(b || "").replace(/\s+/g, " ").trim().toLowerCase();
  }

  // Sets each achievement's ach_id to its number: by Steam's API name when
  // there is one, else by name (and description where names repeat).
  // Matched in pasted order, so achievements that can't be told apart at
  // all keep that order. Hidden ones shown without a name can only go by
  // their position, which is their number when the paste is in the
  // default order (inOrder); they then take their real name.
  function assignNumbers(list, numbered, inOrder) {
    var byApi = {}, byNumber = {}, used = {};
    numbered.forEach(function (n) { byNumber[n.number] = n; });
    // Steam's stats page lowercases API names; SteamHunters shows them as written.
    numbered.forEach(function (n) { if (n.apiname) byApi[n.apiname.toLowerCase()] = n; });
    var result = {missing: [], shared: {}, byOrder: {}, restricted: [], nameless: 0, namelessMissing: 0};
    var sorted = list.slice().sort(function (a, b) { return a.order - b.order; });
    sorted.forEach(function (a) {
      if (a.nameless) return;  // after the named ones, below
      var same = numbered.filter(function (n) { return sameText(n.name, a.ach_name); });
      if (same.length > 1) result.shared[same[0].name] = same.length;
      // A link gives Steam's API name; a paste sorted "by API name" shows
      // it in place of the name. Either is unique, so it's tried first.
      var match = (a.apiname && byApi[a.apiname.toLowerCase()]) || (!same.length && byApi[a.ach_name.toLowerCase()]);
      if (!match) {
        var free = same.filter(function (n) { return !used[n.number]; });
        if (free.length > 1 && a.description) {
          var described = free.filter(function (n) { return sameText(n.description, a.description); });
          if (described.length) free = described;
        }
        if (free.length > 1) result.byOrder[same[0].name] = true;
        match = free[0];
      }
      if (!match) { result.missing.push(a.ach_name); a.ach_id = null; return; }
      used[match.number] = true;
      a.ach_id = match.number;
      if (match.restricted) result.restricted.push(a.ach_name);
    });
    sorted.forEach(function (a) {
      if (!a.nameless) return;
      var match = inOrder && byNumber[a.order];
      if (!match || used[match.number]) { result.namelessMissing++; a.ach_id = null; return; }
      used[match.number] = true;
      a.ach_id = match.number;
      a.ach_name = match.name;
      result.nameless++;
      if (match.restricted) result.restricted.push(a.ach_name);
    });
    return result;
  }

  function sharedNamesMsg(match, linked) {
    var names = Object.keys(match.shared);
    if (!names.length) return null;
    var list = names.map(function (n) { return "\u201c" + n + "\u201d (\u00d7" + match.shared[n] + ")"; }).join(", ");
    var byOrder = Object.keys(match.byOrder);
    if (byOrder.length) {
      return "This game has achievements that share a name: " + list + ". Some of them also share a description, " +
        "so nothing tells them apart: they were matched in the order they were pasted. Check them on the Timeline tab.";
    }
    return "This game has achievements that share a name: " + list + ". Each was matched to its own number by " +
      (linked ? "Steam's ID for it." : "its description.");
  }

  function addDelays(list) {
    var prev = null;
    return list.map(function (a) {
      var delay = prev === null ? 0 : Math.round((a.unlock_time - prev) / 1000);
      prev = a.unlock_time;
      return {ach_name: a.ach_name, ach_id: a.ach_id, unlock_time: a.unlock_time, delay: delay};
    });
  }

  // breaks (optional) holds manual gap overrides from the Timeline tab:
  // {ach_id: true} starts a new session at that achievement, {ach_id: false}
  // keeps it in the current one, whatever the limits say. autoBreaks reports
  // what the limits alone would decide at each achievement (given the
  // splits before it), so the UI can tell which gaps are manual.
  function splitSessions(items, gapLimit, cumulativeLimit, breaks) {
    var sessions = [], current = [], initialDelays = [], durations = [], cumulative = 0;
    var autoBreaks = {};
    breaks = breaks || {};

    // A session you merged by removing a break isn't split again just for
    // running long (that would only move the break further on); a real
    // pause in the player's unlocks still starts a new one.
    var merged = false;
    items.forEach(function (ach) {
      var delay = ach.delay;

      if (current.length) {
        var key = String(ach.ach_id);
        var auto = delay > gapLimit || (!merged && cumulative + delay > cumulativeLimit);
        autoBreaks[key] = auto;
        if (key in breaks ? breaks[key] : auto) {
          sessions.push(current); durations.push(cumulative); current = []; cumulative = 0;
          merged = false;
        } else if (auto) {
          merged = true;  // a break you removed
        }
      }

      if (current.length === 0) {
        initialDelays.push(ach.delay);
        ach = {ach_name: ach.ach_name, ach_id: ach.ach_id, unlock_time: ach.unlock_time, delay: 0};
      }

      current.push(ach);
      cumulative += ach.delay;
    });

    if (current.length) { sessions.push(current); durations.push(cumulative); }
    var gaps = sessions.length > 1 ? initialDelays.slice(1) : [];
    return {sessions: sessions, gaps: gaps, durations: durations, autoBreaks: autoBreaks};
  }

  function buildConfig(appid, sessions, gaps, copiedFrom, title) {
    var achievements = [];
    sessions.forEach(function (session, si) {
      session.forEach(function (ach, ai) {
        var isFirst = ai === 0;
        var delay, newSession;
        if (si === 0 && isFirst) { delay = ach.delay || 0; newSession = false; }
        else if (isFirst) { delay = gaps[si - 1]; newSession = true; }
        else { delay = ach.delay || 0; newSession = false; }
        achievements.push({id: ach.ach_id, delay: delay, new_session: newSession});
      });
    });
    var config = {appid: appid};
    if (title) config.game = title;
    if (copiedFrom) config.copied_from = copiedFrom;
    config.achievements = achievements;
    return config;
  }

  function exactRange(list, instant) {
    var lo = Math.min.apply(null, list), hi = Math.max.apply(null, list);
    var fmt = function (x) { return instant && x === 0 ? "Instant" : x >= 60 ? fmtDur(x) : Math.round(x) + "s"; };
    return lo === hi ? fmt(lo) : fmt(lo) + " – " + fmt(hi);
  }

  function roughDuration(seconds) {
    seconds = Math.round(seconds);
    if (seconds >= 86400) return ">1 day";
    if (seconds >= 3600) return "~" + Math.ceil(seconds / 3600) + "h";
    if (seconds >= 60) return "~" + Math.ceil(seconds / 60) + "m";
    return seconds + "s";
  }

  // Human-readable duration for the CSV. Never starts with "=" — spreadsheets
  // would treat that cell as a formula.
  function roughDurationCsv(seconds) {
    seconds = Math.trunc(seconds);
    if (seconds >= 86400) return "~" + String(Math.round(seconds / 86400)).padStart(2, "0") + " day";
    if (seconds >= 3600) return "~" + String(Math.ceil(seconds / 3600)).padStart(2, "0") + " hour";
    if (seconds >= 60) return "~" + String(Math.ceil(seconds / 60)).padStart(2, "0") + " min";
    return String(seconds).padStart(2, "0") + " sec";
  }

  function formatUnlockTime(ms) {
    var d = new Date(ms);
    function pad(n) { return String(n).padStart(2, "0"); }
    return d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate()) + " " +
      pad(d.getHours()) + ":" + pad(d.getMinutes()) + ":" + pad(d.getSeconds());
  }

  function csvCell(v) {
    var s = v === null || v === undefined ? "" : String(v);
    if (/[",\r\n]/.test(s)) s = '"' + s.replace(/"/g, '""') + '"';
    return s;
  }

  function toCsv(rows) {
    return rows.map(function (r) { return r.map(csvCell).join(","); }).join("\r\n") + "\r\n";
  }

  // The single per-game CSV: every achievement with its session, readable
  // delay and exact delay in seconds, plus a label row heading each session
  // (readable + exact duration) and one for each gap between sessions
  // (readable + exact gap). Achievement rows are the ones with an id.
  //
  // targets[i] is the achievement id whose delay rows[i]'s delay cell edits
  // (null when it isn't editable): an achievement's own delay, or — for a
  // gap row — the next session's first achievement, which is where the
  // config keeps that gap. A session's first achievement has no delay of
  // its own (always 0), so it isn't editable itself.
  //
  // gapActions[i] is {id, kind} for rows that can gain or lose a gap:
  // "remove" on a gap row, "add" on any achievement row but the very first.
  var CSV_DELAY_COL = 5;
  function buildCsvRows(sessions, gaps, durations, copiedFrom) {
    var rows = [["session", "#", "achievement", "id", "unlock_time", "delay", "delay_s"]];
    var targets = [null], gapActions = [null];
    if (copiedFrom) {
      rows.push(["Copied from: " + copiedFrom, "", "", "", "", "", ""]);
      targets.push(null);
      gapActions.push(null);
    }
    sessions.forEach(function (session, i) {
      if (i > 0) {
        rows.push(["Gap before session " + (i + 1), "", "", "", "", roughDurationCsv(gaps[i - 1]), gaps[i - 1]]);
        targets.push(String(session[0].ach_id));
        gapActions.push({id: String(session[0].ach_id), kind: "remove"});
      }
      rows.push(["Session " + (i + 1) + " (" + session.length + " achievement" + (session.length === 1 ? "" : "s") + ")",
        "", "", "", "", roughDurationCsv(durations[i]), durations[i]]);
      targets.push(null);
      gapActions.push(null);
      session.forEach(function (a, j) {
        rows.push([i + 1, j + 1, a.ach_name, a.ach_id, formatUnlockTime(a.unlock_time), roughDurationCsv(a.delay), a.delay]);
        targets.push(j > 0 ? String(a.ach_id) : null);
        gapActions.push(j > 0 ? {id: String(a.ach_id), kind: "add"} : null);
      });
    });
    return {rows: rows, targets: targets, gapActions: gapActions};
  }

  // Applies manual delay edits ({ach_id: seconds}) on top of an already-split
  // schedule. A delay edit only changes timing, never which session an
  // achievement is in — only an added/removed gap (breaks) does that.
  // Returns the edited split plus originals ({ach_id: seconds}) for every
  // editable delay, so the UI can show/undo what changed.
  function applyEdits(split, edits) {
    var originals = {};
    var gaps = split.gaps.slice();
    var sessions = split.sessions.map(function (session, si) {
      return session.map(function (a, j) {
        var key = String(a.ach_id);
        if (j === 0) {
          if (si > 0) {
            originals[key] = gaps[si - 1];
            if (key in edits) gaps[si - 1] = edits[key];
          }
          return a;
        }
        originals[key] = a.delay;
        return key in edits ? Object.assign({}, a, {delay: edits[key]}) : a;
      });
    });
    var durations = sessions.map(function (session) {
      return session.reduce(function (t, a) { return t + a.delay; }, 0);
    });
    return {sessions: sessions, gaps: gaps, durations: durations, autoBreaks: split.autoBreaks, originals: originals};
  }

  // Whole seconds. Returns null if invalid.
  // Seconds from what's typed: "90" (seconds), or "1h 20m", "45m", "2d 3h",
  // "90s"; null if it's neither.
  function parseDelayInput(text) {
    var t = String(text).trim().toLowerCase();
    if (/^\d+$/.test(t)) return parseInt(t, 10);
    var m = /^(?:(\d+)\s*d)?\s*(?:(\d+)\s*h)?\s*(?:(\d+)\s*m)?\s*(?:(\d+)\s*s)?$/.exec(t);
    if (!t || !m || !(m[1] || m[2] || m[3] || m[4])) return null;
    return (+m[1] || 0) * 86400 + (+m[2] || 0) * 3600 + (+m[3] || 0) * 60 + (+m[4] || 0);
  }

  // "1h 21m 10s": every part, for editing a delay without losing any of it.
  function exactDuration(seconds) {
    seconds = Math.max(0, Math.round(Number(seconds) || 0));
    var parts = [[86400, "d"], [3600, "h"], [60, "m"], [1, "s"]].map(function (u) {
      var n = Math.floor(seconds / u[0]);
      seconds -= n * u[0];
      return n ? n + u[1] : "";
    }).filter(Boolean);
    return parts.join(" ") || "0s";
  }

  // Clock times as Settings → Clock says: 12-hour ("2:30 PM") or 24-hour
  // ("14:30"). Until one's picked, the usual one for the computer's
  // language (the web view can't read the Mac's own 12/24-hour switch).
  var CLOCK_GUESS = "12h";
  try {
    var hourCycle = new Intl.DateTimeFormat([], {hour: "numeric"}).resolvedOptions().hourCycle;
    if (hourCycle === "h23" || hourCycle === "h24") CLOCK_GUESS = "24h";
  } catch (e) {}
  var clockPref = CLOCK_GUESS;
  function clockOpts(opts) {
    if (clockPref === "12h") { opts.hour = "numeric"; opts.hour12 = true; }
    else { opts.hour = "2-digit"; opts.hourCycle = "h23"; }
    opts.minute = "2-digit";
    return opts;
  }
  function fmtClock(d) { return d.toLocaleTimeString([], clockOpts({})); }
  // Library's unlock times, to the second ("14:30:07").
  function fmtClockSec(d) { return d.toLocaleTimeString([], clockOpts({second: "2-digit"})); }

  // The app's timeline, written for people: "Oct 9, 21:25" and "1h 21m".
  function prettyTime(text) {
    var d = new Date(String(text).replace(" ", "T"));
    return isNaN(d) ? text : d.toLocaleString([], clockOpts({month: "short", day: "numeric"}));
  }
  function prettyLabel(r) {
    var secs = Number(r[CSV_DELAY_COL + 1]) || 0, m;
    if ((m = /^Gap before session (\d+)/.exec(r[0]))) return "Break before session " + m[1];
    if ((m = /^Session (\d+) \((\d+ achievements?)\)/.exec(r[0]))) {
      return "Session " + m[1] + " · " + m[2] + " · " + sessionDuration(secs);
    }
    return r[0];
  }

  function isLabelRow(row) {
    return row[3] === "";
  }

  // The full timeline, for Schedule and Runs alike: one row per
  // achievement under its session's heading, and a row for each break.
  // Where the rows come from, what can be edited and which + / − apply is
  // up to the caller, through hooks:
  //   rowClass(index)  a class for the index-th achievement row, or ""
  //   edit(ri)         null, or {cls, attr, undoAttr, original, title} for
  //                    a delay that can be changed (original: the value
  //                    before an edit, when it was edited)
  //   gapButton(ri, r) the + / − after a row's number or break label
  function timelineTable(rows, hooks) {
    // Friendly columns (see prettyTime), not the CSV's own.
    var achievement = -1;
    var html = '<div class="table-wrap"><table class="csv-table pretty"><thead><tr>' +
      ["#", "Achievement", "Player's time", "Delay since previous"].map(function (h) {
        return "<th>" + escapeHtml(h) + "</th>";
      }).join("") + "</tr></thead><tbody>";
    var shown = exactDuration;
    function gap(ri, r) { return hooks.gapButton ? hooks.gapButton(ri, r) : ""; }
    // Jump to achievement: with the game's appid (hooks.achLink), the name
    // (only its text) opens it in Library.
    function achCell(name) {
      return hooks.achLink > 0 ? '<span class="ach-link" role="button" tabindex="0" data-lib-appid="' + hooks.achLink +
        '" data-lib-ach="' + escapeHtml(name) + '" title="Show in Library">' + escapeHtml(name) + "</span>" : escapeHtml(name);
    }
    function delayCell(r, ri) {
      var value = escapeHtml(shown(r[CSV_DELAY_COL + 1]));
      var e = hooks.edit && hooks.edit(ri);
      if (!e) return '<td class="delay-cell">' + value + "</td>";
      var edited = e.original !== undefined;
      var undo = edited ? '<button class="undo-edit" type="button" ' + e.undoAttr + ' title="Undo (was ' +
        escapeHtml(shown(e.original)) + ')">↺</button>' : "";
      return '<td class="delay-cell ' + e.cls + (edited ? " edited" : "") + '" ' + e.attr +
        (e.title ? ' title="' + escapeHtml(e.title) + '"' : "") + ">" + value + undo + "</td>";
    }
    rows.slice(1).forEach(function (r, i) {
      var ri = i + 1;
      if (/^Copied from:/.test(r[0])) return;
      if (isLabelRow(r)) {
        var kind = /^Gap/.test(r[0]) ? "gap-row" : "session-row";
        html += '<tr class="' + kind + '"><td colspan="3"><span class="cell-line">' + escapeHtml(prettyLabel(r)) + gap(ri, r) + "</span></td>" +
          (kind === "gap-row" ? delayCell(r, ri) : "<td></td>") + "</tr>";
        return;
      }
      var rc = hooks.rowClass ? hooks.rowClass(++achievement) : "";
      html += "<tr" + (rc ? ' class="' + rc + '"' : "") + '><td><span class="cell-line"><span class="row-num">' + escapeHtml(r[1]) + "</span>" +
        gap(ri, r) + "</span></td><td>" + achCell(r[2]) + "</td><td>" + escapeHtml(prettyTime(r[4])) + "</td>" +
        delayCell(r, ri) + "</tr>";
    });
    return html + "</tbody></table></div>";
  }

  // Schedule's full timeline. ui (optional) = {targets, gapActions, edits,
  // originals, breaks, autoBreaks} makes delays clickable to edit (edited
  // ones highlighted, with an undo) and adds the + / − for breaks.
  // achievementClass (optional) gives each achievement row a class.
  function rowsToTable(rows, ui, achievementClass) {
    return timelineTable(rows, {
      rowClass: achievementClass,
      achLink: ui && ui.achLink,  // Jump to achievement
      edit: function (ri) {
        var id = ui && ui.targets[ri];
        if (!id) return null;
        var edited = id in ui.edits;
        return {cls: "editable", attr: 'data-id="' + escapeHtml(id) + '"', undoAttr: 'data-undo="' + escapeHtml(id) + '"',
                original: edited ? ui.originals[id] : undefined,
                title: edited ? "Edited — click to change" : "Click to edit this delay"};
      },
      // A gap is manual when it differs from what the limits would decide:
      // an added gap shows a highlighted −, a removed one a highlighted +.
      gapButton: function (ri) {
        var act = ui && ui.gapActions[ri];
        if (!act) return "";
        var manual = act.id in ui.breaks && ui.breaks[act.id] !== ui.autoBreaks[act.id];
        var add = act.kind === "add";
        var title = add
          ? (manual ? "A gap was removed here — click to put it back" : "Start a new session at this achievement")
          : (manual ? "You added this gap — click to remove it" : "Remove this gap (merge into the previous session)");
        return '<button class="gap-btn' + (manual ? " edited" : "") + '" type="button" data-gap="' +
          escapeHtml(act.id) + '" data-kind="' + act.kind + '" title="' + escapeHtml(title) + '">' +
          (add ? "+" : "−") + "</button>";
      }
    });
  }

  function highlightJson(json) {
    var escaped = json.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
    escaped = escaped.replace(/"(\\.|[^"\\])*"(\s*:)?/g, function (match) {
      var cls = /:$/.test(match) ? "tok-key" : "tok-str";
      return '<span class="' + cls + '">' + match + "</span>";
    });
    escaped = escaped.replace(/: (-?\d+(\.\d+)?)/g, ': <span class="tok-num">$1</span>');
    escaped = escaped.replace(/: (true|false)/g, ': <span class="tok-bool">$1</span>');
    return escaped;
  }

  function escapeHtml(s) {
    return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  }

  // ---------------------------------------------------------------
  // UI state machine
  // ---------------------------------------------------------------
  var els = {
    exportText: document.getElementById("export-text"),
    appid: document.getElementById("appid"),
    gameName: document.getElementById("game-name"),
    copiedFrom: document.getElementById("copied-from"),
    gapLimit: document.getElementById("gap-limit"),
    cumLimit: document.getElementById("cum-limit"),
    minGap: document.getElementById("min-gap"),
    resetBtn: document.getElementById("reset-btn"),
    downloadBtn: document.getElementById("download-btn"),
    boxTitle: document.getElementById("box-title"),
    statsStrip: document.getElementById("stats-strip"),
    toast: document.getElementById("toast"),
    jsonSlot: document.getElementById("json-slot"),
    csvSlot: document.getElementById("csv-slot"),
    runsList: document.getElementById("runs-list"),
    runsLog: document.getElementById("runs-log"),
    inputAlertSlot: document.getElementById("input-alert-slot")
  };

  // how: e.g. "sorted by name" or "grouped by DLC & update".
  function sortedByMsg(how) {
    return "This paste looks " + how + ", not in the game's default order. Achievement numbering needs default order, so the generated IDs will be wrong. Re-copy the page with no grouping and the default sort.";
  }

  var NAV_TITLES = {
    input: "Achievements",
    settings: "Settings",
    json: "Schedule (config.json)",
    csv: "Timeline (csv)",
    runs: "Runs"
  };

  var navButtons = {
    input: document.getElementById("nav-input"),
    settings: document.getElementById("nav-settings"),
    json: document.getElementById("nav-json"),
    csv: document.getElementById("nav-csv")
  };

  var currentView = "input";
  var scheduleView = "input";   // the schedule tab to return to from Runs
  var latest = null; // { errors, warnings, config, jsonText, csvText, csvRows, csvTargets, gapActions, originals, autoBreaks, filenames, stats }
  // Manual edits from the Timeline tab: delays ({ach_id: seconds}) and
  // added/removed gaps ({ach_id: true|false}, see splitSessions). While any
  // exist, the pasted text is locked (changing it would orphan them).
  var edits = {};
  var breaks = {};
  // Two-click confirmations: key -> time until which the second click counts.
  var armedUntil = {};
  var ARM_MS = 4000;
  // The "pasted text is locked" notice shows only after clicking the locked
  // text box, until the next click elsewhere.
  var showLockNotice = false;

  function showToast(msg) {
    els.toast.textContent = msg;
    els.toast.classList.add("show");
    clearTimeout(showToast._t);
    showToast._t = setTimeout(function () { els.toast.classList.remove("show"); }, 2200);
  }

  function setView(view) {
    currentView = view;
    if (view !== "runs") scheduleView = view;
    Object.keys(navButtons).forEach(function (k) { navButtons[k].classList.toggle("active", k === view); });
    syncScreenSwitch();
    document.querySelectorAll(".view-pane").forEach(function (el) {
      el.classList.toggle("active", el.getAttribute("data-view") === view);
    });
    els.boxTitle.textContent = NAV_TITLES[view];
    document.querySelector(".box").setAttribute("data-view", view);  // shows that tab's help
    document.body.setAttribute("data-view", view);  // the page header's action
    renderPageHead();
    sizeBoxes();
    render();
    if (view === "runs") refreshRuns();
  }

  // The header over Schedule, Runs and Settings, in the start screen's
  // style: what the screen is for, the bright part first.
  var PAGE_HEADS = {
    schedule: ["Schedule", "Make a schedule", " from a real player"],
    runs: ["Runs", "Run a game", " at the player's pace"],
    unlocks: ["Library", "Your games and achievements", " from Steam"],
    guide: ["Settings", "Settings", " for this computer"]
  };
  function renderPageHead() {
    var screen = document.body.getAttribute("data-screen");
    var head = PAGE_HEADS[screen === "guide" || screen === "unlocks" ? screen : currentView === "runs" ? "runs" : "schedule"];
    byId("page-eyebrow").textContent = "STAR · " + head[0];
    byId("page-title").innerHTML = '<span class="hero-bright">' + head[1] + "</span>" + head[2];
  }

  // Runs and Settings take the builder's height (Runs has no tabs or
  // footer, Settings is its own panel), so switching between the tabs in
  // the top bar doesn't move anything. Measured with the builder briefly
  // laid out (not drawn), since it's hidden on those tabs.
  function sizeBoxes() {
    // The local app has one persistent frame. Only the standalone builder
    // needs to measure its content to match heights between views.
    if (local) return;
    var body = document.body, box = document.querySelector(".box");
    var screen = body.getAttribute("data-screen"), view = box.getAttribute("data-view");
    body.setAttribute("data-screen", "work");
    box.setAttribute("data-view", scheduleView);
    var height = box.offsetHeight;
    if (screen) body.setAttribute("data-screen", screen);
    box.setAttribute("data-view", view);
    if (height) document.documentElement.style.setProperty("--box-h", height + "px");
  }
  window.addEventListener("resize", sizeBoxes);

  Object.keys(navButtons).forEach(function (key) {
    navButtons[key].addEventListener("click", function () { setView(key); });
  });

  // A wait in progress: what it's for, then each step so far, done ones
  // ticked and the current one spinning.
  function stepsHtml(title, steps) {
    if (!steps || !steps.length) return noticeHtml("info", title);
    return '<div class="notice info steps"><div><div class="notice-title">' + escapeHtml(title) + '</div><ul class="step-list">' +
      steps.map(function (s) {
        return '<li class="' + (s.done ? "done" : "now") + '">' + escapeHtml(s.text) + (s.done ? "" : "\u2026") + "</li>";
      }).join("") + "</ul></div></div>";
  }

  function noticeHtml(kind, text) {
    return '<div class="notice ' + kind + '">' + escapeHtml(text) + "</div>";
  }

  // A problem with a title (what happened) over what to do about it.
  function problemHtml(kind, title, text) {
    if (!title) return noticeHtml(kind, text);
    return '<div class="notice ' + kind + ' problem"><div><div class="notice-title">' + escapeHtml(title) +
      "</div><div>" + escapeHtml(text) + "</div></div></div>";
  }

  function emptyHtml(glyph, text) {
    return '<div class="empty-hint"><div class="glyph">' + glyph + "</div><p>" + escapeHtml(text) + "</p></div>";
  }

  // Where Schedule's draft is kept: across launches, so closing the window
  // doesn't lose a paste that isn't saved yet (Reset all fields clears it).
  var draftStore = null;
  try { draftStore = localStorage; } catch (e) {}
  // tests/draft.test.cjs runs the code from here to its end marker below.
  // >>> draft storage
  function saveDraft() {
    try {
      draftStore.setItem("unlock-scheduler-draft", JSON.stringify({
        exportText: els.exportText.value,
        appid: els.appid.value,
        gameName: els.gameName.value,
        copiedFrom: els.copiedFrom.value,
        gapLimit: els.gapLimit.value,
        cumLimit: els.cumLimit.value,
        minGap: els.minGap.value,
        edits: edits,
        breaks: breaks
      }));
    } catch (e) {}
  }

  function loadDraft() {
    try {
      var raw = draftStore.getItem("unlock-scheduler-draft");
      if (!raw) return;
      var d = JSON.parse(raw);
      if (d.exportText) els.exportText.value = d.exportText;
      if (d.appid) els.appid.value = d.appid;
      if (d.gameName) els.gameName.value = d.gameName;
      if (d.copiedFrom) els.copiedFrom.value = d.copiedFrom;
      if (d.gapLimit) els.gapLimit.value = d.gapLimit;
      if (d.cumLimit) els.cumLimit.value = d.cumLimit;
      if (d.minGap) els.minGap.value = d.minGap;
      if (d.edits && typeof d.edits === "object") edits = d.edits;
      if (d.breaks && typeof d.breaks === "object") breaks = d.breaks;
    } catch (e) {}
  }

  // <<< draft storage

  // ---- core recompute (pure, runs on every input change) ----
  function recompute() {
    var appidVal = parseInt(els.appid.value, 10);
    checkCounters(appidVal);
    // The game's real name is shown in the app; its files get a short
    // name made from it.
    var title = els.gameName.value.trim();
    var gameName = fileName(title, appidVal);
    var copiedFrom = els.copiedFrom.value.trim();
    var gapLimitSec = (parseFloat(els.gapLimit.value) || 0) * 3600;
    var cumLimitSec = (parseFloat(els.cumLimit.value) || 0) * 3600;
    var minGapSec = (parseFloat(els.minGap.value) || 0) * 3600;

    // A link: the player's achievements come from Steam.
    var link = pastedLink(els.exportText.value);
    var linked = null;
    if (link) {
      var source = loadLink(link);
      if (source.status === "loading") {
        latest = {errors: ["Reading the achievements from Steam\u2026"], pending: true};
        return;
      }
      if (source.status === "error") {
        latest = {errors: [source.message], errorTitle: source.title, inputNotice: "danger"};
        return;
      }
      linked = source.data;
    }

    var errors = [];
    var where = combined ? " in Details." : " in Settings.";
    if (!appidVal || appidVal <= 0) errors.push("Enter the game's App ID" + where);
    if (!gameName) errors.push("Enter a game name" + where);

    var parsed = linked ? {
      list: linked.achievements.map(function (a, i) {
        return {ach_name: a.name, ach_id: null, unlock_time: a.unlock_time * 1000,
                description: a.description, apiname: a.apiname, order: i};
      }).sort(function (a, b) { return a.unlock_time - b.unlock_time; }),
      sortedBy: null, totalCount: linked.total
    } : parseExport(els.exportText.value || "");
    if (parsed.list.length === 0) errors.push("No unlocked achievements with a valid timestamp were found in the pasted text.");

    // Unlocked hidden achievements pasted without their names can't be
    // matched to the game's, so nothing can be saved until they have them.
    if (parsed.namelessCount) {
      var n = parsed.namelessCount;
      latest = {errors: [n + " unlocked achievement" + (n === 1 ? " shows" : "s show") +
        " only as \u201cThis achievement is hidden.\u201d, with no name. In SteamHunters, turn on " +
        "Settings \u2192 Show hidden achievements."], inputNotice: "danger"};
      return;
    }

    if (errors.length) { latest = {errors: errors}; return; }

    // Numbers from ArchiSteamFarm (app only); see assignNumbers.
    var numberDangers = [], numberWarnings = [];
    if (local) {
      var numbering = loadNumbers(appidVal);
      // Trying again by itself: what the last try gave stays up (its
      // message says it tries again), rather than the timeline going.
      if (numbering.status === "loading" && numbering.retrying) numbering = numbering.retrying;
      if (numbering.status === "loading") {
        latest = {errors: ["Checking the achievement numbers with ArchiSteamFarm\u2026"], pending: true,
                  steps: numbering.steps};
        return;
      }
      if (numbering.status === "ok") {
        var match = assignNumbers(parsed.list, numbering.data.achievements, !linked && !parsed.sortedBy);
        parsed.list = parsed.list.filter(function (a) { return a.ach_id; });
        parsed.sortedBy = null;  // numbers no longer depend on the paste's order
        if (match.missing.length) {
          numberDangers.push("Not in this game's achievements, so left out: " + match.missing.join(", ") +
            ". Check the App ID, or that the paste is from this game.");
        }
        var shared = sharedNamesMsg(match, !!linked);
        if (shared) numberWarnings.push(shared);
        if (match.restricted.length) {
          numberWarnings.push("Steam only lets the game itself unlock " + match.restricted.join(", ") +
            ", so aset will skip " + (match.restricted.length === 1 ? "it." : "them."));
        }
        if (parsed.list.length === 0) { latest = {errors: numberDangers, inputNotice: "danger"}; return; }
      } else if (linked) {
        latest = {errors: [numbering.message], errorTitle: numbering.title, inputNotice: "danger"};
        return;
      } else {
        numberDangers.push((numbering.title ? numbering.title + ". " : "") + numbering.message);
      }
    }

    var withDelays = addDelays(parsed.list);

    var timeMap = {};
    withDelays.forEach(function (a, i) {
      if (i === 0) return;
      (timeMap[a.unlock_time] = timeMap[a.unlock_time] || []).push(a.ach_name);
    });
    var simultaneous = Object.keys(timeMap).filter(function (t) { return timeMap[t].length > 1; });

    var split = applyEdits(splitSessions(withDelays, gapLimitSec, cumLimitSec, breaks), edits);
    var config = buildConfig(appidVal, split.sessions, split.gaps, copiedFrom, title);

    // Unlike the warnings below, a re-sorted paste makes every ach_id
    // wrong, so it's surfaced loudly (red Save button, input-pane
    // notice) rather than only as a notice in the output tabs.
    var dangers = numberDangers.slice();
    if (parsed.sortedBy) dangers.push(sortedByMsg(parsed.sortedBy));

    var warnings = numberWarnings.slice();
    if (parsed.minutesOnly) {
      warnings.push("The pasted times have no seconds, so every delay is rounded to the minute. For exact times, turn on " +
        "seconds in SteamHunters' settings and copy the page again.");
    }
    if (simultaneous.length) warnings.push(simultaneous.length + " timestamp(s) have multiple achievements unlocking together.");
    // Problems that can hit many sessions/achievements are listed in one
    // notice each rather than one notice per hit.
    var shortGaps = [];
    split.gaps.forEach(function (g, i) {
      if (g <= minGapSec) shortGaps.push({session: i + 2, gap: roughDuration(g)});
    });
    if (shortGaps.length === 1) {
      warnings.push("Session " + shortGaps[0].session + " starts only " + shortGaps[0].gap + " after the previous one (below your \"Warn if break under\" setting).");
    } else if (shortGaps.length) {
      warnings.push(shortGaps.length + " sessions start sooner after the previous one than your \"Warn if break under\" setting: " +
        shortGaps.map(function (s) { return "session " + s.session + " (" + s.gap + ")"; }).join(", ") + ".");
    }
    var longWaits = [];
    split.sessions.forEach(function (session, si) {
      session.forEach(function (a, j) {
        var key = String(a.ach_id);
        if (j > 0 && (key in edits || breaks[key] === false) && a.delay > gapLimitSec) {
          longWaits.push(a.ach_name + " (session " + (si + 1) + ", " + roughDuration(a.delay) + ")");
        }
      });
    });
    if (longWaits.length) {
      warnings.push((longWaits.length === 1 ? "1 wait is" : longWaits.length + " waits are") +
        " longer than \"Session break after\".");
    }
    // A session that lasts no time is either a lone achievement or several
    // unlocked at the same moment; say which, since both happen.
    var zeroSingle = 0, zeroTogether = 0;
    split.durations.forEach(function (d, i) {
      if (d > 1) return;
      if (split.sessions[i].length > 1) zeroTogether++; else zeroSingle++;
    });
    var zeroSessions = zeroSingle + zeroTogether;
    if (zeroSessions) {
      var why = !zeroTogether ? "a single achievement"
        : !zeroSingle ? "achievements unlocked at the same moment"
        : zeroSingle + " with a single achievement, " + zeroTogether + " with achievements unlocked at the same moment";
      warnings.push(zeroSessions + " session(s) have essentially zero duration (" + why + ").");
    }

    var suffix = gameName ? "_" + gameName : "";

    var csv = buildCsvRows(split.sessions, split.gaps, split.durations, copiedFrom);

    latest = {
      errors: [],
      dangers: dangers,
      warnings: warnings,
      config: config,
      jsonText: JSON.stringify(config, null, 2),
      csvText: toCsv(csv.rows),
      csvRows: csv.rows,
      csvTargets: csv.targets,
      gapActions: csv.gapActions,
      originals: split.originals,
      autoBreaks: split.autoBreaks,
      filenames: {
        json: "config" + suffix + ".json",
        csv: (gameName || "default") + ".csv"
      },
      stats: {
        achievements: config.achievements.length,
        totalAchievements: parsed.totalCount,
        sessions: split.sessions.length,
        sessionLen: split.durations.length ? roughDuration(Math.min.apply(null, split.durations)) + " – " + roughDuration(Math.max.apply(null, split.durations)) : "—",
        gapRange: split.gaps.length ? roughDuration(Math.min.apply(null, split.gaps)) + " – " + roughDuration(Math.max.apply(null, split.gaps)) : "—",
        // Exact, for the app: "38m – 6h 2m".
        sessionLenExact: split.durations.length ? exactRange(split.durations, true) : "—",
        gapRangeExact: split.gaps.length ? exactRange(split.gaps) : "—"
      }
    };
  }

  var combined = false;  // the app's one-screen Schedule (see enableLocal)
  var schedFull = false;  // every achievement instead of the sessions
  var scheduleReady = false;
  var schedulePanel = "import";

  function setSchedulePanel(panel, focus) {
    if (panel === "preview" && !scheduleReady) panel = "import";
    if (panel !== schedulePanel) swapIn(byId(byId("schedule-tabs").querySelector('[data-panel="' + panel + '"]').getAttribute("aria-controls")));
    schedulePanel = panel;
    byId("schedule-tabs").querySelectorAll("[data-panel]").forEach(function (tab) {
      var active = tab.getAttribute("data-panel") === panel;
      tab.setAttribute("aria-selected", String(active));
      tab.tabIndex = active ? 0 : -1;
      byId(tab.getAttribute("aria-controls")).hidden = !active;
      if (active && focus) tab.focus();
    });
  }

  function renderScheduleSource(ok) {
    var imported = ok && !scheduleReady;
    scheduleReady = !!ok;
    byId("schedule-tab-preview").disabled = !ok;
    if (ok) byId("schedule-tab-preview").removeAttribute("data-tip");
    else byId("schedule-tab-preview").setAttribute("data-tip", "Appears once achievements are imported");
    if (imported) setSchedulePanel("preview", byId("schedule-workspace").contains(document.activeElement));
    else if (!ok && schedulePanel === "preview") setSchedulePanel("import");
    if (els.exportText.value.trim() && latest && !latest.pending && !latest.inputNotice &&
        (!els.appid.value || !els.gameName.value.trim())) {
      setSchedulePanel("details");
    }
    if (!ok) return;
    var appid = parseInt(els.appid.value, 10);
    var game = ((runsData && runsData.games) || []).filter(function (g) { return g.appid === appid; })[0];
    patchHtml(byId("schedule-game"), gameIconHtml({title: els.gameName.value.trim(),
      icon: game && game.icon || heroUrls(appid)[2]}) + "<span>" + escapeHtml(els.gameName.value.trim()) + "</span>");
  }

  function fileKeyForView(view) {
    if (combined && view === "input") return "csv";
    if (view === "json") return "json";
    if (view === "csv") return "csv";
    return null;
  }

  function editCount() {
    return Object.keys(edits).length + Object.keys(breaks).length;
  }

  function isArmed(key) {
    return (armedUntil[key] || 0) > Date.now();
  }

  // First click arms `key` (render shows Confirm, in red); a second
  // click within ARM_MS returns true. Unclicked, it disarms itself.
  function confirmTwice(key) {
    if (isArmed(key)) { delete armedUntil[key]; return true; }
    armedUntil[key] = Date.now() + ARM_MS;
    setTimeout(render, ARM_MS + 50);
    render();
    return false;
  }

  function editsBannerHtml() {
    var n = editCount();
    if (!n || !showLockNotice) return "";
    var label = isArmed("discard") ? "Confirm" : "Discard";
    return '<div class="notice info edits-banner"><span>' + n + " Timeline edit" + (n === 1 ? "" : "s") +
      ", so the pasted text is locked until you " + (combined ? "save" : "download") + " or discard " + (n === 1 ? "it" : "them") + ".</span>" +
      '<button class="btn-ghost discard-edits' + (isArmed("discard") ? " armed" : "") + '" type="button">' + label + "</button></div>";
  }

  function render() {
    // Pasted text is locked while there are edits: changing it would
    // re-parse into a different achievement list the edits don't match.
    var locked = editCount() > 0;
    els.exportText.readOnly = locked;
    els.exportText.classList.toggle("locked", locked);
    // So are the options: they'd split the sessions differently.
    byId("bar-options").classList.toggle("locked", locked);
    byId("schedule-options-lock").hidden = !locked;
    if (combined) [els.gapLimit, els.cumLimit, els.minGap].forEach(function (input) { input.disabled = locked; });
    els.resetBtn.textContent = locked && isArmed("reset") ? "Confirm" : "Reset all fields";
    els.resetBtn.classList.toggle("armed", locked && isArmed("reset"));

    // nav "has content" dots
    var ok = latest && !latest.errors.length;
    ["json", "csv"].forEach(function (k) {
      navButtons[k].classList.toggle("has-content", !!ok);
    });

    // stats strip (shown once we have valid data, regardless of view)
    if (ok) {
      els.statsStrip.innerHTML =
        (combined ? [
          ["Achievements", latest.stats.achievements + " / " + latest.stats.totalAchievements],
          ["Sessions", latest.stats.sessions],
          ["Session length", latest.stats.sessionLenExact],
          ["Breaks", latest.stats.gapRangeExact]
        ].map(function (part) {
          return '<div class="summary-part"><span class="summary-label">' + part[0] +
            '</span><span class="summary-value" title="' + escapeHtml(String(part[1])) + '">' + escapeHtml(String(part[1])) + '</span></div>';
        }).join("") :
        "<span><b>" + latest.stats.achievements + " / " + latest.stats.totalAchievements + "</b> achievements</span>" +
        "<span><b>" + latest.stats.sessions + "</b> sessions</span>" +
        "<span>len <b>" + latest.stats.sessionLen + "</b></span>" +
        "<span>gap <b>" + latest.stats.gapRange + "</b></span>");
    } else if (combined) {
      els.statsStrip.innerHTML = "<span>Import achievements to preview sessions and breaks.</span>";
    } else {
      // Kept (with a hint) so the bar doesn't change height on paste.
      els.statsStrip.innerHTML = "<span>" + escapeHtml(latest && latest.pending ? latest.errors[0]
        : "Paste an export to see its achievements, sessions and gaps.") + "</span>";
    }

    // Save saves everything together, so it only depends on whether we
    // have valid data at all — not on which tab is open. Why it can't, on
    // hover: what's still missing, or that nothing's imported yet.
    els.downloadBtn.disabled = !ok;
    var saveWhy = ok ? "" : !els.exportText.value.trim() ? "Import achievements first"
      : latest && latest.errors && latest.errors[0] ? latest.errors[0] : "";
    if (saveWhy) els.downloadBtn.setAttribute("data-tip", saveWhy);
    else els.downloadBtn.removeAttribute("data-tip");

    var dangers = ok ? latest.dangers : [];
    var dangerHtml = dangers.map(function (d) { return noticeHtml("danger", d); }).join("");
    // Problems with the paste itself (a link, the numbers) show under it too.
    var inputHtml = latest && !ok && latest.inputNotice
      ? latest.errors.map(function (m) { return problemHtml(latest.inputNotice, latest.errorTitle, m); }).join("") : "";
    els.inputAlertSlot.innerHTML = (combined && ok ? "" : dangerHtml) + inputHtml + editsBannerHtml();
    els.downloadBtn.classList.toggle("btn-danger", dangers.length > 0);
    var replacing = local && isArmed("overwrite");
    els.downloadBtn.classList.toggle("armed", replacing);
    // A warning makes it red, not longer.
    els.downloadBtn.textContent = replacing ? "Confirm" : "Save";
    els.downloadBtn.title = dangers.join("\n");

    var fileKey = fileKeyForView(currentView);
    if (!fileKey) return;

    var slot = fileKey === "json" ? els.jsonSlot : els.csvSlot;
    if (fileKey === "csv" && ok) els.boxTitle.textContent = "Timeline (" + latest.filenames.csv + ")";

    // Beside the paste: the how-to until something's pasted, then the
    // timeline (its problems already show under the paste).
    if (combined) {
      var box = document.querySelector(".box");
      box.classList.toggle("has-paste", !!els.exportText.value.trim());
      box.classList.toggle("has-timeline", !!ok);
      renderScheduleSource(ok);
      // Behind it all, as in Runs: a glow in the colour of the game the
      // App ID names.
      var schedAppid = parseInt(els.appid.value, 10);
      tintFor(schedAppid > 0 ? {appid: schedAppid} : null, function (tint) {
        setTint(byId("schedule-workspace"), tint);
      }, "schedule");
      // A new App ID rebuilds the timeline (its numbers checked again), so
      // it's fixed while there are Timeline edits to lose.
      els.appid.readOnly = editCount() > 0;
      if (els.appid.readOnly) els.appid.setAttribute("data-tip", "Discard the Timeline edits to change it");
      else els.appid.removeAttribute("data-tip");
      box.classList.toggle("sched-full", !!ok && schedFull);
      byId("sched-full-btn").disabled = !ok;
      if (!latest || latest.errors.length) {
        // Import progress and missing details share the frame's status
        // area, so they stay visible while switching between panels.
        var missing = latest && !latest.inputNotice && els.exportText.value.trim() ? latest.errors : [];
        slot.innerHTML = "";
        if (els.exportText.value.trim()) els.inputAlertSlot.innerHTML +=
          latest && latest.pending ? stepsHtml(latest.errors[0], latest.steps)
            : missing.map(function (m) { return noticeHtml("info", m); }).join("");
        return;
      }
    }

    if (!latest || latest.errors.length) {
      var msgs = latest ? latest.errors : ["Paste an export first."];
      slot.innerHTML = msgs.map(function (m) {
        return latest && latest.pending ? noticeHtml("info", m) : problemHtml("danger", latest && latest.errorTitle, m);
      }).join("") +
        emptyHtml("{ }", latest && latest.pending ? "This fills in when it's done." : "Fix the issue above to generate this file.");
      return;
    }

    // Notices go under the preview (as under the paste box) so the box
    // sits in the same place on every tab.
    // All warnings share one compact box, a line each, so a long list
    // doesn't eat the preview's space.
    var warnBox = latest.warnings.length
      ? '<div class="notice warn stack">' + latest.warnings.map(function (w) {
          return "<div>" + escapeHtml(w) + "</div>";
        }).join("") + "</div>"
      : "";
    var warningsHtml = '<div class="notices-below">' + dangerHtml + warnBox + "</div>";

    if (fileKey === "json") {
      slot.innerHTML = '<pre class="file-preview">' + highlightJson(latest.jsonText) + "</pre>" + warningsHtml;
    } else if (combined && !schedFull) {
      slot.innerHTML = sessionsHtml(latest.csvRows, null) + warningsHtml;
    } else {
      slot.innerHTML = rowsToTable(latest.csvRows, {
        targets: latest.csvTargets, gapActions: latest.gapActions, edits: edits,
        originals: latest.originals, breaks: breaks, autoBreaks: latest.autoBreaks,
        achLink: local ? parseInt(els.appid.value, 10) : 0  // Jump to achievement
      }) + warningsHtml;
    }
    // Back where it was scrolled: the table is redrawn on every change,
    // and on coming back from another tab.
    var wrap = slot.querySelector(".table-wrap");
    if (wrap) wrap.scrollTop = schedScroll[schedScrollKey()] || 0;
  }
  var schedScroll = {};  // the sessions overview and Full timeline apart
  function schedScrollKey() { return schedFull ? "full" : "sessions"; }
  els.csvSlot.addEventListener("scroll", function (e) {
    if (e.target.classList.contains("table-wrap")) schedScroll[schedScrollKey()] = e.target.scrollTop;
  }, true);

  byId("sched-full-btn").addEventListener("click", function () {
    schedFull = !schedFull;
    this.setAttribute("aria-pressed", String(schedFull));
    render();
  });

  var debounceTimer = null;
  function scheduleRecompute() {
    saveDraft();
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(function () { recompute(); render(); }, 300);
  }

  function resetSettingFields() {
    els.appid.value = "";
    els.gameName.value = "";
    els.copiedFrom.value = "";
    els.gapLimit.value = "3";
    els.cumLimit.value = "6";
    els.minGap.value = "1";
  }

  // Pasting a different game's export shouldn't carry over the previous
  // game's appid/name/timing settings, so reset them the moment the export
  // text changes. Registered before the scheduleRecompute loop below so it
  // runs first and scheduleRecompute's saveDraft() sees the reset values.
  els.exportText.addEventListener("input", function () {
    resetSettingFields();
    // A repeated link already has its achievements cached, so its fetch
    // callback won't run again to restore the game and source fields.
    var source = linkSources[pastedLink(els.exportText.value)];
    if (source && source.status === "ok") fillLinkFields(source.data);
  });

  // A whole-page paste names its game: that fills in the game name, and in
  // the app the App ID too, when Steam's store has exactly one game by
  // that name (otherwise it's left for you).
  var appidLookups = {};  // title -> appid or null
  els.exportText.addEventListener("input", function () {
    var title = pastedLink(els.exportText.value) ? null : pageGame(els.exportText.value);
    if (!title) return;
    els.gameName.value = title;
    if (!local) return;
    var fill = function (appid) {
      if (appid && !els.appid.value && pageGame(els.exportText.value) === title) {
        els.appid.value = appid;
        scheduleRecompute();
      }
    };
    if (title in appidLookups) return fill(appidLookups[title]);
    api("/api/achievements/appid", {name: title}).then(function (d) {
      appidLookups[title] = d.appid;
      fill(d.appid);
    }).catch(function () {});
  });

  [els.exportText, els.appid, els.gameName, els.copiedFrom, els.gapLimit, els.cumLimit, els.minGap].forEach(function (el) {
    el.addEventListener("input", scheduleRecompute);
  });

  // Schedule: the counters icon by the App ID when the game has them; looked up
  // (in the background, by the app) once per App ID.
  var countersFor = null, countersTimer = null;
  function checkCounters(appid) {
    if (!local) return;
    appid = appid > 0 ? appid : null;
    if (appid === countersFor) return;
    countersFor = appid;
    clearTimeout(countersTimer);
    showCounters(0);
    if (!appid) return;
    var tries = 0;
    (function ask() {
      api("/api/achievements/counters?appid=" + appid).then(function (d) {
        if (countersFor !== appid) return;
        if (d.counters === null && ++tries < 15) countersTimer = setTimeout(ask, 2000);
        else showCounters(d.counters || 0);
      }).catch(function () {});
    })();
  }
  function showCounters(n) {
    byId("schedule-counters").innerHTML = counterMark({counters: n});
  }

  // [data-tip] hints, in a box over what's hovered (the app's web view
  // shows no title tooltips).
  var tipBox = null;
  document.addEventListener("mouseover", function (e) {
    var el = e.target.closest && e.target.closest("[data-tip]");
    if (!el) { if (tipBox) tipBox.hidden = true; return; }
    if (!tipBox) { tipBox = document.createElement("div"); tipBox.className = "tip-box"; document.body.appendChild(tipBox); }
    tipBox.textContent = el.getAttribute("data-tip");
    tipBox.hidden = false;
    var r = el.getBoundingClientRect(), w = tipBox.offsetWidth, h = tipBox.offsetHeight;
    // Above the icon, running to its right, the pointer at its bottom-left
    // corner (under it at the window's top, left of it at its edge).
    var left = Math.max(8, Math.min(r.left + r.width / 2, window.innerWidth - w - 8));
    var top = r.top - h - 4 < 8 ? r.bottom + 4 : r.top - h - 4;
    tipBox.style.left = left + "px";
    tipBox.style.top = top + "px";
  });

  document.addEventListener("click", function () { if (tipBox) tipBox.hidden = true; });

  function resetAll() {
    els.exportText.value = "";
    resetSettingFields();
    edits = {};
    breaks = {};
    armedUntil = {};
    scheduleReady = false;
    setSchedulePanel("import");
    try { draftStore.removeItem("unlock-scheduler-draft"); } catch (e) {}
    recompute();
    setView("input");
  }
  // The app hides the window while a game runs. Keep the current screen
  // and edits, and persist the draft for the next launch too.
  window.starWindowClosed = function () {
    saveDraft();
  };

  els.resetBtn.addEventListener("click", function () {
    if (editCount() && !confirmTwice("reset")) return;
    resetAll();
    showToast("Fields reset");
  });

  // ---- delay editing (Timeline tab) + discard-edits banner ----
  function setEdit(id, seconds) {
    if (latest && latest.originals && latest.originals[id] === seconds) delete edits[id];
    else edits[id] = seconds;
    saveDraft();
    recompute();
    render();
  }

  function currentDelay(id) {
    var ri = latest.csvTargets.indexOf(id);
    return ri < 0 ? 0 : Number(latest.csvRows[ri][CSV_DELAY_COL + 1]);
  }

  function startEditing(cell) {
    var id = cell.getAttribute("data-id");
    var input = document.createElement("input");
    input.type = "text";
    input.className = "delay-input";
    input.value = exactDuration(currentDelay(id));
    input.placeholder = "1h 20m";
    cell.textContent = "";
    cell.appendChild(input);
    input.focus();
    input.select();

    var done = false;
    function finish(save) {
      if (done) return;
      done = true;
      if (!save) { render(); return; }
      var seconds = parseDelayInput(input.value);
      if (seconds === null) {
        showToast("Enter a time like 1h 20m, 45m or 90s.");
        render();
        return;
      }
      setEdit(id, seconds);
    }
    input.addEventListener("keydown", function (e) {
      if (e.key === "Enter") finish(true);
      else if (e.key === "Escape") finish(false);
    });
    input.addEventListener("blur", function () { finish(true); });
  }

  // Adds (on=true) or removes a gap before achievement id. Matching what
  // the limits would decide anyway just drops the override.
  function setBreak(id, on) {
    if (latest && latest.autoBreaks && latest.autoBreaks[id] === on) delete breaks[id];
    else breaks[id] = on;
    saveDraft();
    recompute();
    render();
    // A new gap starts as the achievement's old delay, as in Runs; click
    // it to change it.
  }

  document.addEventListener("click", function (e) {
    var gapBtn = e.target.closest(".gap-btn");
    if (gapBtn) {
      setBreak(gapBtn.getAttribute("data-gap"), gapBtn.getAttribute("data-kind") === "add");
      return;
    }
    var undo = e.target.closest(".undo-edit");
    if (undo) {
      delete edits[undo.getAttribute("data-undo")];
      saveDraft();
      recompute();
      render();
      return;
    }
    if (e.target.closest(".discard-edits")) {
      if (!confirmTwice("discard")) return;
      edits = {};
      breaks = {};
      saveDraft();
      recompute();
      setView("input");
      showToast("Edits discarded");
      return;
    }
    var cell = e.target.closest("td.delay-cell.editable");
    if (cell && !cell.querySelector("input")) startEditing(cell);
    if (showLockNotice && e.target !== els.exportText && !e.target.closest(".edits-banner")) {
      showLockNotice = false;
      render();
    }
  });

  function noticeLocked() {
    if (!editCount() || showLockNotice) return;
    showLockNotice = true;
    render();
  }
  els.exportText.addEventListener("click", noticeLocked);
  els.exportText.addEventListener("focus", noticeLocked);


  // ---- theme (dark / light) and accent, from the Appearance menu in the
  // top bar ----
  var appearanceToggle = document.getElementById("appearance-toggle");
  var appearanceMenu = document.getElementById("appearance-menu");

  function syncThemeControls() {
    var root = document.documentElement;
    appearanceMenu.querySelectorAll("[data-theme-choice]").forEach(function (b) {
      b.setAttribute("aria-pressed", String(b.getAttribute("data-theme-choice") === root.getAttribute("data-theme")));
    });
    appearanceMenu.querySelectorAll("[data-accent-choice]").forEach(function (b) {
      b.setAttribute("aria-pressed", String(b.getAttribute("data-accent-choice") === root.getAttribute("data-accent")));
    });
    ["banners", "gradient"].forEach(function (key) {
      appearanceMenu.querySelectorAll("[data-" + key + "-choice]").forEach(function (b) {
        b.setAttribute("aria-pressed", String(b.getAttribute("data-" + key + "-choice") === root.getAttribute("data-" + key)));
      });
    });
  }

  function setAppearanceOpen(open) {
    appearanceMenu.hidden = !open;
    appearanceToggle.setAttribute("aria-expanded", String(open));
  }

  appearanceToggle.addEventListener("click", function () { setAppearanceOpen(appearanceMenu.hidden); });
  appearanceMenu.addEventListener("click", function (e) {
    var b = e.target.closest("button");
    if (!b) return;
    ["theme", "accent", "banners", "gradient"].forEach(function (key) {
      var value = b.getAttribute("data-" + key + "-choice");
      if (value) applyAppearance(key, value, true);
    });
  });
  // The look is kept in settings.json in the app (so an update doesn't
  // reset it), and in this window's storage too, so the page paints in it
  // before the server answers.
  function applyAppearance(key, value, save) {
    document.documentElement.setAttribute("data-" + key, value);
    try { localStorage.setItem("unlock-scheduler-" + key, value); } catch (err) {}
    syncThemeControls();
    if (save && local) {
      var values = {};
      values[key] = value;
      api("/api/settings", {settings: values}).then(function (d) { runSettings = d.settings; })
        .catch(function (err) { showToast("Couldn't save: " + err.message); });
    }
  }
  // Closes on a click elsewhere or Escape.
  document.addEventListener("click", function (e) {
    if (!appearanceMenu.hidden && !e.target.closest(".appearance")) setAppearanceOpen(false);
  });
  document.addEventListener("keydown", function (e) {
    if (e.key === "Escape" && !appearanceMenu.hidden) { setAppearanceOpen(false); appearanceToggle.focus(); }
  });
  syncThemeControls();

  // Save: into the data folder's jsons/ and csvs/ (saveToProject); a
  // second click (Confirm) replaces a game saved before.
  els.downloadBtn.addEventListener("click", function () {
    if (!latest || latest.errors.length) return;
    var overwrite = isArmed("overwrite");
    delete armedUntil["overwrite"];
    saveToProject(overwrite);
  });

  // ---------------------------------------------------------------
  // Local app (runsteamunlocker --ui): the same page, served from this
  // machine, which can also save straight into the project and run games.
  // Runs are background processes, so this page only shows and controls
  // them; closing it never stops anything.
  // ---------------------------------------------------------------
  var local = false;
  var runsData = null, runsError = null, runsFetchedAt = 0;
  var selectedRun = null;
  // How Run starts a game, from the bar above the list: delay (minutes
  // before the first session) and every (all sessions back to back
  // instead of just the next one).
  var runOpts = {every: false};
  // Finished games in the list (Settings → Runs; show_finished in
  // settings.json, so it survives updates). Off until the settings say.
  var showDone = false;
  try { runOpts.every = localStorage.getItem("run-every") === "1"; } catch (e) {}
  var runsTimer = null, runsFetch = null, runPending = null;

  function api(path, body) {
    var opts = body === undefined ? {} : {
      method: "POST", headers: {"Content-Type": "application/json"}, body: JSON.stringify(body)
    };
    return fetch(path, opts).then(function (r) {
      return r.json().catch(function () { return {}; }).then(function (data) {
        if (!r.ok) {
          var err = new Error(data.error || "Request failed (" + r.status + ")");
          err.data = data;
          throw err;
        }
        return data;
      });
    });
  }

  function saveToProject(overwrite) {
    var name = fileName(els.gameName.value.trim(), parseInt(els.appid.value, 10));
    var title = latest.config.game || name;
    api("/api/save", {name: name, config: latest.config, csv: latest.csvText, overwrite: overwrite})
      .then(function () {
        resetAll();
        delete timelines[name];  // re-saved: read its timeline again
        selectedRun = name;  // picked when Runs is opened
        showToast("Saved " + title + ". Start it from Runs in the top bar.");
      })
      .catch(function (err) {
        // Asked with a second click rather than a dialog, which the
        // desktop app's window may not show.
        if (err.data && err.data.exists) {
          armedUntil["overwrite"] = Date.now() + ARM_MS;
          setTimeout(render, ARM_MS + 50);
          render();
          showToast(err.message + " Confirm to replace it (its progress is kept).");
          return;
        }
        showToast("Couldn't save: " + err.message);
      });
  }

  // "2h 10m", "4m", "35s"
  function fmtDur(seconds) {
    seconds = Math.max(0, Math.round(seconds));
    var d = Math.floor(seconds / 86400), h = Math.floor(seconds % 86400 / 3600), m = Math.floor(seconds % 3600 / 60);
    if (d) return d + "d " + h + "h";
    if (h) return h + "h " + m + "m";
    if (m) return m + "m";
    return seconds + "s";
  }

  // Clock time `seconds` from now, with the weekday when it isn't today.
  // When something happens: the time today, "Tomorrow", a weekday within
  // the coming week, and past that the date ("Nov 6"), so a day name never
  // means a later week's.
  // "Playable at 5:30 PM", "Playable tomorrow 9:00 AM": a game on its
  // break, on hover.
  function playableAt(seconds) {
    var at = fmtAt(seconds);
    return "Playable " + (/^\d/.test(at) ? "at " + at : at.replace(/^Tomorrow/, "tomorrow"));
  }
  function fmtAt(seconds) {
    var now = new Date(), at = new Date(now.getTime() + seconds * 1000);
    var time = fmtClock(at);
    var day = function (d) { return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime(); };
    var days = Math.round((day(at) - day(now)) / 86400000);
    if (days <= 0) return time;
    if (days === 1) return "Tomorrow " + time;
    if (days < 7) return at.toLocaleDateString([], {weekday: "short"}) + " " + time;
    var date = {month: "short", day: "numeric"};
    if (at.getFullYear() !== now.getFullYear()) date.year = "numeric";
    return at.toLocaleDateString([], date) + ", " + time;
  }

  // Countdowns come from the last fetch; count them down in between.
  function left(seconds) {
    return Math.max(0, seconds - (Date.now() - runsFetchedAt) / 1000);
  }

  function gameTitle(g) { return g.title || g.name; }
  // The glow's colours on el (see tintFor), or none.
  function setTint(el, tint) {
    if (tint) {
      el.style.setProperty("--run-tint", tint[0]);
      el.style.setProperty("--run-tint-2", tint[1]);
    } else {
      el.style.removeProperty("--run-tint");
      el.style.removeProperty("--run-tint-2");
    }
  }
  // A game's two main colours (["r, g, b", "r, g, b"]), from its art: the
  // most common colourful shade, so a dark or grey background doesn't win,
  // and the next one that's clearly different (else the first again).
  // Worked out once per game and remembered on this computer.
  var tints = {};
  try {
    tints = JSON.parse(localStorage.getItem("game-tints-2") || "{}") || {};
    localStorage.removeItem("game-tints");  // one colour each, before
  } catch (e) {}
  var tintWanted = {};  // per place it shows (Runs, Schedule): the latest asked
  function tintFor(g, done, place) {
    place = place || "runs";
    var appid = g && g.appid > 0 ? g.appid : null;
    tintWanted[place] = appid;
    if (!appid) return done(null);
    if (appid in tints) return done(tints[appid]);
    var img = new Image();
    img.crossOrigin = "anonymous";
    img.onload = function () {
      var tint = null;
      try {
        var canvas = document.createElement("canvas");
        canvas.width = 48; canvas.height = 16;
        var ctx = canvas.getContext("2d");
        ctx.drawImage(img, 0, 0, 48, 16);
        var px = ctx.getImageData(0, 0, 48, 16).data, buckets = {}, best = null;
        for (var i = 0; i < px.length; i += 4) {
          var r = px[i], gr = px[i + 1], b = px[i + 2];
          var max = Math.max(r, gr, b), min = Math.min(r, gr, b);
          if (max < 40 || max - min < 30) continue;  // too dark or grey
          var key = (r >> 5) + "," + (gr >> 5) + "," + (b >> 5);
          var k = buckets[key] || (buckets[key] = {n: 0, r: 0, g: 0, b: 0});
          var w = (max - min) / max;  // the more colourful, the more it counts
          k.n += w; k.r += r * w; k.g += gr * w; k.b += b * w;
          if (!best || k.n > best.n) best = k;
        }
        var rgb = function (k) { return [k.r / k.n, k.g / k.n, k.b / k.n]; };
        var hue = function (c) {
          var mx = Math.max.apply(null, c), mn = Math.min.apply(null, c), d = mx - mn || 1;
          var h = mx === c[0] ? (c[1] - c[2]) / d : mx === c[1] ? 2 + (c[2] - c[0]) / d : 4 + (c[0] - c[1]) / d;
          return (h * 60 + 360) % 360;
        };
        if (best) {
          var first = rgb(best), second = first;
          Object.keys(buckets).map(function (key) { return buckets[key]; })
            .sort(function (a, b) { return b.n - a.n; })
            .some(function (k) {
              if (k.n < best.n * 0.15) return true;  // too little of it to count
              var c = rgb(k), d = Math.abs(hue(c) - hue(first));
              if (Math.min(d, 360 - d) > 40) { second = c; return true; }  // another hue, not a shade
              return false;
            });
          var str = function (c) { return c.map(Math.round).join(", "); };
          tint = [str(first), str(second)];
        }
      } catch (e) {}
      tints[appid] = tint;
      try { localStorage.setItem("game-tints-2", JSON.stringify(tints)); } catch (e) {}
      if (tintWanted[place] === appid) done(tint);
    };
    // No library art: the next picture Steam has for the game.
    var tries = heroUrls(appid);
    img.onerror = function () {
      if (tries.length) img.src = tries.shift();
      else if (tintWanted[place] === appid) done(null);
    };
    img.src = tries.shift();
  }

  // The game's wide art, as CSS urls, or "none" without an appid: its
  // library art (no logo), else its store page's background, else its
  // header. Stacked, the first that loads covers the rest.
  function heroUrl(g) {
    return g && g.appid > 0 ? heroUrls(g.appid).map(function (u) { return 'url("' + u + '")'; }).join(", ") : "none";
  }
  // Steam's current image host (the older cdn.cloudflare one lacks newer
  // games' images).
  // Some games have no library art (Attack on Titan 2, ReCore): then the
  // store page's background, then the header image.
  function heroUrls(appid) {
    return ["library_hero.jpg", "page_bg_raw.jpg", "header.jpg"].map(function (f) {
      return "https://shared.fastly.steamstatic.com/store_item_assets/steam/apps/" + appid + "/" + f;
    });
  }
  // A game's or achievement's icon from Steam; when there's none, or it
  // doesn't load, a stand-in: the game's first letter, or a trophy.
  var TROPHY = '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
    '<path d="M5 2.5h6v3.2a3 3 0 0 1-6 0z"/><path d="M5 3.6H3.2a2 2 0 0 0 2 2.6M11 3.6h1.8a2 2 0 0 1-2 2.6M8 8.7v2.6M5.6 13.5h4.8M6.4 11.3h3.2l.4 2.2H6z"/></svg>';
  function iconHtml(cls, url, stand) {
    var ph = stand === "ach" ? "ach" : (String(stand || "?").trim().charAt(0) || "?").toUpperCase();
    if (url) return '<img class="' + cls + '" src="' + escapeHtml(url) + '" alt="" loading="lazy" data-ph="' + escapeHtml(ph) + '">';
    return '<span class="' + cls + ' icon-ph" aria-hidden="true">' + (ph === "ach" ? TROPHY : escapeHtml(ph)) + "</span>";
  }
  document.addEventListener("error", function (e) {
    var img = e.target;
    if (!img || img.tagName !== "IMG" || !img.hasAttribute("data-ph")) return;
    var ph = img.getAttribute("data-ph"), span = document.createElement("span");
    span.className = img.className + " icon-ph";
    span.setAttribute("aria-hidden", "true");
    if (ph === "ach") span.innerHTML = TROPHY; else span.textContent = ph;
    img.replaceWith(span);
  }, true);
  function gameIconHtml(g) { return iconHtml("game-icon", g.icon, gameTitle(g)); }

  // When the game's next session can start: its break, and for a run
  // started with Start in, that delay too.
  function waitLeft(g) {
    return Math.max(left(g.ready_in || 0), g.running && g.starts_in ? left(g.starts_in) : 0);
  }

  function sessionDuration(seconds) { return Number(seconds) === 0 ? "Instant" : fmtDur(seconds); }

  // A card says just enough to pick a game: its session and when it can
  // play. The Details tab has the rest.
  // The card's badge, as an icon (its word on hover): playing, waiting to
  // start, stopped partway through a session.
  var PLAY_ICON = '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M5 3.3v9.4l7.3-4.7z" fill="currentColor"/></svg>';
  var WAIT_ICON = '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
    '<path d="M4.5 2.5h7M4.5 13.5h7M5.5 2.5c0 3 5 3.5 5 5.5s-5 2.5-5 5.5M10.5 2.5c0 3-5 3.5-5 5.5s5 2.5 5 5.5"/></svg>';
  var STOP_ICON = '<svg viewBox="0 0 16 16" aria-hidden="true"><rect x="4" y="4" width="8" height="8" rx="1.5" fill="currentColor"/></svg>';
  function runCardHtml(g) {
    // A game still in its break says when it can play, and looks it;
    // one that can play now just shows its session.
    var wait = g.session ? waitLeft(g) : 0;
    // Stopped partway through a session: a stop icon (how far it got on
    // hover).
    var cut = !g.running && g.state === "idle" && g.cut_short;
    var resting = !g.running && g.state === "idle" && wait > 0 && !cut;
    var badge = g.state === "in_session" ? ["live", PLAY_ICON, "Playing"]
      : g.running ? ["wait", WAIT_ICON, "Waiting to start"]
      : g.state === "invalid" ? ["bad", "Problem"]
      : cut ? ["cut", STOP_ICON, "Stopped at " + cut.played + " of " + cut.of]
      : g.finished || g.state === "completed" ? ["", "Done"] : null;
    var meta;
    if (g.state === "invalid") meta = g.progress_damaged ? "Its progress needs resetting." : "The config has a problem.";
    else if (g.finished || g.state === "completed") meta = "All achievements unlocked.";
    else if (!g.session) meta = g.total ? g.done + " / " + g.total + " achievements" : "";
    // Just the session: Playing / Waiting is the badge, and the next
    // unlock or start is in the selected game's summary.
    else meta = "Session " + g.session + " of " + g.sessions;
    // On a break: dimmed, with a clock; when it can play is on hover and
    // in the line over its sessions.
    var clock = resting ? '<span class="run-rest-mark" data-tip="' + escapeHtml(playableAt(wait)) + '"><svg class="run-rest" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" ' +
      'stroke-linecap="round" aria-hidden="true"><circle cx="8" cy="8" r="6.2"/><path d="M8 4.8V8l2.2 1.5"/></svg></span>' : "";
    var over = g.finished || g.state === "completed";
    return '<div class="run-card' + (g.name === selectedRun ? " selected" : "") + (resting ? " resting" : "") + (over ? " over" : "") + (cut ? " cut" : "") +
      '" role="button" tabindex="0" aria-pressed="' + (g.name === selectedRun) + '" data-name="' + escapeHtml(g.name) + '"' +
      (g.appid > 0 ? ' style="--card-hero: ' + escapeHtml(heroUrl(g)) + '"' : "") + ">" +
      '<div class="run-head">' + gameIconHtml(g) + '<span class="run-name">' + escapeHtml(gameTitle(g)) + "</span>" + counterMark(g) + clock +
      (badge ? '<span class="run-badge ' + badge[0] + '"' + (badge[2] ? ' data-tip="' + escapeHtml(badge[2]) + '" aria-label="' + escapeHtml(badge[2]) + '"' : "") +
        ">" + badge[1] + "</span>" : "") + "</div>" +
      (meta ? '<div class="run-meta">' + meta + "</div>" : "") +
      "</div>";
  }

  // Over the selected game's sessions: its name, then a bar of four
  // parts: session, this session's size, progress, and when it plays.
  function summaryHtml(g) {
    if (!g) return "";
    // In the app, the game's icon opens its page in Library (a books icon
    // over it on hover), as a game's page there opens it here.
    var icon = local && g.appid > 0 ? '<button class="game-run game-run-small" type="button" data-lib-game="' + g.appid +
      '" data-tip="Open in Library" aria-label="Open in Library">' + gameIconHtml(g) + '<span class="game-run-play">' + LIBRARY_ICON + "</span></button>"
      : gameIconHtml(g);
    var title = '<div class="run-summary-title">' + icon + "<span>" + escapeHtml(gameTitle(g)) + "</span></div>";
    // A small arrow opens the schedule's info (App ID, where it came from)
    // under the summary.
    var more = '<button class="summary-more" type="button" data-run-info aria-expanded="' + !!runInfoOpen + '" title="' +
      (runInfoOpen ? "Hide" : "Show") + ' App ID and where it came from" aria-label="Schedule info">' +
      '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4.5 6.5 8 10l3.5-3.5"/></svg></button>';
    if (g.state === "invalid") {
      // A damaged progress file: reset it from here (clicked twice).
      var reset = g.progress_damaged && !g.running ? ' <button class="btn-ghost reset-progress' + (isArmed("reset-progress:" + g.name) ? " armed" : "") +
        '" type="button" data-reset-progress>' + (isArmed("reset-progress:" + g.name) ? "Confirm reset" : "Reset progress") + "</button>" : "";
      return title + '<div class="run-summary-line"><span class="bad">' + escapeHtml(g.error || "The config has a problem.") + "</span>" + reset + more + "</div>";
    }
    if (g.finished || g.state === "completed") return title + '<div class="run-summary-line">All achievements unlocked' + more + "</div>";
    var parts = [];
    var cut = !g.running && g.state === "idle" && g.cut_short;
    function part(label, value) {
      parts.push('<div class="summary-part"><span class="summary-label">' + label + '</span><span class="summary-value">' +
        value + "</span></div>");
    }
    if (g.session) {
      part(g.state === "in_session" ? "Playing session" : "Session", g.session + " of " + g.sessions +
        (g.running ? ' <span class="summary-note">· ' + (g.stop_after ? "this one only" : "all sessions") + "</span>" : ""));
      // While it plays, how long it has left; otherwise how long it lasts
      // (a stopped one's wait for its next unlock is part of it).
      var size = g.count + " achievement" + (g.count === 1 ? "" : "s") + " · " +
        (g.state === "in_session" && g.session_left != null ? fmtDur(left(g.session_left)) + " left"
          : sessionDuration(cut ? Math.round(g.duration + left(g.ready_in || 0)) : g.duration));
      // Stopped partway: what's left of it, in yellow, why on hover.
      part("This session", cut ? '<span class="warn" data-tip="Session ' + g.session + " stopped after " + cut.played + " of its " + cut.of +
        ' achievements; Continue picks up here">' + size + "</span>" : size);
    }
    if (g.total) part("Unlocked", g.done + " of " + g.total + " scheduled");
    if (g.state === "in_session") {
      part("Next unlock", g.next_unlock_in == null ? "Now" : "In " + fmtDur(left(g.next_unlock_in)));
    } else if (g.session) {
      // A stopped session carries on whenever, so it's playable now.
      var wait = cut ? 0 : waitLeft(g);
      part(g.running ? "Starts" : "Playable", wait > 0 ? escapeHtml(fmtAt(wait)) : g.running ? "Starting…" : "Now");
    }
    parts[parts.length - 1] = parts[parts.length - 1].replace(/<\/div>$/, more + "</div>");
    return title + '<div class="summary-bar">' + parts.join("") + "</div>" +
      (g.config_changed ? '<div class="run-summary-line"><span class="warn">The achievement order changed: run it once from the terminal to confirm.</span></div>' : "");
  }

  // Info: where the schedule came from, a click away.
  function infoHtml(g) {
    if (!g) return "";
    var rows = [];
    function row(label, value) { rows.push("<dt>" + label + "</dt><dd>" + value + "</dd>"); }
    if (g.appid) row("App ID", String(g.appid));
    if (g.copied_from) row("Copied from", escapeHtml(g.copied_from));
    row("Saved as", escapeHtml(g.name));
    if (g.finished) row("Files", "Moved to completed/ in the data folder");
    return '<dl class="details-list">' + rows.join("") + "</dl>";
  }

  // Minutes from the Start choice, or null when Other… holds something
  // that isn't a time: "45" or "45m", "1h30m", "2h", or a clock time
  // ("23:30", the next time it's that).
  function runDelayMinutes() {
    var choice = byId("run-delay").value;
    if (choice !== "custom") return Number(choice);
    var text = byId("run-delay-custom").value.trim().toLowerCase().replace(/\s+/g, "");
    var m;
    if ((m = /^(\d{1,2}):(\d{2})$/.exec(text)) && +m[1] < 24 && +m[2] < 60) {
      var now = new Date(), at = new Date(now);
      at.setHours(+m[1], +m[2], 0, 0);
      if (at <= now) at.setDate(at.getDate() + 1);
      return Math.max(1, Math.round((at - now) / 60000));
    }
    if ((m = /^(?:(\d+)h)?(?:(\d+)m?)?$/.exec(text)) && text && (m[1] || m[2])) {
      var minutes = (+m[1] || 0) * 60 + (+m[2] || 0);
      return minutes <= 24 * 60 ? minutes : null;
    }
    return null;
  }

  // The bar acts on the selected game: Run or Continue it (a menu: when
  // it starts, how much it plays), or while it's running, Stop it.
  function selectedGame() {
    return (runsData ? runsData.games : []).filter(function (x) { return x.name === selectedRun; })[0];
  }

  // How long before a break ends Continue can start (break_wait), in
  // seconds: 0 when it's off.
  function breakWaitAllowed() {
    var s = (runSettings || []).filter(function (x) { return x.key === "break_wait"; })[0];
    var value = s ? s.value : "6h";
    return value === "off" ? 0 : parseInt(value, 10) * 3600;
  }

  // 1 session / All sessions.
  function setRunMode(every, disabled) {
    byId("run-mode").value = every ? "1" : "0";
    byId("run-mode").disabled = !!disabled;
  }

  // The Run menu's chips, from the two selects' choices; Other…, picked,
  // is the box for a time in its place. Drawn again only when a choice
  // changes, so the box keeps its focus while typing.
  // Enter in the box makes it a chip like the others ("In 2h", "At 23:30");
  // clicking that chip opens the box again.
  var runChipsDrawn = "", customDone = false, lastPresetDelay = "0";
  function customLabel() {
    var text = byId("run-delay-custom").value.trim();
    if (/:/.test(text)) return "At " + text;
    var minutes = runDelayMinutes(), h = Math.floor(minutes / 60), m = minutes % 60;
    // Worded like the other chips: "In 30 min", "In 1 hour".
    return "In " + [h ? h + (h === 1 ? " hour" : " hours") : "", m || !h ? m + " min" : ""].filter(Boolean).join(" ");
  }
  function runChips(select) {
    return [].map.call(select.options, function (o) {
      var on = o.value === select.value, text = o.text;
      if (on && o.value === "custom") {
        if (!customDone) return '<span data-custom-slot></span>';
        text = escapeHtml(customLabel());
      }
      return '<button class="filter-chip' + (on ? " on" : "") + '" type="button" data-value="' + o.value + '" aria-pressed="' + on + '">' + text + "</button>";
    }).join("");
  }
  // A choice of two, as one switch (Play, like Filters' Match).
  function segHtml(select) {
    return [].map.call(select.options, function (o) {
      var on = o.value === select.value;
      return '<button class="' + (on ? "on" : "") + '" type="button" data-value="' + o.value + '" aria-pressed="' + on + '">' + o.text + "</button>";
    }).join("");
  }
  function drawRunChips() {
    var delay = byId("run-delay"), mode = byId("run-mode");
    var key = delay.value + " " + mode.value + " " + (customDone ? customLabel() : "");
    if (key === runChipsDrawn) return;
    runChipsDrawn = key;
    var custom = byId("run-delay-custom");
    byId("run-pop-hold").appendChild(custom);  // out of the way while the chips redraw
    byId("run-delay-chips").innerHTML = runChips(delay);
    var slot = byId("run-delay-chips").querySelector("[data-custom-slot]");
    if (slot) slot.replaceWith(custom);
    byId("run-mode-chips").innerHTML = segHtml(mode);
  }
  function renderRunBar(games) {
    var g = selectedGame();
    var other = games.filter(function (x) { return x.running && (!g || x.name !== g.name); })[0];
    var button = byId("run-start"), delay = byId("run-delay"), mode;
    var custom = byId("run-delay-custom");
    var running = !!(g && g.running), done = !!(g && (g.finished || g.state === "completed"));
    var minutes = runDelayMinutes(), why = "", blocked = false;
    custom.hidden = delay.value !== "custom";
    custom.classList.toggle("invalid", !custom.hidden && custom.value.trim() !== "" && minutes === null);
    if (running) {
      var armed = isArmed("stop:" + g.name);
      button.textContent = armed ? "Confirm" : "Stop";
      button.className = "btn-hero run-start" + (armed ? " armed" : "");
      mode = !g.stop_after;
    } else if (done && g.finished) {
      button.textContent = "Dismiss";
      button.className = "btn-hero run-start";
      mode = runOpts.every;
    } else {
      if (!g) why = "Select a game.";
      else if (done) why = gameTitle(g) + " is done.";
      else if (g.state === "invalid") why = g.progress_damaged ? gameTitle(g) + "'s progress needs resetting (Reset progress)." : gameTitle(g) + "'s config has a problem.";
      else if (g.config_changed) why = "The achievement order changed. Run it once from the terminal to confirm.";
      else if (other) why = "Only one game runs at a time. Stop " + gameTitle(other) + " first.";
      else if (g.session && !g.cut_short && waitLeft(g) > breakWaitAllowed()) {
        // A session that ended: its break first, unless it ends within
        // break_wait (Run settings), when the run waits it out. (One stopped
        // partway can carry on.)
        var at = fmtAt(waitLeft(g));
        why = "Playable " + (/^\d/.test(at) ? "at " + at : at.replace(/^Tomorrow/, "tomorrow"));
      }
      blocked = !!why;  // the menu doesn't open
      if (blocked) byId("run-menu").open = false;
      // The confirmation stays inside the menu, beside its choices.
      button.textContent = g && g.done ? "Continue" : "Run";
      button.className = "btn-hero run-start primary";
      mode = runOpts.every;
    }
    if (runPending) {
      blocked = true;
      button.textContent = runPending === "run" ? "Starting…" : runPending === "stop" ? "Stopping…"
        : runPending === "dismiss" ? "Dismissing…" : "Updating…";
      byId("run-menu").open = false;
    }
    if (running || done) byId("run-menu").open = false;
    // Dim the open menu's trigger, while allowing another click to close it.
    // Pending requests still disable the control completely.
    button.classList.toggle("is-disabled", blocked);
    button.classList.toggle("menu-open", byId("run-menu").open);
    button.setAttribute("aria-disabled", String(blocked));
    button.setAttribute("aria-busy", String(!!runPending));
    // Why it can't run, on hover (the app's web view shows no title).
    if (blocked && why) button.setAttribute("data-tip", why);
    else button.removeAttribute("data-tip");
    delay.disabled = custom.disabled = !!runPending || running || done;
    setRunMode(mode, !!runPending || done || (running && !g.auto));
    drawRunChips();
    renderRunConfirmation(g, blocked || running || done, minutes);
  }

  function renderRunConfirmation(g, blocked, minutes) {
    var valid = minutes !== null;
    var waiting = g ? Math.max(waitLeft(g), (minutes || 0) * 60) : 0;
    var every = byId("run-mode").value === "1";
    var action = byId("run-confirm");
    action.disabled = blocked || !valid;
    action.textContent = waiting > 0 ? "Schedule run" : every ? "Start all sessions" : "Start session";
    var custom = byId("run-delay-custom");
    if (byId("run-delay").value === "custom") custom.setAttribute("aria-invalid", String(!valid));
    else custom.removeAttribute("aria-invalid");
  }

  // Runs is redrawn every few seconds while it's open. This changes only
  // the parts whose HTML changed (a card, the summary's line), so what's
  // the same, like the game art and icons, isn't rebuilt (and doesn't
  // blink).
  function patchHtml(el, html) {
    if (el._html === html) return;
    el._html = html;
    // Made in this document (not a template's), so pictures load as usual.
    var box = document.createElement("div");
    box.innerHTML = html;
    var next = [].slice.call(box.childNodes), now = [].slice.call(el.childNodes);
    if (next.length !== now.length) { el.innerHTML = html; return; }
    next.forEach(function (node, i) {
      var old = now[i];
      if (old.isEqualNode(node)) return;
      // Only its own attributes changed (a card picked, say): those change in
      // place, so its art isn't loaded again (and doesn't flash).
      if (old.nodeType === 1 && node.nodeType === 1 && old.tagName === node.tagName && old.innerHTML === node.innerHTML) {
        [].slice.call(old.attributes).forEach(function (a) { if (!node.hasAttribute(a.name)) old.removeAttribute(a.name); });
        [].slice.call(node.attributes).forEach(function (a) { if (old.getAttribute(a.name) !== a.value) old.setAttribute(a.name, a.value); });
        return;
      }
      el.replaceChild(node, old);
    });
  }

  var runsDone = null;  // achievements the runs have unlocked, all told
  function renderRuns() {
    var games = runsData ? runsData.games : [];
    var done = games.reduce(function (n, g) { return n + (g.done || 0); }, 0);
    if (runsDone !== null && done > runsDone) expectCheck();
    runsDone = done;
    var running = games.filter(function (g) { return g.running; }).length;
    byId("run-options").hidden = !games.length;
    byId("switch-runs").classList.toggle("has-content", running > 0);
    if (currentView !== "runs") { renderRunBar(games); return; }
    // One game runs at a time, so its name says more than a count.
    var runningGame = games.filter(function (g) { return g.running; })[0];
    // Over the list: games still to play (finished ones counted apart),
    // and anything else holding ArchiSteamFarm, like an update.
    var finished = games.filter(function (g) { return !g.running && (g.finished || g.state === "completed"); }).length;
    var head = runsData ? [(games.length - finished) + " game" + (games.length - finished === 1 ? "" : "s")] : [];
    if (finished && showDone) head.push(finished + " finished");
    if (runsData && runsData.session && (!runningGame || runsData.session !== runningGame.name)) {
      head.push("busy: " + runsData.session);
    }
    byId("runs-list-head").textContent = head.join(" · ");

    if (runsError) {
      patchHtml(els.runsList, noticeHtml("danger", "Can't reach the app: " + runsError +
        ". Start it again with runsteamunlocker --ui."));
    } else if (!runsData) {
      patchHtml(els.runsList, "");
    } else if (!games.length) {
      patchHtml(els.runsList, emptyHtml("▶", "No games yet. Make one under Schedule, then save it."));
    } else {
      // The running game is pinned to the top until it stops; finished
      // games go to the bottom, or out of the list (Settings → Runs).
      var isDone = function (g) { return !g.running && (g.finished || g.state === "completed"); };
      var listed = games.filter(function (g) { return g.running; })
        .concat(games.filter(function (g) { return !g.running && !isDone(g); }))
        .concat(showDone ? games.filter(isDone) : []);
      if (listed.length && !listed.some(function (g) { return g.name === selectedRun; })) {
        selectedRun = listed[0].name;
      }
      patchHtml(els.runsList, listed.length ? listed.map(runCardHtml).join("")
        : emptyHtml("▶", "Every game is finished. Turn on Show finished games in Settings to see them."));
    }
    var shown = selectedGame();
    renderRunBar(games);
    // Behind the selected game: a glow in its art's main colour.
    tintFor(runsError ? null : shown, function (tint) {
      setTint(document.querySelector(".runs-log"), tint);
    });
    patchHtml(byId("run-summary"), runsError ? "" : summaryHtml(shown));
    patchHtml(byId("run-info"), runsError ? "" : infoHtml(shown));
    byId("run-info").hidden = !runInfoOpen || !shown;
    renderTimeline();
  }

  // ---- a game's timeline on Runs: its saved CSV, in the builder's table
  // (read-only), with what's unlocked so far dimmed ----
  var runsPane = "timeline";
  var timelines = {};      // name -> {rows, config}, or null when there's no CSV
  var timelineShown = "";  // what's drawn, so polling doesn't redraw it

  // The CSV the builder saves: commas, "quoted" cells with "" inside.
  function parseCsv(text) {
    var rows = [], row = [], cell = "", quoted = false;
    for (var i = 0; i < text.length; i++) {
      var c = text[i];
      if (quoted) {
        if (c === '"' && text[i + 1] === '"') { cell += '"'; i++; }
        else if (c === '"') quoted = false;
        else cell += c;
      } else if (c === '"') quoted = true;
      else if (c === ",") { row.push(cell); cell = ""; }
      else if (c === "\n" || c === "\r") {
        if (c === "\r" && text[i + 1] === "\n") i++;
        row.push(cell); rows.push(row); row = []; cell = "";
      } else cell += c;
    }
    if (cell || row.length) { row.push(cell); rows.push(row); }
    return rows;
  }

  // Editing (unlocked with Edit): the delays of achievements not unlocked
  // yet, and the breaks before sessions not started, saved back into the
  // config and CSV. {name, rows, edited: {row: original seconds}}
  var runEdit = null;

  function runGame() {
    return ((runsData && runsData.games) || []).filter(function (g) { return g.name === selectedRun; })[0] || {};
  }

  function doneCount(game) {
    return game.done != null ? game.done : game.state === "completed" ? Infinity : 0;
  }

  // Which rows' delay_s can be edited: an achievement after the first of
  // its session, or a gap, as long as what it delays isn't unlocked yet.
  function editableRows(rows, done) {
    var editable = {}, index = -1, pendingGap = null;
    rows.forEach(function (r, ri) {
      if (ri === 0) return;
      if (isLabelRow(r)) {
        if (/^Gap/.test(r[0])) pendingGap = ri;
        return;
      }
      index++;
      if (pendingGap !== null && index >= done) editable[pendingGap] = true;
      pendingGap = null;
      if (String(r[1]) !== "1" && index >= done) editable[ri] = true;
    });
    return editable;
  }

  // The sessions overview: a row per session with its achievements, its
  // length and the break before it; done ones dimmed, the current marked.
  function sessionsHtml(rows, current) {
    var sessions = [], gap = null;
    rows.slice(1).forEach(function (r) {
      if (!isLabelRow(r)) return;
      var secs = Number(r[CSV_DELAY_COL + 1]) || 0, m;
      if (/^Gap before session/.test(r[0])) { gap = secs; return; }
      if ((m = /^Session (\d+) \((\d+)/.exec(r[0]))) {
        sessions.push({n: +m[1], count: +m[2], length: secs, gap: gap});
        gap = null;
      }
    });
    var dur = fmtDur;
    return '<div class="table-wrap"><table class="csv-table sessions-summary"><thead><tr>' +
      "<th>Session</th><th>Achievements</th><th>Length</th><th>Break before</th></tr></thead><tbody>" +
      sessions.map(function (x) {
        var cls = current && x.n < current ? "done-row" : x.n === current ? "next-row" : "";
        return "<tr" + (cls ? ' class="' + cls + '"' : "") + "><td>" + x.n + "</td><td>" + x.count + "</td><td>" +
          sessionDuration(x.length) + "</td><td>" + (x.gap == null ? "—" : dur(x.gap)) + "</td></tr>";
      }).join("") + "</tbody></table></div>";
  }

  // Runs' full timeline: what's unlocked dimmed, the next one marked while
  // it plays; unlocked for editing, the delays and breaks still ahead can
  // change (editable: the rows whose delay can).
  function timelineHtml(rows, done, running, editable) {
    return timelineTable(rows, {
      rowClass: function (index) { return index < done ? "done-row" : index === done && running ? "next-row" : ""; },
      achLink: runEdit ? 0 : runGame().appid,  // Jump to achievement, while locked
      edit: function (ri) {
        if (!editable || !editable[ri]) return null;
        return {cls: "run-editable", attr: 'data-row="' + ri + '"', undoAttr: 'data-run-undo="' + ri + '"',
                original: runEdit.edited[ri]};
      },
      // + starts a new session at an achievement still ahead, − removes a
      // break before a session still ahead.
      gapButton: function (ri, r) {
        if (!runEdit || !editable || (!isLabelRow(r) && String(r[1]) === "1")) return "";
        var k = runEdit.rowAch[ri], a = runEdit.config.achievements[k];
        if (k === undefined || !a) return "";
        var add = !a.new_session;
        if (add ? k < done : k <= done) return "";
        var changed = !!a.new_session !== !!runEdit.base.achievements[k].new_session;
        return '<button class="gap-btn' + (changed ? " edited" : "") + '" type="button" data-run-break="' + k + '" title="' +
          (add ? "Start a new session at this achievement" : "Remove this break (merge into the previous session)") + '">' +
          (add ? "+" : "−") + "</button>";
      }
    });
  }

  function renderTimeline() {
    var data = selectedRun ? timelines[selectedRun] : undefined;
    if (data === undefined && selectedRun) loadTimeline(selectedRun);
    if (data === undefined || data === "loading") return;
    if (runEdit && runEdit.name !== selectedRun) runEdit = null;
    var game = runGame(), done = doneCount(game);
    var rows = runEdit ? runEdit.rows : data && data.rows;
    var key = [selectedRun, done, !!game.running, !!rows, runFull, game.session, runEdit ? JSON.stringify(runEdit.rows) : ""].join("|");
    if (key === timelineShown) return;
    timelineShown = key;
    // Every achievement (no log) for Full timeline, and while editing.
    var full = runFull || !!runEdit;
    byId("run-full-btn").disabled = !!runEdit;  // it's needed for editing
    byId("workspace-runs-tabs").querySelector('[data-run-view="overview"]').disabled = !!runEdit;
    document.querySelector(".runs-log").classList.toggle("full", full);
    byId("run-activity").hidden = full;

    byId("run-full-btn").hidden = !(rows && rows.length > 1);  // nothing more to show without a timeline
    var canEdit = !!(data && data.config && rows && rows.length > 1 && game.state !== "completed");
    // The lock is in the full timeline only, where delays are changed, so
    // it never switches the view.
    byId("timeline-bar").hidden = !canEdit || !full;
    // The same lock as Settings: open it to change delays; closing it
    // again drops anything not saved.
    var lock = byId("timeline-lock");
    lock.setAttribute("aria-pressed", String(!!runEdit));
    lock.disabled = !!game.running && !runEdit;
    lock.setAttribute("data-tip", game.running ? "Stop the game to change its timeline"
      : runEdit ? "Cancel editing: changes you haven't saved are discarded" : "Edit the delays and breaks still ahead");
    byId("timeline-lock-label").textContent = runEdit ? "Cancel editing" : "Edit timeline";
    byId("timeline-save").hidden = !runEdit;
    byId("timeline-save").disabled = !runEdit || JSON.stringify(runEdit.config) === JSON.stringify(runEdit.base);
    byId("timeline-bar-text").textContent = "";  // the lock's tooltip says it

    byId("timeline-table").innerHTML = rows && rows.length > 1
      ? (runFull || runEdit ? timelineHtml(rows, done, game.running, runEdit && editableRows(rows, done))
        : sessionsHtml(rows, game.session))
      : emptyHtml("☰", "No timeline was saved with this game.");
    // Back where it was scrolled: redrawing (after an edit) starts it at the top.
    var wrap = byId("timeline-table").querySelector(".table-wrap");
    if (wrap) wrap.scrollTop = timelineScroll[timelineScrollKey()] || 0;
  }
  var timelineScroll = {};  // by game, its sessions overview and full timeline apart
  function timelineScrollKey() { return selectedRun + (runFull || runEdit ? "|full" : ""); }
  byId("timeline-table").addEventListener("scroll", function (e) {
    if (e.target.classList.contains("table-wrap")) timelineScroll[timelineScrollKey()] = e.target.scrollTop;
  }, true);

  // Editing works on a copy of the schedule (runEdit.config); the rows
  // are rebuilt from it after each change, with the names and player's
  // times from the saved timeline. rowAch: each row's achievement (a
  // break row's is the session start after it); edited: rows whose delay
  // differs from the saved one, with the saved value, for undo.
  function rebuildEdit() {
    var rows = rowsFromConfig(runEdit.config, runEdit.known);
    if (runEdit.meta) rows.splice(1, 0, runEdit.meta);
    var index = {}, rowAch = {}, edited = {}, pendingGap = null;
    runEdit.config.achievements.forEach(function (a, k) { index[String(a.id)] = k; });
    rows.forEach(function (r, ri) {
      if (ri === 0 || /^Copied from:/.test(r[0])) return;
      if (isLabelRow(r)) { if (/^Gap/.test(r[0])) pendingGap = ri; return; }
      var k = index[String(r[3])];
      rowAch[ri] = k;
      if (pendingGap !== null) rowAch[pendingGap] = k;
      var delayRow = pendingGap !== null ? pendingGap : String(r[1]) !== "1" ? ri : null;
      var before = runEdit.base.achievements[k].delay;
      if (delayRow !== null && runEdit.config.achievements[k].delay !== before) edited[delayRow] = before;
      pendingGap = null;
    });
    runEdit.rows = rows;
    runEdit.rowAch = rowAch;
    runEdit.edited = edited;
  }

  function setRunDelay(ri, seconds) {
    runEdit.config.achievements[runEdit.rowAch[ri]].delay = seconds;
    rebuildEdit();
    timelineShown = "";  // redrawn even when the time didn't change, closing its text box
    renderTimeline();
  }

  byId("timeline-lock").addEventListener("click", function () {
    var data = timelines[selectedRun];
    if (runEdit) {
      runEdit = null;
    } else {
      if (!data || !data.rows || !data.config) return;
      var known = {}, meta = null;
      data.rows.forEach(function (r, ri) {
        if (ri === 0) return;
        if (/^Copied from:/.test(r[0])) meta = r.slice();
        else if (!isLabelRow(r)) known[r[3]] = [r[2], r[4]];
      });
      runEdit = {name: selectedRun, base: data.config, config: JSON.parse(JSON.stringify(data.config)),
                 known: known, meta: meta};
      rebuildEdit();
    }
    timelineShown = "";
    renderTimeline();
  });
  byId("timeline-save").addEventListener("click", function () {
    var data = timelines[selectedRun], name = selectedRun;
    if (!runEdit || !data || !data.config) return;
    api("/api/save", {name: name, config: runEdit.config,
                      csv: toCsv(runEdit.rows), overwrite: true})
      .then(function () {
        runEdit = null;
        delete timelines[name];
        timelineShown = "";
        renderTimeline();
        showToast("Saved. The next sessions use the new timing.");
      })
      .catch(function (err) { showToast("Couldn't save: " + err.message); });
  });

  byId("timeline-table").addEventListener("click", function (e) {
    var toggle = e.target.closest("[data-run-break]");
    if (toggle && runEdit) {
      e.stopPropagation();
      var a = runEdit.config.achievements[Number(toggle.getAttribute("data-run-break"))];
      a.new_session = !a.new_session;
      rebuildEdit();
      renderTimeline();
      return;
    }
    var undo = e.target.closest("[data-run-undo]");
    if (undo) {
      e.stopPropagation();  // not the builder's undo
      var ri = Number(undo.getAttribute("data-run-undo"));
      setRunDelay(ri, runEdit.edited[ri]);
      return;
    }
    var cell = e.target.closest("td.run-editable");
    if (!cell || cell.querySelector("input") || !runEdit) return;
    var ri = Number(cell.getAttribute("data-row"));
    var input = document.createElement("input");
    input.type = "text";
    input.className = "delay-input";
    input.value = exactDuration(runEdit.rows[ri][CSV_DELAY_COL + 1]);
    cell.textContent = "";
    cell.appendChild(input);
    input.focus();
    input.select();
    var finished = false;
    function finish(save) {
      if (finished) return;
      finished = true;
      var seconds = save ? parseDelayInput(input.value) : null;
      if (save && seconds === null) showToast("Enter a time like 1h 20m, 45m or 90s.");
      if (seconds === null) { timelineShown = ""; renderTimeline(); return; }
      setRunDelay(ri, seconds);
    }
    input.addEventListener("keydown", function (ev) {
      if (ev.key === "Enter") finish(true);
      else if (ev.key === "Escape") finish(false);
    });
    input.addEventListener("blur", function () { finish(true); });
  });

  // Rows in the saved timeline's shape, made from the schedule alone, for
  // games saved without one: sessions, breaks and delays are all there,
  // the achievements go by name and time when an older save knew them, by
  // number otherwise. Saving an edit writes it as the game's timeline.
  function rowsFromConfig(config, known) {
    known = known || {};
    var list = config && Array.isArray(config.achievements) ? config.achievements : [];
    if (!list.length) return null;
    var rows = [["session", "#", "achievement", "id", "unlock_time", "delay", "delay_s"]];
    var session = 0, label = null, n = 0;
    list.forEach(function (a, i) {
      if (i === 0 || a.new_session) {
        session++;
        if (i > 0) rows.push(["Gap before session " + session, "", "", "", "", roughDurationCsv(a.delay), a.delay]);
        label = ["", "", "", "", "", "", 0];
        rows.push(label);
        n = 0;
      }
      var delay = i > 0 && a.new_session ? 0 : a.delay;
      n++;
      label[0] = "Session " + session + " (" + n + " achievement" + (n === 1 ? ")" : "s)");
      label[CSV_DELAY_COL + 1] += i > 0 && !a.new_session ? delay : 0;
      label[CSV_DELAY_COL] = roughDurationCsv(label[CSV_DELAY_COL + 1]);
      var k = known[a.id] || [];
      rows.push([String(session), String(n), k[0] || "Achievement " + a.id, String(a.id), k[1] || "", roughDurationCsv(delay), delay]);
    });
    return rows;
  }

  function loadTimeline(name) {
    timelines[name] = "loading";
    api("/api/timeline?name=" + encodeURIComponent(name)).then(function (data) {
      var made = !data.found && rowsFromConfig(data.config, data.known);
      timelines[name] = data.found ? {rows: parseCsv(data.text), config: data.config}
        : made ? {rows: made, config: data.config} : null;
    }).catch(function () { timelines[name] = null; }).then(function () {
      timelineShown = "";
      if (name === selectedRun && runsPane === "timeline") renderTimeline();
    });
  }

  // The schedule's info, shown under the summary when its arrow is open.
  var runInfoOpen = false;
  byId("run-summary").addEventListener("click", function (e) {
    if (e.target.closest("[data-reset-progress]")) {
      var g = selectedGame();
      if (g && confirmTwice("reset-progress:" + g.name)) {
        api("/api/reset-progress", {name: g.name}).then(function () { showToast(gameTitle(g) + "'s progress was reset."); })
          .catch(function (err) { showToast(err.message); }).then(refreshRuns);
      } else renderRuns();
      return;
    }
    var lib = e.target.closest("[data-lib-game]");
    if (lib) return openAchInLibrary(Number(lib.getAttribute("data-lib-game")), null);
    var button = e.target.closest("[data-run-info]");
    if (!button) return;
    runInfoOpen = !runInfoOpen;
    byId("run-info").hidden = !runInfoOpen;
    button.setAttribute("aria-expanded", String(runInfoOpen));
    button.title = (runInfoOpen ? "Hide" : "Show") + " App ID and where it came from";
  });
  // Full timeline: every session, in the space the log takes otherwise.
  var runFull = false;
  function setRunFull(full) {
    if (runEdit && !full) return;
    if (full !== runFull) swapIn(byId("runs-timeline"));
    runFull = full;
    byId("run-full-btn").setAttribute("aria-pressed", String(runFull));
    byId("workspace-runs-tabs").querySelectorAll("[data-run-view]").forEach(function (button) {
      button.setAttribute("aria-pressed", String((button.getAttribute("data-run-view") === "timeline") === runFull));
    });
    timelineShown = "";
    renderTimeline();
  }
  byId("run-full-btn").addEventListener("click", function () {
    setRunFull(!runFull);
  });
  byId("workspace-runs-tabs").addEventListener("click", function (e) {
    var button = e.target.closest("[data-run-view]");
    if (button) setRunFull(button.getAttribute("data-run-view") === "timeline");
  });

  // A game's log: its newest run, then the older ones behind a toggle
  // (closed again when another game is picked).
  var olderOpen = false, lastLog = null;
  function drawLog(force) {
    var pre = els.runsLog;
    if (lastLog === null) { pre.textContent = ""; pre._key = ""; pre.classList.toggle("empty", false); return; }
    // Newest run first; each run's own lines stay in the order they happened.
    var runs = lastLog.split(/\n*(?=^── Started )/m)
      .map(function (run) { return run.trim(); }).filter(Boolean).reverse();
    // No log yet: a note in its place, which can't be selected.
    pre.classList.toggle("empty", !runs.length);
    var key = runs.join("\n\n") + "\u0000" + olderOpen;
    // Replacing the text drops a selection, so it waits while one is in it.
    var sel = window.getSelection();
    if (!force && (pre._key === key || (sel && !sel.isCollapsed && pre.contains(sel.anchorNode)))) return;
    pre._key = key;
    pre.textContent = (runs[0] || "No activity yet. When this game runs, what it does shows up here.") +
      (olderOpen && runs.length > 1 ? "\n\n" + runs.slice(1).join("\n\n") : "");
    if (runs.length < 2) return;
    // A bar under what's shown: Show N older runs, or Show less.
    var toggle = document.createElement("button");
    toggle.type = "button";
    toggle.className = "older-runs-toggle" + (olderOpen ? " open" : "");
    toggle.setAttribute("aria-expanded", String(olderOpen));
    toggle.textContent = olderOpen ? "Show less" : "Show " + (runs.length - 1) + " older run" + (runs.length > 2 ? "s" : "");
    pre.appendChild(toggle);
  }
  els.runsLog.addEventListener("click", function (e) {
    if (!e.target.closest(".older-runs-toggle")) return;
    olderOpen = !olderOpen;
    drawLog(true);
  });

  function refreshLog() {
    if (!selectedRun) { lastLog = null; drawLog(true); return; }
    var name = selectedRun;
    api("/api/log?name=" + encodeURIComponent(name)).then(function (data) {
      if (name !== selectedRun) return;
      lastLog = data.text || "";
      drawLog(false);
    }).catch(function () {});
  }

  // Run's menu back to When ready and 1 session, its own time cleared.
  var wasRunning = {};
  function resetRunChoices() {
    var delay = byId("run-delay");
    delay.value = lastPresetDelay = "0";
    customDone = false;
    byId("run-delay-custom").value = "";
    runOpts.every = false;
    setRunMode(false, false);
    try { localStorage.setItem("run-every", "0"); } catch (err) {}
  }
  function refreshRuns() {
    if (!local) return Promise.resolve();
    clearTimeout(runsTimer);
    if (runsFetch) return runsFetch;
    runsFetch = api("/api/games").then(function (data) {
      // A run that ended (finished, stopped, or failed) leaves Run's menu at
      // its defaults: its start time and how much it played were for it.
      var nowRunning = {};
      (data.games || []).forEach(function (g) { if (g.running) nowRunning[g.name] = true; });
      if (Object.keys(wasRunning).some(function (n) { return !nowRunning[n]; })) resetRunChoices();
      wasRunning = nowRunning;
      runsData = data;
      runsError = null;
      runsFetchedAt = Date.now();
    }).catch(function (err) {
      runsError = err.message;
    }).then(function () {
      runsFetch = null;
      renderRuns();
      if (currentView === "runs") refreshLog();
      // Quick while it's being looked at, slow otherwise (just the tab dot).
      var visible = currentView === "runs" && !document.hidden;
      runsTimer = setTimeout(refreshRuns, visible ? 3000 : 20000);
    });
    return runsFetch;
  }

  function runAction(action, name) {
    if (runPending) return;
    var g = (runsData ? runsData.games : []).filter(function (x) { return x.name === name; })[0];
    var title = g ? gameTitle(g) : name, minutes = runDelayMinutes(), delaySelect = byId("run-delay");
    var when = !minutes ? "" : delaySelect.value === "custom" ? ", in " + fmtDur(minutes * 60)
      : ", " + delaySelect.options[delaySelect.selectedIndex].text.toLowerCase();
    var requests = {
      run: ["/api/run", {name: name, every: !!runOpts.every, delay: minutes || 0},
            "Started " + title + (runOpts.every ? ", every session" : ", next session") + when +
            ". You can close this window; it keeps running."],
      stop: ["/api/stop", {name: name}, "Stopping " + title + "…"],
      "stop-after": ["/api/stop-after", {name: name, on: true}, title + " will stop after this session."],
      "keep-going": ["/api/stop-after", {name: name, on: false}, title + " will play every remaining session."],
      dismiss: ["/api/dismiss", {name: name}, null]
    };
    var req = requests[action];
    if (action === "stop" && !confirmTwice("stop:" + name)) { renderRuns(); return; }
    runPending = action;
    renderRunBar(runsData ? runsData.games : []);
    return api(req[0], req[1]).then(function () {
      showToast(req[2] || "Done.");
    }).catch(function (err) {
      showToast(err.message);
    }).then(function () {
      // Keep controls disabled until fresh status has arrived, including
      // when a poll from before this action was already in flight.
      return new Promise(function (resolve) { setTimeout(resolve, 400); });
    }).then(function () {
      return runsFetch ? runsFetch.then(refreshRuns) : refreshRuns();
    }).then(function () {
      runPending = null;
      renderRuns();
    });
  }

  els.runsList.addEventListener("click", function (e) {
    var card = e.target.closest(".run-card");
    if (card && card.getAttribute("data-name") !== selectedRun) {
      // Unsaved timeline edits go with a second click (Save keeps them).
      if (runEdit && JSON.stringify(runEdit.config) !== JSON.stringify(runEdit.base) &&
          !confirmTwice("switch-edits:" + runEdit.name)) {
        showToast("Unsaved timeline edits. Save them, or click again to discard them.");
        return;
      }
      selectedRun = card.getAttribute("data-name");
      olderOpen = false;
      lastLog = null;
      drawLog(true);
      renderRuns();
      refreshLog();
    }
  });
  els.runsList.addEventListener("keydown", function (e) {
    var card = e.target.closest(".run-card");
    if (card && (e.key === "Enter" || e.key === " ")) { e.preventDefault(); card.click(); }
  });

  // Run opens its menu. Starting is an explicit action beside the choices.
  byId("run-start").addEventListener("click", function (e) {
    var g = selectedGame();
    if (!g || this.classList.contains("is-disabled")) { e.preventDefault(); return; }
    if (g.running || g.finished) { e.preventDefault(); runAction(g.running ? "stop" : "dismiss", g.name); return; }
  });
  byId("run-confirm").addEventListener("click", function () {
    var g = selectedGame();
    if (!g || this.disabled || g.running) return;
    byId("run-menu").open = false;
    runAction("run", g.name);
    byId("run-start").focus();
  });
  // Leaving an empty custom field restores the previous preset and Other….
  function resetEmptyCustomDelay() {
    var delay = byId("run-delay"), custom = byId("run-delay-custom");
    if (delay.value !== "custom" || customDone || custom.value.trim()) return;
    custom.value = "";
    delay.value = lastPresetDelay;
    delay.dispatchEvent(new Event("change"));
  }
  byId("run-menu").addEventListener("toggle", function () {
    if (!this.open) resetEmptyCustomDelay();
    renderRunBar(runsData ? runsData.games : []);
  });
  byId("run-delay-custom").addEventListener("blur", function () {
    var custom = this;
    // Let a clicked preset or mode finish handling its click before redrawing.
    setTimeout(function () {
      if (document.activeElement !== custom) resetEmptyCustomDelay();
    }, 0);
  });
  byId("run-delay-custom").addEventListener("keydown", function (e) {
    if (e.key !== "Enter") return;
    e.preventDefault();
    if (!this.value.trim()) {
      resetEmptyCustomDelay();
      byId("run-delay-chips").querySelector('[data-value="custom"]').focus();
      return;
    }
    if (runDelayMinutes() === null) return;
    customDone = true;
    renderRunBar(runsData ? runsData.games : []);
    var chip = byId("run-delay-chips").querySelector('[data-value="custom"]');
    if (chip) chip.focus();
  });
  // A chip picks in its select, as if picked there.
  [["run-delay-chips", "run-delay"], ["run-mode-chips", "run-mode"]].forEach(function (pair) {
    byId(pair[0]).addEventListener("click", function (e) {
      var chip = e.target.closest("[data-value]");
      if (!chip) return;
      var select = byId(pair[1]);
      if (select.id === "run-delay") customDone = false;
      select.value = chip.getAttribute("data-value");
      select.dispatchEvent(new Event("change"));
      renderRunBar(runsData ? runsData.games : []);
    });
  });
  setRunMode(runOpts.every, false);
  byId("run-delay").addEventListener("change", function () {
    var custom = byId("run-delay-custom");
    if (this.value !== "custom") lastPresetDelay = this.value;
    renderRunBar(runsData ? runsData.games : []);
    if (this.value === "custom") custom.focus();
  });
  byId("run-delay-custom").addEventListener("input", function () {
    renderRunBar(runsData ? runsData.games : []);
  });
  // While the selected game runs, it changes how much that run plays;
  // otherwise it's how the next Run starts.
  byId("run-mode").addEventListener("change", function () {
    var every = this.value === "1", g = selectedGame();
    if (g && g.running) {
      if (every !== !g.stop_after) runAction(every ? "keep-going" : "stop-after", g.name);
      return;
    }
    runOpts.every = every;
    setRunMode(every, false);
    try { localStorage.setItem("run-every", every ? "1" : "0"); } catch (err) {}
  });

  // In the app, a right click is for text only (Cut, Copy, Paste): the
  // web view's own menu (Reload, Inspect Element) isn't for an app.
  if (document.documentElement.hasAttribute("data-desktop") && !document.documentElement.hasAttribute("data-dev")) {
    document.addEventListener("contextmenu", function (e) {
      var text = e.target.closest && e.target.closest("input, textarea, [contenteditable]");
      var selected = String(window.getSelection ? window.getSelection() : "").trim();
      if (!text && !selected) e.preventDefault();
    });
  }

  // render() redraws the cards for the Confirm labels too.
  var baseRender = render;
  render = function () { baseRender(); if (local) renderRuns(); };

  document.addEventListener("visibilitychange", function () { if (!document.hidden) refreshRuns(); });

  // The page shows once its first screen is picked (Setup on a first run,
  // else Runs), or 3 seconds after STAR's server answered.
  function shown() { if (local) document.documentElement.removeAttribute("data-booting"); }
  if (document.documentElement.hasAttribute("data-booting")) setTimeout(shown, 3000);

  function enableLocal() {
    // The settings, for show_finished in the Runs list.
    if (!runSettings) loadRunSettings();
    local = true;
    byId("screen-switch").hidden = false;
    syncScreenSwitch();
    document.body.classList.add("local");
    var navigation = byId("workspace-navigation");
    byId("workspace-actions").appendChild(document.querySelector(".page-actions"));
    // Advanced run settings and Library's display options, folded away in
    // their sections on the website, are each a Settings tab of their own
    // in the app, open: a card of their own, their fold's title as its.
    [["run-settings-box", "step-run-settings", "advanced"], ["lib-defaults-box", "step-lib-display", "display"]].forEach(function (f) {
      var box = byId(f[0]), card = document.createElement("li");
      card.className = "setup-step done settings-tab-card";
      card.id = f[1];
      card.setAttribute("data-settings-tab", f[2]);
      card.innerHTML = '<div class="step-head"><b></b></div>';
      card.querySelector("b").textContent = box.querySelector("summary").firstChild.textContent.trim();
      box.open = true;
      card.appendChild(box);
      document.querySelector("#hero-setup .setup-steps").appendChild(card);
    });
    // One toolbar row: the sections lead it and Appearance ends it, out of
    // the old top bar (hidden in the app, see style.css).
    byId("workspace-toolbar").prepend(byId("screen-switch"));
    byId("workspace-actions").appendChild(document.querySelector(".topbar-right .appearance"));
    // When Steam was read sits beside Refresh, as a toolbar status would.
    document.querySelector(".pa-unlocks").prepend(document.querySelector(".unlocks-when"));
    navigation.appendChild(byId("schedule-tabs"));
    navigation.appendChild(byId("library-tabs"));
    navigation.appendChild(byId("game-back"));
    byId("app-workspace").appendChild(byId("schedule-workspace-footer"));
    byId("screen-switch").addEventListener("keydown", function (e) {
      if (["ArrowUp", "ArrowDown", "Home", "End"].indexOf(e.key) < 0) return;
      var buttons = [].slice.call(this.querySelectorAll("button"));
      var index = buttons.indexOf(document.activeElement);
      if (index < 0) return;
      e.preventDefault();
      index = e.key === "Home" ? 0 : e.key === "End" ? buttons.length - 1 :
        (index + (e.key === "ArrowDown" ? 1 : -1) + buttons.length) % buttons.length;
      buttons[index].click();
      buttons[index].focus();
    });
    // The same keyboard interaction applies to each screen's segmented
    // navigation. Schedule's tablist already handles its own focus.
    navigation.addEventListener("keydown", function (e) {
      var group = e.target.closest(".segmented");
      if (!group || group.id === "schedule-tabs" || ["ArrowLeft", "ArrowRight", "Home", "End"].indexOf(e.key) < 0) return;
      var buttons = [].slice.call(group.querySelectorAll("button:not(:disabled)"));
      var index = buttons.indexOf(document.activeElement);
      if (index < 0) return;
      e.preventDefault();
      index = e.key === "Home" ? 0 : e.key === "End" ? buttons.length - 1 :
        (index + (e.key === "ArrowRight" ? 1 : -1) + buttons.length) % buttons.length;
      buttons[index].click();
      buttons[index].focus();
    });
    setSettingsSection(settingsSection);
    syncWorkspace();
    els.exportText.placeholder = "Paste the copied SteamHunters achievements page here, or a link to a player's achievements\u2026";
    // Every part of Schedule shares one fixed frame, with tabs to switch
    // between the import, game fields, session options and timeline.
    combined = true;
    var bar = byId("schedule-bar");
    var source = byId("schedule-source"), preview = byId("schedule-preview");
    source.appendChild(byId("schedule-import"));
    byId("schedule-panels").appendChild(byId("schedule-details"));
    // Session options sit under the game's details, in one Details tab.
    byId("schedule-details").appendChild(byId("bar-options"));
    preview.appendChild(els.csvSlot);
    byId("schedule-game").after(byId("schedule-counters"));
    byId("schedule-details").querySelector('[data-slot="game-name"]').appendChild(els.gameName);
    byId("schedule-details").querySelector('[data-slot="appid"]').appendChild(els.appid);
    byId("schedule-details").querySelector('[data-slot="copied-from"]').appendChild(els.copiedFrom);
    els.copiedFrom.placeholder = "optional";
    bar.querySelector('[data-slot="reset"]').appendChild(els.resetBtn);
    byId("schedule-workspace-footer").prepend(els.inputAlertSlot);
    // Reset sits at the end of the import's last line; the bar below is
    // only for import errors.
    document.querySelector(".import-actions").appendChild(bar.querySelector('[data-slot="reset"]'));
    els.resetBtn.style.width = "";
    byId("bar-options").querySelector('[data-slot="settings-form"]').prepend(document.querySelector(".settings-form"));
    // Short labels, with the unit beside each box.
    [["gap-limit", "Session break after"], ["cum-limit", "Max session length"], ["min-gap", "Warn if break under"]]
      .forEach(function (f) {
        var input = byId(f[0]), unit = document.createElement("span");
        document.querySelector('label[for="' + f[0] + '"]').textContent = f[1];
        unit.className = "bar-unit";
        unit.textContent = "hours";
        input.parentNode.insertBefore(unit, input.nextSibling);
      });
    byId("schedule-tabs").addEventListener("click", function (e) {
      var tab = e.target.closest("[data-panel]");
      if (tab && !tab.disabled) setSchedulePanel(tab.getAttribute("data-panel"));
    });
    byId("schedule-tabs").addEventListener("keydown", function (e) {
      if (["ArrowLeft", "ArrowRight", "Home", "End"].indexOf(e.key) < 0) return;
      var tabs = [].slice.call(this.querySelectorAll("[data-panel]:not(:disabled)"));
      var index = tabs.indexOf(document.activeElement);
      if (index < 0) return;
      e.preventDefault();
      index = e.key === "Home" ? 0 : e.key === "End" ? tabs.length - 1 :
        (index + (e.key === "ArrowRight" ? 1 : -1) + tabs.length) % tabs.length;
      setSchedulePanel(tabs[index].getAttribute("data-panel"), true);
    });
    // What the paste gave (achievements, sessions, lengths), in a line
    // over the result.
    byId("paste-summary").querySelector('[data-slot="stats"]').appendChild(els.statsStrip);
    els.statsStrip.classList.add("summary-bar");
    // No How to edit in the app: the timeline's tooltips say it.
    document.querySelector(".hover-help").remove();
    // Keep the input actionable; detailed import instructions are optional.
    var help = document.querySelector(".input-help");
    source.appendChild(help);
    els.exportText.placeholder = "Paste a Steam or SteamHunters link here…";
    setSchedulePanel("import");
    // It opens on Runs (Settings takes over while setup isn't done; see
    // refreshSetup).
    showScreen("work");
    setView("runs");
    recompute();
    render();
    refreshRuns();
    refreshSetup();
    checkUpdates(false);
  }

  // ---- first-run setup (local app): install ArchiSteamFarm, sign in ----
  // Opens by itself until both steps are done (then closes by itself), and
  // from Guide any time after, which also covers updating ArchiSteamFarm
  // and changing the Steam account.
  var setupData = null;
  var setupOpen = false;
  var setupAutoClose = false;
  var changingAccount = false;
  var setupTimer = null;

  function byId(id) { return document.getElementById(id); }

  function refreshSetup() {
    clearTimeout(setupTimer);
    api("/api/setup").then(function (d) {
      if (setupData === null && !setupOpen) {
        setupOpen = setupAutoClose = !(d.asf && d.plugin && d.bot);
        if (setupOpen) showScreen("guide");  // first run: set up before anything else
      }
      setupData = d;
      renderSetup();
      if (d.busy) setupTimer = setTimeout(refreshSetup, 800);
    }).catch(function () {}).then(shown);
  }

  function renderSetup() {
    var d = setupData;
    if (!d) return;
    var asfDone = d.asf && d.plugin;
    if (d.signed_in) changingAccount = false;
    if (setupOpen && setupAutoClose && asfDone && d.signed_in && !d.busy) {
      setupOpen = setupAutoClose = false;
      showToast("All set. Make a schedule, then run it.");
      if (local) { showScreen("work"); setView("input"); }
    }
    var signedIn = d.signed_in || (d.bot && !changingAccount);
    var firstRun = !(asfDone && (d.signed_in || d.bot));
    byId("hero-setup").hidden = !setupOpen;
    if (!setupOpen) return;
    byId("setup-title").textContent = firstRun ? "Finish setting up" : "Settings";

    var installing = d.busy === "install";
    var asfCurrent = asfDone && !d.outdated;
    byId("step-asf").className = "setup-step" + (installing ? " busy" : asfCurrent ? " done" : "");
    byId("step-asf-text").textContent = installing ? (d.message || "Starting…")
      : asfCurrent ? "ArchiSteamFarm " + d.asf_version + " · plugin " + d.plugin_version
      : asfDone ? "ArchiSteamFarm " + d.asf_wanted + " with ASFAchievementManager " + d.plugin_wanted +
        " is ready to install. It installs by itself once no game is in a session."
      : "Downloads ArchiSteamFarm and its achievement plugin (about 50 MB).";
    byId("setup-install").hidden = asfCurrent || installing;
    byId("setup-install").textContent = asfDone ? "Update" : "Install";
    // Newer than the tried pair, from Check for updates.
    var latest = d.asf_latest;
    var checking = d.busy === "asf-check";
    byId("asf-check").hidden = !asfCurrent || installing;
    byId("asf-check").disabled = checking;
    byId("asf-check").textContent = checking ? "Checking…" : "Check for updates";
    byId("asf-update-latest").hidden = !asfCurrent || installing || !(latest && latest.newer);
    // "Up to date" (or a failed check) answers the click; it's gone once
    // you leave Settings. A newer pair stays, since it can be installed.
    var shown = latest && (latest.newer || asfCheckAnswer);
    byId("asf-latest-text").hidden = !asfCurrent || installing || !shown;
    if (latest) {
      byId("asf-latest-text").textContent = latest.error ? latest.error
        : latest.newer ? latest.asf + " is available. It installs between sessions."
        : "Up to date.";
      byId("asf-update-latest").textContent = "Update to " + (latest.asf || "");
    }

    var signing = d.busy === "login" || d.busy === "code";
    byId("step-steam").className = "setup-step" + (signing ? " busy" : signedIn ? " done" : "");
    var text = "Sign in with the account to unlock achievements on. It's saved only in ArchiSteamFarm's own config on this computer.";
    if (!asfDone) text = "After ArchiSteamFarm is installed.";
    else if (signing) text = d.message || "Signing in…";
    else if (d.needs === "SteamGuard") text = "Steam emailed you a code. Enter it here.";
    else if (d.needs === "TwoFactorAuthentication") text = "Enter the code from Steam Guard in the Steam mobile app.";
    else if (signedIn) text = "Signed in as " + d.account + ".";
    byId("step-steam-text").textContent = text;
    byId("steam-change").hidden = !asfDone || !signedIn || signing || !!d.needs;
    byId("login-form").hidden = !asfDone || signedIn || signing || !!d.needs;
    byId("code-form").hidden = !asfDone || d.signed_in || signing || !d.needs;

    renderExtras(d);
    byId("step-runs").hidden = !(d.asf && d.plugin);
    if (!runSettings) loadRunSettings();
    byId("step-unlocks").hidden = !d.data_dir;
    byId("step-clock").hidden = !d.data_dir;
    if (!unlocksKeyLoaded) {
      unlocksKeyLoaded = true;
      api("/api/unlocks/key").then(function (r) { unlocksHasKey = r.has_key; renderUnlocksKey(); }).catch(function () {});
    }
    byId("step-data").hidden = !d.data_dir;
    byId("data-path").textContent = d.data_dir || "";
    byId("open-folder").textContent = document.documentElement.getAttribute("data-desktop") === "linux"
      || /Linux/.test(navigator.platform) ? "Show folder" : "Show in Finder";
    byId("setup-error").hidden = !d.error;
    byId("setup-error").textContent = d.error || "";
  }

  // Settings → Runs: how runs pace themselves (settings.json), and whether
  // finished games are listed.
  var RUN_SETTINGS = {
    break_wait: ["Continue during a break", {off: "Off", "1h": "1 hour", "3h": "3 hours", "6h": "6 hours", "12h": "12 hours", "24h": "1 day"},
                 "before it ends"],
    jitter_enabled: ["Randomize delays", "Moves each delay a little, so a run doesn't replay the player's timings to the second."],
    jitter_percent: ["By up to", "%", 0, 100],
    jitter_min_delay: ["Only delays longer than", "seconds"],
    stop_other_asf: ["Stop other ArchiSteamFarm installs", "Steam allows one login per account. Turn it off if they use other accounts, like a card-farming install."],
    simultaneous_max_delay: ["Unlock together when within", "seconds"],
    warm_settle_delay: ["Wait before the first unlock", "seconds"],
    reconnect_settle_delay: ["Wait before the first unlock, if Steam just reconnected", "seconds"],
    play_check_interval: ["Check the game is still playing every", "seconds", 1],
    bot_connect_timeout: ["Wait for Steam to connect up to", "seconds"],
    asf_shutdown_delay: ["Close an idle ArchiSteamFarm after", "seconds"],
    run_logs_kept: ["Keep in each game's log its last", "runs", 1, 100]
  };
  var runSettings = null;  // [{key, value, default}] as saved
  var editingSettings = false;  // locked until Edit

  function loadRunSettings() {
    runSettings = [];
    api("/api/settings").then(function (d) { runSettings = d.settings; renderRunSettings(); syncToggles(); })
      .catch(function (err) {
        runSettings = null;
        byId("run-settings").innerHTML = noticeHtml("danger", err.message);
      });
  }

  var RUN_SETTING_GROUPS = [
    ["Breaks", ["break_wait"]],
    ["Delays", ["jitter_enabled", "jitter_percent", "jitter_min_delay", "simultaneous_max_delay"]],
    ["ArchiSteamFarm", ["stop_other_asf", "warm_settle_delay", "reconnect_settle_delay",
                        "play_check_interval", "bot_connect_timeout", "asf_shutdown_delay"]],
    ["Logs", ["run_logs_kept"]]
  ];

  function renderRunSettings() {
    var byKey = {};
    runSettings.forEach(function (s) { byKey[s.key] = s; });
    var changed = runSettings.filter(function (s) { return RUN_SETTINGS[s.key] && s.value !== s.default; }).length;
    byId("run-settings-summary").textContent = changed ? "· " + changed + " changed" : "· defaults";
    byId("run-settings").innerHTML = RUN_SETTING_GROUPS.map(function (group) {
      return '<div class="setting-group"><div class="setting-group-title">' + group[0] + "</div>" +
        group[1].filter(function (key) { return byKey[key]; }).map(function (key) { return settingHtml(byKey[key]); }).join("") +
        "</div>";
    }).join("");
    syncRunSettings();
  }

  function settingHtml(s) {
    return (function (s) {
      var info = RUN_SETTINGS[s.key], id = "set-" + s.key;
      // ↺ puts one setting back to its default (shown while editing, when
      // it differs), after the box so the box stays put.
      var reset = '<button class="setting-reset" type="button" data-reset="' + s.key + '" title="Set to default (' +
        (typeof s.default === "boolean" ? (s.default ? "on" : "off") : s.default) + ')" aria-label="Set to default">↺</button>';
      if (typeof s.default === "boolean") {
        return '<div class="setting-row"><label class="setting-check" title="' + escapeHtml(info[1]) + '"><input type="checkbox" id="' + id +
          '" data-key="' + s.key + '"' + (s.value ? " checked" : "") + "> " + escapeHtml(info[0]) + "</label>" + reset + "</div>";
      }
      // A choice: its unit is hidden while it's off.
      if (typeof info[1] === "object") {
        return '<div class="setting-row"><label for="' + id + '">' + escapeHtml(info[0]) + '</label><span><select id="' + id +
          '" data-key="' + s.key + '">' + Object.keys(info[1]).map(function (v) {
            return '<option value="' + v + '"' + (v === s.value ? " selected" : "") + ">" + escapeHtml(info[1][v]) + "</option>";
          }).join("") + '</select><span class="setting-unit"' + (s.value === "off" ? " hidden" : "") + ">" + escapeHtml(info[2]) + "</span>" + reset + "</span></div>";
      }
      return '<div class="setting-row"><label for="' + id + '">' + escapeHtml(info[0]) + '</label><span><input type="number" id="' + id +
        '" data-key="' + s.key + '" min="' + (info[2] || 0) + '"' + (info[3] != null ? ' max="' + info[3] + '"' : "") +
        ' step="1" value="' + s.value + '"><span class="setting-unit">' + escapeHtml(info[1]) + "</span>" + reset + "</span></div>";
    })(s);
  }

  // What the form holds, or null if a number isn't valid.
  function runSettingsForm() {
    var values = {}, ok = true;
    byId("run-settings").querySelectorAll("[data-key]").forEach(function (el) {
      if (el.type === "checkbox") { values[el.dataset.key] = el.checked; return; }
      if (el.tagName === "SELECT") { values[el.dataset.key] = el.value; return; }
      var n = Number(el.value), valid = el.value.trim() !== "" && el.checkValidity() && Number.isInteger(n);
      el.classList.toggle("invalid", !valid);
      if (!valid) ok = false;
      values[el.dataset.key] = n;
    });
    return ok ? values : null;
  }

  function syncRunSettings() {
    var values = runSettingsForm();
    var changed = !!values && (runSettings || []).some(function (s) { return s.key in values && values[s.key] !== s.value; });
    var form = byId("run-settings");
    form.classList.toggle("locked", !editingSettings);
    form.querySelectorAll("[data-key]").forEach(function (el) { el.disabled = !editingSettings; });
    form.querySelectorAll("select").forEach(function (el) { el.nextElementSibling.hidden = el.value === "off"; });
    var jitter = byId("set-jitter_enabled");
    ["set-jitter_percent", "set-jitter_min_delay"].forEach(function (id) {
      if (byId(id) && jitter && !jitter.checked) byId(id).disabled = true;
    });
    (runSettings || []).forEach(function (s) {
      var button = form.querySelector('[data-reset="' + s.key + '"]');
      if (button) button.hidden = !editingSettings || !values || values[s.key] === s.default;
    });
    var lock = byId("run-settings-lock");
    lock.setAttribute("aria-pressed", String(editingSettings));
    lock.setAttribute("data-tip", editingSettings ? "Cancel editing: changes you haven't saved are discarded" : "Edit advanced run settings");
    byId("run-settings-lock-label").textContent = editingSettings ? "Cancel editing" : "Edit settings";
    byId("run-settings-save").hidden = !editingSettings || !changed;
  }

  function saveRunSettings(values) {
    api("/api/settings", {settings: values}).then(function (d) {
      runSettings = d.settings;
      editingSettings = false;
      renderRunSettings();
      showToast("Applied. Runs started from now on use these.");
    }).catch(function (err) { showToast("Couldn't save: " + err.message); });
  }
  byId("run-settings").addEventListener("input", syncRunSettings);
  byId("run-settings").addEventListener("change", syncRunSettings);
  byId("run-settings").addEventListener("submit", function (e) { e.preventDefault(); });
  byId("run-settings-save").addEventListener("click", function () {
    var values = runSettingsForm();
    if (values) saveRunSettings(values);
  });
  // The lock: open to change the settings; closing it again drops
  // anything not saved.
  byId("run-settings-lock").addEventListener("click", function () {
    editingSettings = !editingSettings;
    if (editingSettings) syncRunSettings(); else renderRunSettings();
  });
  // ↺ puts a default in the form; Apply keeps it.
  function setToDefault(s) {
    var el = byId("set-" + s.key);
    if (!el) return;
    if (el.type === "checkbox") el.checked = s.default; else el.value = s.default;
  }
  byId("run-settings").addEventListener("click", function (e) {
    var button = e.target.closest("[data-reset]");
    if (!button) return;
    var key = button.getAttribute("data-reset");
    (runSettings || []).forEach(function (s) { if (s.key === key) setToDefault(s); });
    syncRunSettings();
  });


  // Keep awake: switched on or off here (saved in
  // settings.json, used by runs started after), and what this computer
  // is missing for them. Shown once setup is done.
  var extrasTools = {show_finished: true};
  var TOGGLES = {keep_awake: "keep-awake-on", show_finished: "show-done"};
  function syncToggles() {
    Object.keys(TOGGLES).forEach(function (key) {
      var box = byId(TOGGLES[key]);
      var s = (runSettings || []).filter(function (x) { return x.key === key; })[0];
      box.disabled = !s || !extrasTools[key];
      box.checked = !!(s && s.value && extrasTools[key]);
    });
    ["theme", "accent", "banners", "gradient"].forEach(function (key) {
      var s = (runSettings || []).filter(function (x) { return x.key === key; })[0];
      if (s && document.documentElement.getAttribute("data-" + key) !== s.value) applyAppearance(key, s.value, false);
    });
    var tab = (runSettings || []).filter(function (x) { return x.key === "library_tab"; })[0];
    if (tab && tab.value !== libraryTab) {
      libraryTab = tab.value;
      if (unlocksData) renderUnlocks();
    }
    // Library defaults: applied when they change (or first load), so a
    // range or sort picked in Library lasts until then.
    var lib = {};
    (runSettings || []).forEach(function (x) { lib[x.key] = x.value; });
    if (lib.unlocks_range) {
      byId("default-range").value = lib.unlocks_range;
      if (lib.unlocks_range !== appliedLib.range) { appliedLib.range = unlocksRange = lib.unlocks_range; if (unlocksData) renderUnlocks(); }
    }
    if (lib.library_sort && lib.library_order) {
      byId("lib-sort").innerHTML = sortRowsHtml(SORTS.games, lib.library_sort, lib.library_order);
      var sortKey = lib.library_sort + " " + lib.library_order;
      if (sortKey !== appliedLib.sort) {
        appliedLib.sort = sortKey;
        gamesSort = lib.library_sort;
        gamesOrder = lib.library_order;
        if (unlocksData) renderUnlocks();
      }
    }
    if (lib.achievement_sort && lib.achievement_order && lib.achievement_group) {
      byId("lib-ach-sort").innerHTML = sortRowsHtml(SORTS.ach, lib.achievement_sort, lib.achievement_order);
      byId("lib-ach-group").innerHTML = chipRow("group", GROUPS, lib.achievement_group);
      var achKey = [lib.achievement_sort, lib.achievement_order, lib.achievement_group].join(" ");
      if (achKey !== appliedLib.ach) {
        appliedLib.ach = achKey;
        achSort = lib.achievement_sort;
        achOrder = lib.achievement_order;
        achGroup = lib.achievement_group;
        if (gamePage) renderGamePage();
      }
    }
    if (FILTERS.every(function (f) { return lib[f[2]]; })) {
      var fromSettings = {};
      FILTERS.forEach(function (f) { fromSettings[f[0]] = lib[f[2]]; });
      fromSettings.match = lib.library_match || "all";
      renderFilterList("lib-filters", fromSettings);
      var filterKey = FILTERS.map(function (f) { return lib[f[2]]; }).join(" ") + " " + fromSettings.match;
      if (filterKey !== appliedLib.filter) {
        appliedLib.filter = filterKey;
        libFilter = fromSettings;
        if (unlocksData) renderUnlocks();
      }
    }
    if (lib.library_check) byId("library-check").value = lib.library_check;
    if (lib.week_start) {
      byId("week-start").value = lib.week_start;
      if (lib.week_start !== weekStart) { weekStart = lib.week_start; if (unlocksData) renderUnlocks(); }
    }
    if (lib.hidden_descriptions) {
      byId("hidden-descriptions").value = lib.hidden_descriptions;
      if (lib.hidden_descriptions !== hiddenDesc) {
        hiddenDesc = lib.hidden_descriptions;
        if (unlocksData) renderUnlocks();
        if (gamePage) renderGamePage();
      }
    }
    var clock = (runSettings || []).filter(function (x) { return x.key === "clock"; })[0];
    var wanted = clock && (clock.value === "system" ? CLOCK_GUESS : clock.value);  // "system": not picked yet
    byId("clock-format").value = wanted || clockPref;
    if (wanted && wanted !== clockPref) {
      clockPref = wanted;
      renderRuns();
      if (unlocksData) renderUnlocks();
    }
    var show = (runSettings || []).filter(function (x) { return x.key === "show_finished"; })[0];
    if (show && !!show.value !== showDone) {
      showDone = !!show.value;
      renderRuns();
    }
  }
  byId("clock-format").addEventListener("change", function () {
    var select = this;
    select.disabled = true;
    api("/api/settings", {settings: {clock: select.value}}).then(function (d) {
      runSettings = d.settings;
      if (!editingSettings) renderRunSettings();
    }).catch(function (err) { showToast("Couldn't save: " + err.message); })
      .then(function () { select.disabled = false; syncToggles(); });
  });
  Object.keys(TOGGLES).forEach(function (key) {
    byId(TOGGLES[key]).addEventListener("change", function () {
      var box = this, values = {};
      values[key] = box.checked;
      box.disabled = true;
      api("/api/settings", {settings: values}).then(function (d) {
        // Keep the run settings form as is while it's being edited.
        runSettings = d.settings;
        if (!editingSettings) renderRunSettings();
      }).catch(function (err) { showToast("Couldn't save: " + err.message); })
        .then(syncToggles);
    });
  });

  function renderExtras(d) {
    var x = d.extras;
    // Under Runs in Settings.
    byId("awake-row").hidden = !x;
    if (!x) return;
    var awake = x.keep_awake;
    extrasTools.keep_awake = !!awake.tool;
    byId("awake-text").hidden = !!awake.tool;
    byId("awake-text").textContent = "Not available here: needs systemd-inhibit.";
    byId("awake-check").hidden = !awake.tool;
    syncToggles();
  }

  function setupPost(path, body) {
    api(path, body).then(function (d) { setupData = d; renderSetup(); })
      .catch(function (err) { showToast(err.message); })
      .then(function () { setTimeout(refreshSetup, 300); });
  }

  byId("setup-install").addEventListener("click", function () { setupPost("/api/setup/install", {}); });
  var asfCheckAnswer = false;  // show what Check for updates found
  byId("asf-check").addEventListener("click", function () {
    asfCheckAnswer = true;
    byId("asf-check").textContent = "Checking…";
    byId("asf-check").disabled = true;
    setupPost("/api/setup/asf-check", {});
  });
  byId("asf-update-latest").addEventListener("click", function () { setupPost("/api/setup/install", {latest: true}); });
  byId("awake-check").addEventListener("click", function () {
    var button = byId("awake-check");
    button.disabled = true;
    button.setAttribute("aria-busy", "true");
    button.setAttribute("data-tip", "Testing…");
    api("/api/setup/test-awake", {}).then(function (d) {
      showToast(d.works ? "Keep awake works: " + d.found + "." : "Keep awake doesn't work here: " + d.found + ".");
    }).catch(function (err) { showToast(err.message); })
      .then(function () {
        button.disabled = false;
        button.removeAttribute("aria-busy");
        button.setAttribute("data-tip", "Check that the computer really stays awake");
      });
  });
  byId("open-folder").addEventListener("click", function () {
    api("/api/open-folder", {}).catch(function (err) { showToast(err.message); });
  });
  byId("setup-close").addEventListener("click", function () {
    setupOpen = setupAutoClose = false;
    renderSetup();
  });
  byId("steam-change").addEventListener("click", function () {
    changingAccount = true;
    renderSetup();
    byId("steam-user").focus();
  });
  byId("login-form").addEventListener("submit", function (e) {
    e.preventDefault();
    setupPost("/api/setup/login", {username: byId("steam-user").value, password: byId("steam-pass").value});
    byId("steam-pass").value = "";
  });
  byId("code-form").addEventListener("submit", function (e) {
    e.preventDefault();
    setupPost("/api/setup/code", {code: byId("steam-code").value});
    byId("steam-code").value = "";
  });

  // ---- updates (local app) ----
  // Checked when the page opens (the server asks GitHub at most every few
  // hours) and from Check for updates / the app's menu. Updating runs the
  // install script, which closes the app and opens the new one.
  var updateData = null;
  var updateChecked = false;   // checked on request, so say "up to date"

  function renderUpdate() {
    var u = updateData;
    if (!u) return;
    var text = "STAR " + u.current + (updateChecked && !u.error ? " is up to date." : "");
    if (u.updating) {
      text = "Updating to " + u.latest + "… The app closes and opens again when it's done.";
    } else if (u.failed && u.available) {
      text = "The last update didn't finish (" + u.failed.replace(/^Error:\s*/, "") + ")";
    } else if (u.available) {
      text = "Version " + u.latest + " is out (you have " + u.current + ")." +
        (u.can_update ? "" : " Update with git pull.");
    } else if (u.error && updateChecked) {
      text = "STAR " + u.current + ". " + u.error;
    }
    byId("update-text").textContent = text;
    byId("update-now").hidden = !u.available || !u.can_update || u.updating;
    byId("update-check").hidden = u.updating;
  }

  function checkUpdates(force) {
    if (force) byId("update-text").textContent = "Checking for updates…";
    return api("/api/update" + (force ? "?force=1" : "")).then(function (u) {
      updateData = u;
      updateChecked = updateChecked || force;
      renderUpdate();
    }).catch(function () {});
  }

  // Without the app, the install script restarts the page's server: reload
  // once it's back. (With the app, the app itself is reopened.)
  function reloadWhenBack() {
    var wentDown = false;
    var timer = setInterval(function () {
      fetch("/api/ping").then(function (r) {
        if (wentDown && r.ok) { clearInterval(timer); location.reload(); }
      }).catch(function () { wentDown = true; });
    }, 2000);
  }

  // The Settings tab.
  var settingsSection = "general";
  function setSettingsSection(section) {
    if (section !== settingsSection) swapIn(document.querySelector("#hero-setup .setup-steps"));
    settingsSection = section;
    byId("hero-setup").setAttribute("data-settings-section", section);
    byId("workspace-settings-tabs").querySelectorAll("[data-settings]").forEach(function (button) {
      button.setAttribute("aria-pressed", String(button.getAttribute("data-settings") === section));
    });
  }
  byId("workspace-settings-tabs").addEventListener("click", function (e) {
    var button = e.target.closest("[data-settings]");
    if (button) setSettingsSection(button.getAttribute("data-settings"));
  });
  function showGuide() {
    setupOpen = true;
    showScreen("guide");
    renderSetup();
    refreshSetup();
  }

  byId("update-check").addEventListener("click", function () { checkUpdates(true); });
  byId("update-now").addEventListener("click", function () {
    api("/api/update", {}).then(function (u) {
      updateData = u;
      renderUpdate();
      reloadWhenBack();
    }).catch(function (err) { showToast(err.message); });
  });

  // Called by the desktop app's menu (Help > Setup Guide, Check for Updates…).
  window.unlockerShowGuide = showGuide;
  window.unlockerCheckUpdates = function () {
    showGuide();
    if (!local) return;
    setSettingsSection("general");
    byId("update-row").scrollIntoView({block: "center"});
    checkUpdates(true);
  };

  // ---- start screen ----
  function showScreen(name) {
    document.body.setAttribute("data-screen", name);
    renderPageHead();
    if (!local) {
      window.scrollTo(0, 0);
      byId("page").scrollTop = 0;
    }
    // Leaving the Guide tab closes the panel, unless it's first-run setup,
    // which stays on the start screen until it's done.
    // What Check for updates found answers the click; leaving Settings
    // clears it (a newer version stays, since it can be installed).
    if (name !== "guide" && (asfCheckAnswer || updateChecked)) {
      asfCheckAnswer = updateChecked = false;
      renderSetup();
      renderUpdate();
    }
    if (name !== "guide" && setupOpen && !setupAutoClose) {
      setupOpen = false;
      renderSetup();
    }
    syncScreenSwitch();
    sizeBoxes();
  }

  // Unlocks: the account's latest achievements across its games, newest
  // first, read from Steam (see unlocks.py). Read when the screen opens;
  // the server asks Steam again at most every few minutes, or on Refresh.
  var unlocksData = null, unlocksError = null, unlocksBusy = false, unshownOpen = false;
  // Whether a Steam Web API key is set: null until the server says, so
  // neither screen shows the wrong text first.
  var unlocksHasKey = null, unlocksKeyOpen = false, unlocksKeyError = null, unlocksKeyLoaded = false;
  // force: Force refresh (⌥-click Refresh), which also asks Steam which
  // games are Private (otherwise once a day).
  function loadUnlocks(refresh, force) {
    if (unlocksBusy) return;
    unlocksBusy = true;
    renderUnlocks();
    api("/api/unlocks" + (refresh ? "?refresh=1" + (force ? "&force=1" : "") : ""))
      .then(function (d) {
        unlocksData = d; unlocksError = null; unlocksHasKey = d.has_key;
        if (gamePage && !gamePage.error && !d.syncing) openGamePage(gamePageFor, true);
      })
      .catch(function (e) {
        unlocksError = e;
        if (e.data && "has_key" in e.data) unlocksHasKey = e.data.has_key;
      })
      .then(function () { unlocksBusy = false; renderUnlocks(); });
  }
  // The server checks Steam again shortly after achievements change (by
  // hand, or a run's unlock); look then, to show it checking and what's new.
  var checkSoon = [];
  function expectCheck() {
    checkSoon.forEach(clearTimeout);
    // After each of the server's two checks (15s and a minute after).
    checkSoon = [17000, 62000].map(function (ms) { return setTimeout(function () { loadUnlocks(false); }, ms); });
  }
  function unlockDay(date) {
    var day = function (d) { return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime(); };
    var diff = Math.round((day(new Date()) - day(date)) / 86400000);
    if (diff === 0) return "Today";
    if (diff === 1) return "Yesterday";
    return date.toLocaleDateString([], {weekday: "long", month: "long", day: "numeric",
      year: date.getFullYear() === new Date().getFullYear() ? undefined : "numeric"});
  }
  // How far back the list goes (Day … All, unlocks_range in settings.json):
  // the calendar's day, week, month or year so far, so Day is since
  // midnight, not the last 24 hours. Weeks start on week_start's day.
  var unlocksRange = "month", weekStart = "monday";
  var WEEK_STARTS = {sunday: 0, monday: 1, saturday: 6};
  function rangeSince(range) {
    var d = new Date();
    d.setHours(0, 0, 0, 0);
    if (range === "week") d.setDate(d.getDate() - (d.getDay() - WEEK_STARTS[weekStart] + 7) % 7);
    else if (range === "month") d.setDate(1);
    else if (range === "year") d.setMonth(0, 1);
    else if (range !== "day") return -Infinity;
    return d.getTime() / 1000;
  }
  function rangeText(range) {
    return {day: "today", week: "this week", month: "this month", year: "in " + new Date().getFullYear()}[range] || "in total";
  }
  var unlocksPoll = null;
  // The Library's two sections (library_tab in settings.json).
  var libraryTab = "achievements";
  // How Games are sorted (defaults: library_sort, library_order).
  var gamesSort = "played", gamesOrder = "desc", appliedLib = {};
  var ORDER_NAMES = {played: ["Newest first", "Oldest first"], achievement: ["Newest first", "Oldest first"],
    name: ["Z \u2192 A", "A \u2192 Z"], progress: ["Most first", "Least first"], playtime: ["Most first", "Least first"],
    duration: ["Longest first", "Shortest first"],
    date: ["Newest first", "Oldest first"], default: ["Reversed", "In order"]};
  function orderName(sort, order) { return ORDER_NAMES[sort][order === "desc" ? 0 : 1]; }
  // Sorting, as chips like the filters: a row of sorts, the picked one
  // with an arrow for its order (clicked again, it flips). In a menu in
  // Games and on a game's page, and in Settings → Library.
  var SORTS = {games: [["played", "Last played"], ["achievement", "Last achievement"], ["name", "Name"],
    ["progress", "Progress"], ["playtime", "Play time"], ["duration", "Duration"]], ach: [["default", "Default"], ["date", "Date unlocked"], ["name", "Name"]]};
  // A game's achievements: unlocked and locked apart, or in one list.
  var GROUPS = [["status", "On"], ["none", "Off"]];
  // A–Z, Steam's own order, or newest / most first.
  function naturalOrder(sort) { return sort === "name" || sort === "default" ? "asc" : "desc"; }
  function chipRow(key, choices, value) {
    return '<div class="filter-list" data-choice="' + key + '">' + choices.map(function (c) {
      var on = c[0] === value;
      return '<button class="filter-chip' + (on ? " on" : "") + '" type="button" data-value="' + c[0] + '" aria-pressed="' + on + '">' + c[1] + "</button>";
    }).join("") + "</div>";
  }
  // Over a sort menu's chips, as Filters has over its.
  var SORT_TITLE = '<div class="filters-head"><span class="filters-title">Sort by</span></div>';
  function sortRowsHtml(sorts, sort, order) {
    return '<div class="filter-list" data-choice="sort">' + sorts.map(function (c) {
      var on = c[0] === sort;
      return '<button class="filter-chip' + (on ? " on" : "") + '" type="button" data-value="' + c[0] + '" aria-pressed="' + on + '"' +
        (on ? ' data-order="' + order + '" data-tip="' + orderName(sort, order) + '"' : "") + ">" + c[1] +
        (on ? '<span class="chip-arrow">' + (order === "desc" ? "\u2193" : "\u2191") + "</span>" : "") + "</button>";
    }).join("") + "</div>";
  }
  // The menu's button: the sort's name centred, and its order's arrow at
  // the right edge, where it stays whatever the name.
  function sortLabel(sorts, sort, order) {
    var name = sorts.filter(function (c) { return c[0] === sort; })[0][1];
    return '<span class="sort-name">' + escapeHtml(name) + '</span><span class="sort-arrow">' + (order === "desc" ? "\u2193" : "\u2191") + "</span>";
  }
  // A chip picked: what changes. A new sort starts on its natural order;
  // the one already picked flips its order.
  function onChoice(el, then) {
    el.addEventListener("click", function (e) {
      var chip = e.target.closest("[data-value]"), row = chip && chip.closest("[data-choice]");
      if (!row) return;
      var change = {}, key = row.getAttribute("data-choice"), value = chip.getAttribute("data-value");
      change[key] = value;
      if (key === "sort") change.order = !chip.classList.contains("on") ? naturalOrder(value)
        : chip.getAttribute("data-order") === "desc" ? "asc" : "desc";
      then(change);
    });
  }
  function sortGames(games) {
    function key(g) {
      if (gamesSort === "name") return g.name.toLowerCase();
      if (gamesSort === "achievement") return g.last_unlock || 0;
      if (gamesSort === "playtime") return g.playtime || 0;
      if (gamesSort === "duration") { var d = unlockSpan(g); return d === null ? -1 : d; }
      if (gamesSort === "progress") return g.total ? g.unlocked / g.total : -1;
      return g.played || 0;
    }
    var dir = gamesOrder === "desc" ? -1 : 1;
    return games.slice().sort(function (a, b) {
      var ka = key(a), kb = key(b);
      var c = typeof ka === "string" ? ka.localeCompare(kb) : ka - kb;
      return c * dir || a.name.localeCompare(b.name);
    });
  }
  // How long a game's achievements took: its first unlock to its last, or
  // null with fewer than two timed ones. Shown as "45 min", "6 h", "12 days",
  // "5 months" or "6.1 years".
  function unlockSpan(g) {
    return g.first_unlock && g.last_unlock && g.last_unlock > g.first_unlock ? g.last_unlock - g.first_unlock : null;
  }
  function fmtSpan(seconds) {
    if (seconds === null) return "";
    if (seconds < 3600) return Math.max(1, Math.round(seconds / 60)) + " min";
    if (seconds < 48 * 3600) return Math.round(seconds / 3600) + " h";
    var days = seconds / 86400;
    if (days < 60) return Math.round(days) + " days";
    if (days < 365) return Math.round(days / 30.44) + " months";
    return (days / 365.25).toFixed(1).replace(/\.0$/, "") + " years";
  }
  function fmtPlaytime(minutes) {
    if (!minutes) return "";
    return minutes < 60 ? minutes + " min played" : Math.round(minutes / 60).toLocaleString() + " h played";
  }
  function fmtDay(seconds) {
    var at = new Date(seconds * 1000), opts = {month: "short", day: "numeric"};
    if (at.getFullYear() !== new Date().getFullYear()) opts.year = "numeric";
    return at.toLocaleDateString([], opts);
  }
  // Games: each game's achievement progress, play time and when it was
  // last played; games marked Private or hidden in Steam faded, with an
  // eye-off mark, like a game on its break in Runs.
  // Private or hidden in Steam: an eye-off mark, named on hover.
  var EYE_OFF = '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
    '<path d="M2.2 2.2l11.6 11.6M6.6 3.5A6.9 6.9 0 0 1 8 3.4c3.2 0 5.3 2.5 6.1 4.6a8 8 0 0 1-1.9 2.8M4.1 4.9A8.2 8.2 0 0 0 1.9 8c.8 2.1 2.9 4.6 6.1 4.6a6.6 6.6 0 0 0 2.9-.7M6.6 6.7a2 2 0 0 0 2.7 2.7"/></svg>';
  // Counters: the game has achievements that track progress in a stat
  // (kill 200 enemies), which an unlock doesn't move. Flagged with an
  // icon in Schedule, Runs and Library; what it means is on hover.
  var COUNTER_ICON = '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" aria-hidden="true">' +
    '<path d="M3.5 3.5v9M6.5 3.5v9M9.5 3.5v9M12.5 3.5v9M2 10.5l12-5"/></svg>';
  var COUNTERS_TIP = "Some achievements track stats (like kill counts)";
  function counterMark(g) {
    return g.counters > 0 ? '<span class="mark-counters" data-tip="' + COUNTERS_TIP + '" aria-label="' + COUNTERS_TIP + '">' + COUNTER_ICON + "</span>" : "";
  }
  function markHtml(g) {
    if (!g.private) return "";
    return '<span class="mark-off" data-tip="Private" aria-label="Private">' + EYE_OFF + "</span>";
  }
  // Search: games whose name has every word typed, in any order.
  var gamesQuery = "";
  function searchGames(games) {
    var words = gamesQuery.toLowerCase().split(/\s+/).filter(Boolean);
    if (!words.length) return games;
    return games.filter(function (g) {
      var name = g.name.toLowerCase();
      return words.every(function (w) { return name.indexOf(w) !== -1; });
    });
  }
  // A game's progress: its bar, then (on its own page) "unlocked / total"
  // with the slash in the same place, then the percentage (gold at 100%).
  function progressHtml(unlocked, total) {
    var pct = total ? Math.round(100 * unlocked / total) : 0;
    return '<span class="lib-bar" aria-hidden="true"><span style="width:' + Math.min(pct, 100) + '%"></span></span>' +
      '<span class="lib-count"><span class="lib-got">' + unlocked + '</span><span class="lib-of">/</span><span class="lib-all">' + total + "</span></span>" +
      '<span class="lib-state">' + Math.min(pct, 100) + "%</span>";
  }
  // Which games show: a chip per group, each "show" (either way), "only"
  // (games in it) or "hide" (games not in it, the chip struck through).
  // A game shows when it fits every chip set, or with Match any, one of
  // them. Active: in none of the others. Chips in Games' Filters menu (for
  // a while) and in Settings → Library (the defaults). Each with what it
  // says on hover: either way, only, not.
  var FILTERS = [
    ["active", "Active", "library_active", "Active / Inactive", "Only active games", "No active games"],
    ["finished", "Finished", "library_finished", "Finished / Unfinished", "Only finished games", "Only unfinished games"],
    ["private", "Private", "library_private", "Private / Public", "Only private games", "Only public games"],
    ["noAch", "No achievements", "library_no_achievements", "With / Without achievements",
      "Only games without achievements", "Only games with achievements"]];
  function gameGroups(g) {
    var groups = {finished: !!g.finished, private: !!g.private, noAch: !g.stats};
    groups.active = !(groups.finished || groups.private || groups.noAch);
    return groups;
  }
  // matchId: where Match goes, when not under the chips in the same list.
  // Each chip's hover says what it does, or unset, what a click makes it.
  function renderFilterList(id, values, matchId) {
    if (matchId) byId(matchId).innerHTML = matchHtml(values);
    var focused = byId(id).contains(document.activeElement) ? document.activeElement.getAttribute("data-filter") : null;
    byId(id).innerHTML = FILTERS.map(function (f) {
      var v = values[f[0]];
      var tip = v === "only" ? f[4] : v === "hide" ? f[5] : f[3];
      return '<button class="filter-chip' + (v === "only" ? " on" : v === "hide" ? " not" : "") + '" type="button" data-filter="' + f[0] +
        '" aria-pressed="' + (v === "only" || v === "hide") + '" data-tip="' + tip + '">' + escapeHtml(f[1]) + "</button>";
    }).join("") + (matchId ? "" : '<span class="filter-break"></span>' + matchHtml(values));
    if (focused) byId(id).querySelector('[data-filter="' + focused + '"]').focus({preventScroll: true});
  }
  // Match: whether a game has to fit every status set (blue or red) or
  // just one, saying which under its name; All | Any as one switch.
  function matchHtml(values) {
    var any = values.match === "any";
    var side = function (value, text) {
      var on = any === (value === "any");
      return '<button class="' + (on ? "on" : "") + '" type="button" data-filter="match-' + value + '" aria-pressed="' + on + '">' +
        text + "</button>";
    };
    return '<span class="match-text"><span class="filters-title">Match</span><span class="match-desc">' +
      (any ? "Games that fit any status set" : "Games that fit every status set") + "</span></span>" +
      '<span class="seg-switch" role="group" aria-label="Match">' + side("all", "All") + side("any", "Any") + "</span>";
  }
  // A click goes either way → only → not → either way; right-click (or
  // Option-click) goes back to either way. match-all / match-any pick that.
  function nextFilters(values, key, clear) {
    var next = {match: values.match === "any" ? "any" : "all"};
    FILTERS.forEach(function (f) { next[f[0]] = values[f[0]] === "only" || values[f[0]] === "hide" ? values[f[0]] : "show"; });
    if (key.indexOf("match-") === 0) next.match = clear ? "all" : key.slice(6);
    else next[key] = clear ? "show" : {show: "only", only: "hide", hide: "show"}[next[key]];
    return next;
  }
  function onFilterList(id, then) {
    function pick(e, only) {
      var chip = e.target.closest("[data-filter]");
      if (!chip) return;
      e.preventDefault();
      then(chip.getAttribute("data-filter"), only);
    }
    byId(id).addEventListener("click", function (e) { pick(e, e.altKey); });
    byId(id).addEventListener("contextmenu", function (e) { pick(e, true); });
  }
  var libFilter = {active: "show", finished: "show", private: "show", noAch: "show", match: "all"};
  // Match all / any applies only to explicit include or exclude rules.
  function filterGames(games) {
    var set = FILTERS.filter(function (f) { return libFilter[f[0]] === "only" || libFilter[f[0]] === "hide"; });
    return games.filter(function (g) {
      var groups = gameGroups(g);
      var fits = function (f) { return libFilter[f[0]] === "only" ? groups[f[0]] : !groups[f[0]]; };
      return !set.length || (libFilter.match === "any" ? set.some(fits) : set.every(fits));
    });
  }
  // Marked finished (done with, for good) on its page.
  // The game's pages elsewhere, as icon buttons: Steam's logo (from Simple
  // Icons, CC0) and SteamHunters' own icon (steamhunters.png, its favicon).
  var STEAM_ICON = '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M11.979 0C5.678 0 .511 4.86.022 11.037l6.432 2.658c.545-.371 1.203-.59 1.912-.59.063 0 .125.004.188.006l2.861-4.142V8.91c0-2.495 2.028-4.524 4.524-4.524 2.494 0 4.524 2.031 4.524 4.527s-2.03 4.525-4.524 4.525h-.105l-4.076 2.911c0 .052.004.105.004.159 0 1.875-1.515 3.396-3.39 3.396-1.635 0-3.016-1.173-3.331-2.727L.436 15.27C1.862 20.307 6.486 24 11.979 24c6.627 0 11.999-5.373 11.999-12S18.605 0 11.979 0zM7.54 18.21l-1.473-.61c.262.543.714.999 1.314 1.25 1.297.539 2.793-.076 3.332-1.375.263-.63.264-1.319.005-1.949s-.75-1.121-1.377-1.383c-.624-.26-1.29-.249-1.878-.03l1.523.63c.956.4 1.409 1.5 1.009 2.455-.397.957-1.497 1.41-2.454 1.012H7.54zm11.415-9.303c0-1.662-1.353-3.015-3.015-3.015-1.665 0-3.015 1.353-3.015 3.015 0 1.665 1.35 3.015 3.015 3.015 1.663 0 3.015-1.35 3.015-3.015zm-5.273-.005c0-1.252 1.013-2.266 2.265-2.266 1.249 0 2.266 1.014 2.266 2.266 0 1.251-1.017 2.265-2.266 2.265-1.253 0-2.265-1.014-2.265-2.265z"/></svg>';
  var STEAMHUNTERS_ICON = '<img src="steamhunters.png" alt="" aria-hidden="true">';
  // Open in Library: shown over a game's icon in Runs on hover.
  var LIBRARY_ICON = '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
    '<path d="M3.5 2.5v11M6.5 2.5v11M9.3 3.1l3.2 10.2"/></svg>';
  // Open in Runs: shown over the game's icon on hover.
  var RUNS_ICON = '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round" aria-hidden="true"><path d="M5 3.3v9.4l7.3-4.7z"/></svg>';
  var CHECK_ICON = '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
    '<circle cx="8" cy="8" r="6.2"/><path d="M5.3 8.2l1.8 1.8 3.6-3.8"/></svg>';
  function finishedMark(g) {
    return g.finished ? '<span class="mark-off mark-finished" data-tip="Marked finished" aria-label="Marked finished">' + CHECK_ICON + "</span>" : "";
  }
  // When a game was last played comes from Steam with a key; without one
  // it isn't known, so a game isn't called never played.
  function neverPlayed(g) { return !g.played && unlocksHasKey === true && !g.unlocked; }
  function playedText(g) { return g.played ? "Played " + fmtDay(g.played) : neverPlayed(g) ? "Never played" : ""; }
  function renderGames(d) {
    var games = sortGames(d && !unlocksError ? d.games_list || [] : []);
    byId("games-sort-label").innerHTML = sortLabel(SORTS.games, gamesSort, gamesOrder);
    byId("games-sort-pop").innerHTML = SORT_TITLE + sortRowsHtml(SORTS.games, gamesSort, gamesOrder);
    renderFilterList("games-filter-list", libFilter, "games-match");
    var off = FILTERS.filter(function (f) { return libFilter[f[0]] === "only" || libFilter[f[0]] === "hide"; }).length;
    byId("games-filters-label").textContent = "Filters";
    byId("games-filters-label").classList.toggle("on", !!off);
    byId("games-filters-all").disabled = !off && libFilter.match === "all";
    // Which games show, as the filters and the search say; what's counted
    // is just those.
    var kept = searchGames(filterGames(games));
    var complete = kept.filter(function (g) { return g.total && g.unlocked >= g.total; }).length;
    var unshown = kept.filter(function (g) { return g.unreadable && !g.private; });
    var parts = [];
    var query = gamesQuery.trim();
    if (d && !unlocksError && query && !kept.length) {
      parts.push("No games match \u201c" + escapeHtml(query) + "\u201d");
    } else if (d && !unlocksError) {
      parts.push((kept.length < games.length ? "Showing " : "") + "<b>" + kept.length.toLocaleString() + "</b>" + (kept.length < games.length ? " of " + games.length.toLocaleString() : "") +
        " game" + (games.length === 1 ? "" : "s"));
      if (complete) parts.push(complete.toLocaleString() + " with 100% achievements");
      if (unshown.length) {
        parts.push('<button class="link-btn" type="button" id="games-unshown-btn" aria-expanded="' + unshownOpen + '">' +
          unshown.length + " not shown by Steam</button>");
      }
    }
    byId("games-status").innerHTML = unlocksError ? problemHtml("warn", (unlocksError.data || {}).title, unlocksError.message)
      : parts.length ? "<div>" + parts.join(" \u00b7 ") + "</div>" : "";
    // Games Steam doesn't show though they aren't Private (a Private
    // game's achievements are never shown, so it's counted as private).
    byId("games-unshown").hidden = !(unshown.length && unshownOpen);
    if (unshown.length) {
      byId("games-unshown").textContent = "Steam doesn't show the achievements of " +
        unshown.map(function (g) { return g.name; }).sort().join(", ") + ", though " +
        (unshown.length === 1 ? "it isn't" : "they aren't") + " marked Private.";
      byId("games-unshown-btn").addEventListener("click", function () {
        unshownOpen = !unshownOpen;
        renderGames(unlocksData);
      });
    }
    var shown = kept;
    byId("games-list").hidden = !shown.length;
    byId("games-table").hidden = !shown.length;
    byId("games-columns").hidden = !local || !shown.length;
    patchHtml(byId("games-list"), shown.map(function (g) {
      var progress;
      if (!g.stats) progress = '<span class="lib-dim">No achievements</span>';
      else if (g.unreadable) progress = '<span class="lib-dim">' + (g.private ? "Not shown while Private" : "Not shown by Steam") + "</span>";
      else if (!g.read) progress = '<span class="lib-dim">' + (neverPlayed(g) ? "Never played" : "Not read yet") + "</span>";
      else progress = progressHtml(g.unlocked, g.total);
      var done = g.total && g.unlocked >= g.total;
      return '<div class="lib-game' + (g.private ? " private-game" : "") + (done ? " complete" : "") +
        '" data-appid="' + g.appid + '" role="button" tabindex="0">' +
        iconHtml("lib-icon", g.icon, g.name) +
        '<div class="lib-text"><div class="lib-name"><span class="name-text">' + escapeHtml(g.name) + "</span>" + finishedMark(g) + markHtml(g) + counterMark(g) + "</div>" +
        '<div class="lib-progress">' + progress + "</div></div>" +
        // In the app the columns are headed (Last played, Play time), so
        // their cells say just the date and the hours.
        '<div class="unlock-meta"><div>' + escapeHtml(local ? (g.played ? fmtDay(g.played) : neverPlayed(g) ? "Never" : "") : playedText(g)) + "</div>" +
        "<div>" + escapeHtml(local ? fmtPlaytime(g.playtime).replace(/ played$/, "") : fmtPlaytime(g.playtime)) + "</div>" +
        '<div class="lib-span"' + (unlockSpan(g) !== null ? ' data-tip="From its first achievement to its last"' : "") + ">" +
        escapeHtml(fmtSpan(unlockSpan(g))) + "</div></div></div>";
    }).join(""));
  }
  // A game's own page: its achievements, unlocked (newest first) and
  // locked, from what's saved; links to Steam and SteamHunters, and to its
  // run when STAR has a schedule for it.
  var gamePage = null, gamePageFor = null;
  // Quiet: reloaded when a check finishes (no "Loading", same scroll, an
  // error leaves what's shown).
  function openGamePage(appid, quiet) {
    if (!quiet) {
      gamePageFor = appid;
      gamePage = null;
      resetAchEdit();
      renderGamePage();
      swapIn(byId("unlocks-screen"));
      scrollLibraryTop();
    }
    api("/api/unlocks/game?appid=" + encodeURIComponent(appid)).then(function (p) {
      if (gamePageFor === appid) { gamePage = p; renderGamePage(); changeSeen(p); showAchFocus(); }
    }).catch(function (e) {
      if (gamePageFor === appid && !quiet) { gamePage = {error: e}; renderGamePage(); }
    });
  }
  function closeGamePage() {
    gamePageFor = gamePage = null;
    resetAchEdit();
    renderGamePage();
    swapIn(byId("unlocks-screen"));
    backToAchievements();
  }
  // A hidden achievement's description (Steam's stats page leaves it out;
  // STAR fills it in): shown as Settings → Library says, hidden_descriptions:
  // once unlocked, always, or never; else "Hidden achievement".
  var hiddenDesc = "unlocked";
  function achDescHtml(a, locked) {
    if (a.secret && (hiddenDesc === "none" || (hiddenDesc === "unlocked" && locked)))
      return '<div class="unlock-desc lib-dim">Hidden achievement</div>';
    return a.description ? '<div class="unlock-desc">' + escapeHtml(a.description) + "</div>" : "";
  }
  // Unlocking and locking by hand, on a game's page: behind a lock like
  // the timeline's. A locked achievement clicked gets a tick on its icon
  // (and its place in the order), to unlock; an unlocked one an X, to
  // lock again; on Apply (clicked twice).
  var achEdit = false, achPicks = [], achDrops = {}, achError = null;
  // Changes started here, until seen done (then said in a toast).
  var achWatch = {}, achPoll = null;
  function achRunning() { return !!(gamePage && gamePage.change && gamePage.change.running); }
  // A game's page as read: while a change runs, read again in a moment;
  // once one started here is done, say how it went.
  function changeSeen(p) {
    var ch = p.change;
    clearTimeout(achPoll);
    if (ch && ch.running) {
      achPoll = setTimeout(function () { if (gamePageFor === p.appid) openGamePage(p.appid, true); }, 3000);
      return;
    }
    if (!ch || !achWatch[p.appid]) return;
    delete achWatch[p.appid];
    if (ch.error) { showToast(ch.error[0] + ". " + ch.error[1]); return; }
    showToast([ch.unlocked.length ? "Unlocked " + ch.unlocked.length : "", ch.locked.length ? "locked " + ch.locked.length : ""].filter(Boolean).join(", "));
    loadUnlocks(false);
    expectCheck();
  }
  var TICK = '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3.8 8.3l2.7 2.7 5.7-6"/></svg>';
  var CROSS = '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M4.5 4.5l7 7M11.5 4.5l-7 7"/></svg>';
  var LOCK_ICON = '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" aria-hidden="true"><rect x="3" y="7" width="10" height="7" rx="1.5"/><path class="lock-shackle" d="M5.5 7V5a2.5 2.5 0 0 1 5 0v2"/></svg>';
  function resetAchEdit() {
    achEdit = false; achPicks = []; achDrops = {}; achError = null;
    delete armedUntil["ach-apply"];
  }
  // What's marked, with Apply, in the sort's bar before the
  // lock (so marking moves nothing); empty when nothing is.
  function achApplyHtml() {
    var n = achPicks.length, m = Object.keys(achDrops).length;
    if (achRunning()) return '<span class="ach-apply"><span>' + escapeHtml("Playing it, sending to Steam\u2026") + "</span></span>";
    if (!achEdit) return "";
    if (!n && !m) return "";
    // Locking again drops the marks (as for a timeline), so there's no Clear.
    var what = [n ? "Unlock " + n : "", m ? "Lock " + m : ""].filter(Boolean).map(function (t) { return "<span>" + t + "</span>"; }).join("");
    var armed = isArmed("ach-apply");
    return '<span class="ach-apply"><span class="ach-what">' + what + "</span>" +
      '<button class="btn-ghost primary-ghost' + (armed ? " armed" : "") + '" type="button" data-ach-apply>' +
      (armed ? "Confirm" : "Apply") + "</button></span>";
  }
  function achRowsHtml(list, groupKind) {
    return list.map(function (a) {
      var when = "", kind = groupKind || a.kind;
      if (kind === "unlocked") {
        var at = new Date(a.time * 1000);
        when = '<div class="unlock-meta"><div>' + escapeHtml(fmtDay(a.time)) + "</div><div>" + escapeHtml(fmtClockSec(at)) + "</div></div>";
      }
      var icon = iconHtml("unlock-icon", a.icon, "ach"), attrs = "";
      var pick = achPicks.indexOf(a.name), drop = !!achDrops[a.name];
      if (achEdit) {
        // The whole row is clicked; its icon shows what Apply will do.
        var mark = kind === "locked" && pick !== -1 ? '<span class="ach-mark add">' + TICK + "<b>" + (pick + 1) + "</b></span>"
          : kind !== "locked" && drop ? '<span class="ach-mark drop">' + CROSS + "</span>" : "";
        icon = '<span class="ach-icon">' + icon + mark + "</span>";
        attrs = ' role="button" tabindex="0" data-ach="' + escapeHtml(a.name) + '" data-ach-kind="' + (kind === "locked" ? "locked" : "unlocked") +
          '" aria-pressed="' + (pick !== -1 || drop) + '"';
      }
      return '<div class="unlock' + (kind === "locked" ? " locked" : "") + (achEdit ? " editable" : "") + (achEdit && drop ? " dropping" : "") +
        (achEdit && kind === "locked" && pick !== -1 ? " picked" : "") + '"' + attrs +
        ' data-name="' + escapeHtml(a.name) + '">' + icon +  // data-name: Jump to achievement
        '<div class="unlock-text"><div class="unlock-name">' + escapeHtml(a.name) + "</div>" +
        achDescHtml(a, kind === "locked") + "</div>" + when + "</div>";
    }).join("");
  }
  // A game's achievements, unlocked and locked kept apart or all in one
  // list, by date unlocked (those without a time, and locked ones, after,
  // in Steam's order) or by name; picked here, kept until the app closes
  // (the defaults are in Settings → Library).
  var achSort = "date", achOrder = "desc", achGroup = "status", achSortOpen = false;
  function sortAch(list, timed) {
    var out = list.slice();
    if (achSort === "name") out.sort(function (a, b) { return a.name.localeCompare(b.name); });
    else if (achSort === "default") {
      // Steam's own order (alist's), once known; until then as read.
      var at = {};
      ((gamePage && gamePage.order) || []).forEach(function (n, i) { if (!(n in at)) at[n] = i; });
      var pos = function (a) { return a.name in at ? at[a.name] : 1e9; };
      out.sort(function (a, b) { return pos(a) - pos(b); });
    } else if (timed) out.sort(function (a, b) { return a.time - b.time; });
    else return out;
    return achOrder === "desc" ? out.reverse() : out;
  }
  function renderGamePage() {
    var page = byId("game-page"), open = gamePageFor !== null;
    // Behind a game's page, as in Runs: a glow in its art's main colour.
    tintFor(open ? {appid: gamePageFor} : null, function (tint) {
      setTint(byId("unlocks-screen"), tint);
    }, "library");
    page.hidden = !open;
    byId("games-index").hidden = open;
    byId("library-tabs").hidden = open;
    byId("game-back").hidden = !open;
    if (!open) { page.innerHTML = ""; return; }
    var p = gamePage, html = "";
    if (!p) { page.innerHTML = html + '<div class="unlocks-status">' + escapeHtml("Loading\u2026") + "</div>"; return; }
    if (p.error) { page.innerHTML = html + problemHtml("warn", (p.error.data || {}).title, p.error.message); return; }
    var done = p.total && p.unlocked >= p.total;
    // Yours on Steam and SteamHunters (by Steam ID, as for a custom URL), else the game's.
    var mine = p.steamid ? "profiles/" + encodeURIComponent(p.steamid) + "/" : "";
    var steamPath = p.steamid ? mine + "achievements/" + p.appid : "stats/" + p.appid + "/achievements/";
    var links = '<a class="btn-ghost game-site" target="_blank" rel="noopener" data-tip="Steam" aria-label="Steam" href="https://steamcommunity.com/' +
        steamPath + '">' + STEAM_ICON + "</a>" +
      '<a class="btn-ghost game-site" target="_blank" rel="noopener" data-tip="SteamHunters" aria-label="SteamHunters" href="https://steamhunters.com/' +
        mine + "apps/" + p.appid + '/achievements">' + STEAMHUNTERS_ICON + "</a>" +
      '<button class="btn-ghost game-site game-finish' + (p.finished ? " on" : "") + '" type="button" data-game-finish aria-pressed="' + !!p.finished +
        '" data-tip="' + (p.finished ? "Finished (click to unmark)" : "Mark as finished") + '" aria-label="Finished">' + CHECK_ICON + "</button>";
    // A banner: the game's art faded in from the right, under its name and
    // progress, with its links as a column of icons at the right.
    html += '<div class="game-banner"' + (p.appid > 0 ? ' style="--card-hero: ' + escapeHtml(heroUrl(p)) + '"' : "") + ">" +
      '<div class="game-head' + (p.private ? " private-game" : "") + (done ? " complete" : "") + '">' +
      // With a run, the icon opens it in Runs (a ▶ over it on hover), so
      // the banner is as tall with it as without.
      (p.star ? '<button class="game-run" type="button" data-game-run="' + escapeHtml(p.star) + '" data-tip="Open in Runs" aria-label="Open in Runs">' +
        iconHtml("lib-icon", p.icon, p.name) + '<span class="game-run-play">' + RUNS_ICON + "</span></button>" : iconHtml("lib-icon", p.icon, p.name)) +
      '<div class="lib-text"><div class="game-title"><span class="name-text">' + escapeHtml(p.name) + "</span>" + finishedMark(p) + markHtml(p) + counterMark(p) + "</div>" +
      (p.read ? '<div class="lib-progress">' + progressHtml(p.unlocked, p.total) + "</div>" : "") +
      '<div class="game-meta">' + escapeHtml([playedText(p), fmtPlaytime(p.playtime)].filter(Boolean).join(" \u00b7 ")) + "</div>" +
      "</div></div>" + '<div class="game-links">' + links + "</div></div>";
    if (p.unreadable && p.private) html += noticeHtml("info", "Steam doesn't show the achievements of a game marked Private. To show them, right-click it in Steam \u2192 Manage \u2192 Unmark as Private.");
    else if (p.unreadable) html += noticeHtml("warn", "Steam doesn't show this game's achievements, though it isn't marked Private.");
    else if (!p.read && !p.stats) html += noticeHtml("info", "This game has no achievements.");
    else if (!p.read && neverPlayed(p)) html += noticeHtml("info", "Never played, so nothing is unlocked yet.");
    else if (!p.read) html += noticeHtml("info", "Not read from Steam yet. It's read on a coming check.");
    else {
      if (!p.full) html += noticeHtml("info", "Its locked achievements show after its next read from Steam.");
      html += '<div class="unlocks-bar ach-sort games-sort">' +
        '<details class="filters-menu sort-menu" id="ach-sort-menu"' + (achSortOpen ? " open" : "") + ">" +
        '<summary class="btn-ghost">' + sortLabel(SORTS.ach, achSort, achOrder) + "</summary>" +
        '<div class="filters-pop">' + SORT_TITLE + sortRowsHtml(SORTS.ach, achSort, achOrder) + "</div></details>" +
        '<button class="btn-ghost ach-group' + (achGroup === "status" ? " on" : "") + '" type="button" data-ach-group aria-pressed="' +
        (achGroup === "status") + '" data-tip="Show unlocked and locked achievements in separate lists">Split by status</button>' +
        '<span class="ach-right">' + achApplyHtml() +
        '<button class="lock-toggle ach-lock" type="button" data-ach-lock aria-pressed="' + achEdit + '"' + (achRunning() ? " disabled" : "") +
        ' data-tip="' + (achEdit ? "Discard changes you haven't applied" : "Choose achievements to unlock or lock again") + '">' + LOCK_ICON +
        "<span>" + (achEdit ? "Cancel editing" : "Edit achievements") + "</span></button></span></div>" +
        (achEdit && achError ? problemHtml("warn", (achError.data || {}).title, achError.message) : "");
      var tag = function (list, kind) { return list.map(function (a) { return Object.assign({kind: kind}, a); }); };
      if (achGroup === "none") {
        var all = sortAch(tag(p.unlocks, "unlocked"), true).concat(tag(p.untimed, "untimed"), tag(p.locked, "locked"));
        if (achSort !== "date") all = sortAch(all);
        html += '<div class="unlocks-day">All \u00b7 ' + all.length + '</div><div class="unlocks-group">' + achRowsHtml(all) + "</div>";
      } else {
        var groups = [["Unlocked", sortAch(p.unlocks, true), "unlocked"], ["Unlocked, no time kept by Steam", sortAch(p.untimed), "untimed"], ["Locked", sortAch(p.locked), "locked"]];
        groups.forEach(function (g) {
          if (!g[1].length) return;
          html += '<div class="unlocks-day">' + g[0] + " \u00b7 " + g[1].length + '</div><div class="unlocks-group">' + achRowsHtml(g[1], g[2]) + "</div>";
        });
      }
    }
    page.innerHTML = html;
  }
  byId("games-list").addEventListener("click", function (e) {
    var row = e.target.closest("[data-appid]");
    if (row) openGamePage(Number(row.getAttribute("data-appid")));
  });
  byId("games-list").addEventListener("keydown", function (e) {
    var row = e.target.closest("[data-appid]");
    if (row && (e.key === "Enter" || e.key === " ")) { e.preventDefault(); openGamePage(Number(row.getAttribute("data-appid"))); }
  });
  byId("game-page").addEventListener("click", function (e) {
    var run = e.target.closest("[data-game-run]");
    if (run) { selectedRun = run.getAttribute("data-game-run"); showScreen("work"); setView("runs"); }
    if (e.target.closest("[data-ach-group]")) {
      achGroup = achGroup === "status" ? "none" : "status";
      renderGamePage();
      return;
    }
    if (e.target.closest("[data-ach-lock]") && !achRunning()) {
      var on = !achEdit;
      resetAchEdit();
      achEdit = on;
      renderGamePage();
      return;
    }
    var box = e.target.closest("[data-ach]");
    if (box && achEdit && !achRunning()) {
      var name = box.getAttribute("data-ach");
      if (box.getAttribute("data-ach-kind") === "locked") {
        var at = achPicks.indexOf(name);
        if (at === -1) achPicks.push(name); else achPicks.splice(at, 1);
      } else if (achDrops[name]) delete achDrops[name];
      else achDrops[name] = true;
      delete armedUntil["ach-apply"];
      achError = null;
      renderGamePage();
      return;
    }
    if (e.target.closest("[data-ach-apply]") && gamePage) {
      if (!isArmed("ach-apply")) {
        armedUntil["ach-apply"] = Date.now() + ARM_MS;
        setTimeout(function () { if (gamePage) renderGamePage(); }, ARM_MS + 50);
        renderGamePage();
        return;
      }
      delete armedUntil["ach-apply"];
      var appid = gamePage.appid;
      // Started on the server, which takes a minute or so (the game plays
      // around the changes); the page follows it, left or not.
      api("/api/unlocks/achievements", {appid: appid, unlock: achPicks, lock: Object.keys(achDrops)}).then(function () {
        achWatch[appid] = true;
        if (gamePageFor !== appid) return;
        resetAchEdit();
        gamePage.change = {running: true};
        renderGamePage();
        changeSeen(gamePage);
      }).catch(function (err) {
        achError = err;
        renderGamePage();
      });
      return;
    }
    var fin = e.target.closest("[data-game-finish]");
    if (fin && gamePage) {
      fin.disabled = true;
      api("/api/unlocks/finished", {appid: gamePage.appid, finished: !gamePage.finished}).then(function (r) {
        gamePage.finished = r.finished;
        ((unlocksData && unlocksData.games_list) || []).forEach(function (g) { if (g.appid === r.appid) g.finished = r.finished; });
        renderGamePage();
        renderGames(unlocksData);
      }).catch(function (err) { fin.disabled = false; showToast("Couldn't save: " + err.message); });
    }
  });
  byId("game-back").addEventListener("click", closeGamePage);
  byId("game-page").addEventListener("keydown", function (e) {
    var row = e.target.closest("[data-ach]");
    if (row && (e.key === "Enter" || e.key === " ")) { e.preventDefault(); row.click(); }
  });
  // The sort menu stays open while its chips redraw the page.
  onChoice(byId("game-page"), function (c) {
    if (c.sort) achSort = c.sort;
    if (c.order) achOrder = c.order;
    if (c.group) achGroup = c.group;
    renderGamePage();
  });
  byId("game-page").addEventListener("toggle", function (e) {
    if (e.target.id === "ach-sort-menu") achSortOpen = e.target.open;
  }, true);

  // Each Library section keeps its own place when switching tabs.
  var libraryScroll = {};
  function showLibraryTab(tab) {
    if (tab === libraryTab) return;
    var scroller = libraryScroller();
    libraryScroll[libraryTab] = scroller.scrollTop;
    libraryTab = tab;
    renderUnlocks();
    swapIn(byId("unlocks-screen"));
    scroller.scrollTop = libraryScroll[tab] || 0;
    api("/api/settings", {settings: {library_tab: libraryTab}}).then(function (d) { runSettings = d.settings; })
      .catch(function (err) { showToast("Couldn't save: " + err.message); });
  }
  byId("library-tabs").addEventListener("click", function (e) {
    var b = e.target.closest("[data-tab]");
    if (b) showLibraryTab(b.getAttribute("data-tab"));
  });

  // ---- Jump to achievement ----
  // An unlock clicked in Achievements, or an achievement's name in a
  // timeline, opens its game's page in Library scrolled to it, lit for a
  // moment. (To remove: everything tagged "Jump to achievement" here, in
  // style.css, and the data-name on a game page's rows.)
  var achFocus = null, achReturn = null;
  byId("unlocks-list").addEventListener("click", function (e) {
    jumpToAch(e.target.closest("[data-jump-ach]"));
  });
  function jumpToAch(row) {
    if (!row) return;
    var top = libraryScroller().scrollTop;
    openAchInLibrary(Number(row.getAttribute("data-jump-appid")), row.getAttribute("data-jump-ach"), "Achievements", function () {
      requestAnimationFrame(function () { libraryScroller().scrollTo({top: top}); });
    });
  }
  // A game's page in Library, at one of its achievements. From
  // Achievements, Back (named `from`) returns there via back(); from a
  // timeline it's the usual Back to Games, and the Runs or Schedule tab
  // returns to the timeline, where it was.
  function openAchInLibrary(appid, name, from, back) {
    if (document.body.getAttribute("data-screen") !== "unlocks") showUnlocks();
    showLibraryTab("games");
    openGamePage(appid);
    achFocus = name;
    achReturn = back ? function () { showLibraryTab("achievements"); back(); } : null;
    byId("game-back").textContent = "\u2190 " + (from || "Games");
  }
  function openAchFromTimeline(link) {
    openAchInLibrary(Number(link.getAttribute("data-lib-appid")), link.getAttribute("data-lib-ach"));
  }
  document.addEventListener("click", function (e) {
    var link = e.target.closest("[data-lib-ach]");
    if (link) openAchFromTimeline(link);
  });
  document.addEventListener("keydown", function (e) {
    var link = e.target.closest && e.target.closest("[data-lib-ach]");
    if (link && (e.key === "Enter" || e.key === " ")) { e.preventDefault(); openAchFromTimeline(link); }
  });
  byId("unlocks-list").addEventListener("keydown", function (e) {
    var row = e.target.closest("[data-jump-ach]");
    if (row && e.target === row && (e.key === "Enter" || e.key === " ")) { e.preventDefault(); jumpToAch(row); }
  });
  function showAchFocus() {
    if (achFocus === null) return;
    // Loosely: a schedule's names come from a paste.
    var loose = function (s) { return s.toLowerCase().replace(/\s+/g, " ").trim(); };
    var row = [].filter.call(byId("game-page").querySelectorAll("[data-name]"), function (r) {
      return loose(r.getAttribute("data-name")) === loose(achFocus);
    })[0];
    if (!row) return;
    achFocus = null;
    row.scrollIntoView({block: "center", behavior: "smooth"});
    row.classList.add("ach-focus");
  }
  function backToAchievements() {
    achFocus = null;
    if (!achReturn) return;
    var back = achReturn;
    achReturn = null;
    byId("game-back").textContent = "\u2190 Games";
    back();
  }
  // Back to top, once the list has been scrolled a long way. In the app
  // the Library scrolls on its own; on a page, the window does.
  function libraryScroller() {
    return local ? byId("unlocks-screen") : document.scrollingElement;
  }
  function scrollLibraryTop() { libraryScroller().scrollTo({top: 0, behavior: "smooth"}); }
  function syncToTop() {
    byId("to-top").hidden = document.body.getAttribute("data-screen") !== "unlocks" || libraryScroller().scrollTop < 900;
  }
  byId("unlocks-screen").addEventListener("scroll", syncToTop);
  window.addEventListener("scroll", syncToTop);
  byId("to-top").addEventListener("click", scrollLibraryTop);

  // From Settings → Library → Check Steam (library_check): at set times
  // of day counted from midnight (every 6 hours: 12 AM, 6 AM, 12 PM, 6 PM),
  // or right away when the last check is older than the latest of them.
  var CHECK_HOURS = {"1h": 1, "3h": 3, "6h": 6, "12h": 12, "24h": 24};
  function nextCheckText(fetchedAt) {
    var pick = (runSettings || []).filter(function (x) { return x.key === "library_check"; })[0];
    var every = CHECK_HOURS[pick ? pick.value : "6h"];
    if (!every) return "Checks on Refresh";
    var last = new Date();
    last.setHours(Math.floor(last.getHours() / every) * every, 0, 0, 0);
    if (fetchedAt * 1000 < last.getTime()) return "Checking soon";
    var next = new Date(last.getTime());
    next.setHours(last.getHours() + every);
    var at = fmtAt((next.getTime() - Date.now()) / 1000);
    return "Next check " + (/^\d/.test(at) ? "at " + at : at.replace(/^Tomorrow/, "tomorrow"));
  }
  function renderUnlocks() {
    var d = unlocksData, list = byId("unlocks-list");
    var syncing = d && d.syncing;
    byId("library-tabs").querySelectorAll("[data-tab]").forEach(function (b) {
      b.setAttribute("aria-pressed", String(b.getAttribute("data-tab") === libraryTab));
    });
    byId("pane-achievements").hidden = libraryTab !== "achievements";
    byId("pane-games").hidden = libraryTab !== "games";
    renderGames(d);
    syncToTop();
    byId("unlocks-refresh").disabled = unlocksBusy || !!syncing;
    byId("unlocks-range").querySelectorAll("[data-range]").forEach(function (b) {
      b.setAttribute("aria-pressed", String(b.getAttribute("data-range") === unlocksRange));
    });
    // The unlocks in the chosen range, and in how many games.
    var range = rangeText(unlocksRange), since = rangeSince(unlocksRange);
    var shown = d && !unlocksError ? d.unlocks.filter(function (u) { return u.time >= since; }) : [];
    var gameCount = {};
    shown.forEach(function (u) { gameCount[u.appid] = 1; });
    gameCount = Object.keys(gameCount).length;
    // What's counted (beside the range).
    var lines = [];
    if (d && !unlocksError) {
      var line = "<b>" + shown.length.toLocaleString() + "</b> achievement" + (shown.length === 1 ? "" : "s") + " in <b>" +
        gameCount + "</b> game" + (gameCount === 1 ? "" : "s") + " " + range;
      if (d.offline) line = '<span class="warn">' + escapeHtml(d.offline) + "</span> " + line;
      lines.push(line);
    }
    byId("unlocks-status").innerHTML = lines.map(function (l) { return "<div>" + l + "</div>"; }).join("");
    // Top right, for both tabs: when Steam was read, and under it a check
    // going on (Refresh, or on schedule) or when the next one is due.
    byId("unlocks-updated").textContent = d && !unlocksError && d.fetched_at ? "Updated " + fmtClock(new Date(d.fetched_at * 1000)) : "";
    var check = byId("unlocks-check"), checking = unlocksBusy || syncing;
    check.classList.toggle("busy", !!checking);
    check.textContent = checking
      ? (syncing && syncing.total ? "Reading your games: " + syncing.done + " of " + syncing.total + "\u2026" : "Checking Steam\u2026")
      : d && !unlocksError && d.fetched_at ? nextCheckText(d.fetched_at) : "";
    if (unlocksError) {
      patchHtml(list, problemHtml("warn", (unlocksError.data || {}).title, unlocksError.message));
    } else if (d && !shown.length) {
      patchHtml(list, syncing && !d.unlocks.length ? "" : emptyHtml("\u2606", "No unlocks " + range + "."));
    } else if (d) {
      var html = "", lastDay = null;
      shown.forEach(function (u) {
        var at = new Date(u.time * 1000), day = unlockDay(at);
        if (day !== lastDay) {
          html += (lastDay ? "</div>" : "") + '<div class="unlocks-day">' + escapeHtml(day) + '</div><div class="unlocks-group">';
          lastDay = day;
        }
        html += '<div class="unlock' + (u.private ? " private-game" : "") + '" role="button" tabindex="0" data-jump-appid="' + u.appid +
          '" data-jump-ach="' + escapeHtml(u.name) + '">' +  // Jump to achievement
          iconHtml("unlock-icon", u.icon, "ach") +
          '<div class="unlock-text"><div class="unlock-name">' + escapeHtml(u.name) + "</div>" +
          achDescHtml(u, false) + "</div>" +
          '<div class="unlock-meta"><div class="unlock-game">' + markHtml(u) + escapeHtml(u.game) + "</div>" +
          '<div class="unlock-time">' + escapeHtml(fmtClockSec(at)) + "</div></div></div>";
      });
      patchHtml(list, html + (lastDay ? "</div>" : ""));
    } else if (!unlocksBusy) patchHtml(list, "");
    // While Steam is read in the background, look again in a moment.
    clearTimeout(unlocksPoll);
    if (syncing && document.body.getAttribute("data-screen") === "unlocks") {
      unlocksPoll = setTimeout(function () { loadUnlocks(false); }, 2000);
    }
    // Which games, in a line; the key itself is in Settings.
    byId("unlocks-note").hidden = unlocksHasKey !== false;
    byId("unlocks-note").innerHTML = unlocksHasKey !== false ? ""
      : 'The games in STAR. To include every game you play, add a Steam Web API key in <button class="link-btn" type="button" data-go-settings>Settings</button>.';
    var go = byId("unlocks-note").querySelector("[data-go-settings]");
    if (go) go.addEventListener("click", showGuide);
    renderUnlocksKey();
  }
  // The range and sorting picked here last until the app closes; their
  // defaults are in Settings → Library.
  byId("unlocks-range").addEventListener("click", function (e) {
    var b = e.target.closest("[data-range]");
    if (!b || b.getAttribute("data-range") === unlocksRange) return;
    unlocksRange = b.getAttribute("data-range");
    renderUnlocks();
  });
  onChoice(byId("games-sort-pop"), function (c) {
    if (c.sort) gamesSort = c.sort;
    gamesOrder = c.order;
    renderUnlocks();
  });
  // Filters, here for a while (the defaults are in Settings → Library).
  ["games-filter-list", "games-match"].forEach(function (id) {
    onFilterList(id, function (key, only) {
      libFilter = nextFilters(libFilter, key, only);
      renderGames(unlocksData);
    });
  });
  byId("games-filters-all").addEventListener("click", function () {
    FILTERS.forEach(function (f) { libFilter[f[0]] = "show"; });
    libFilter.match = "all";
    renderGames(unlocksData);
  });
  // A menu (Filters, a sort) closes on a click outside it. (composedPath:
  // a click on a chip redraws it, leaving the clicked chip, or on a game's
  // page the whole menu, out of the page by now; so it's matched by id.)
  document.addEventListener("click", function (e) {
    var inside = e.composedPath().filter(function (n) { return n.classList && n.classList.contains("filters-menu"); })[0];
    document.querySelectorAll(".filters-menu[open]").forEach(function (menu) {
      if (!inside || inside.id !== menu.id) menu.open = false;
    });
  });
  document.addEventListener("keydown", function (e) {
    if (e.key !== "Escape") return;
    var menus = document.querySelectorAll(".filters-menu[open]");
    if (!menus.length) return;
    var focused = document.activeElement.closest(".filters-menu[open]") || menus[menus.length - 1];
    menus.forEach(function (menu) { menu.open = false; });
    focused.querySelector("summary").focus();
    e.preventDefault();
  });
  byId("games-search").addEventListener("input", function () {
    gamesQuery = this.value;
    renderGames(unlocksData);
  });
  // Settings → Library: the defaults, saved in settings.json.
  function saveSetting(values) {
    api("/api/settings", {settings: values}).then(function (d) { runSettings = d.settings; syncToggles(); })
      .catch(function (err) { showToast("Couldn't save: " + err.message); });
  }
  byId("default-range").addEventListener("change", function () { saveSetting({unlocks_range: this.value}); });
  onFilterList("lib-filters", function (key, only) {
    var values = {}, now = {}, change = {};
    (runSettings || []).forEach(function (x) { values[x.key] = x.value; });
    FILTERS.forEach(function (f) { now[f[0]] = values[f[2]]; });
    now.match = values.library_match;
    var next = nextFilters(now, key, only);
    FILTERS.forEach(function (f) { change[f[2]] = next[f[0]]; });
    change.library_match = next.match;
    saveSetting(change);
  });
  byId("library-check").addEventListener("change", function () { saveSetting({library_check: this.value}); });
  byId("hidden-descriptions").addEventListener("change", function () { saveSetting({hidden_descriptions: this.value}); });
  byId("week-start").addEventListener("change", function () { saveSetting({week_start: this.value}); });
  onChoice(byId("lib-sort"), function (c) {
    var change = {library_order: c.order};
    if (c.sort) change.library_sort = c.sort;
    saveSetting(change);
  });
  onChoice(byId("lib-ach-sort"), function (c) {
    var change = {achievement_order: c.order};
    if (c.sort) change.achievement_sort = c.sort;
    saveSetting(change);
  });
  onChoice(byId("lib-ach-group"), function (c) { saveSetting({achievement_group: c.group}); });
  // Settings → Library: the Steam Web API key, so the Library covers the
  // whole library.
  function renderUnlocksKey() {
    var unknown = unlocksHasKey === null;
    var link = '<a href="https://steamcommunity.com/dev/apikey" target="_blank" rel="noopener">steamcommunity.com/dev/apikey</a>';
    byId("unlocks-key-text").innerHTML = unknown ? "" : unlocksHasKey
      ? "Your Steam Web API key adds every game you play."
      : "The Library covers the games in STAR. To include every game you play, add a Steam Web API key: get one free at " +
        link + " (any domain name works).";
    byId("unlocks-key-actions").hidden = unknown || !unlocksHasKey || unlocksKeyOpen;
    byId("unlocks-key-form").hidden = unknown || (unlocksHasKey && !unlocksKeyOpen);
    byId("unlocks-key-error").hidden = !unlocksKeyError;
    byId("unlocks-key-error").textContent = unlocksKeyError || "";
  }
  byId("unlocks-key-change").addEventListener("click", function () {
    unlocksKeyOpen = true;
    renderUnlocksKey();
    byId("unlocks-key-input").focus();
  });
  byId("unlocks-key-remove").addEventListener("click", function () { saveUnlocksKey(""); });
  function saveUnlocksKey(key) {
    api("/api/unlocks/key", {key: key}).then(function (r) {
      unlocksHasKey = r.has_key;
      unlocksKeyOpen = false;
      unlocksKeyError = null;
      byId("unlocks-key-input").value = "";
      unlocksData = null;  // read again with the library in or out
      renderUnlocks();
    }).catch(function (e) {
      unlocksKeyError = ((e.data || {}).title ? e.data.title + ". " : "") + e.message;
      renderUnlocksKey();
    });
  }
  byId("unlocks-key-form").addEventListener("submit", function (e) {
    e.preventDefault();
    var key = byId("unlocks-key-input").value.trim();
    if (key) saveUnlocksKey(key);
  });
  byId("unlocks-refresh").addEventListener("click", function (e) { loadUnlocks(true, e.altKey); });
  // Holding ⌥ turns Refresh into Force refresh, as a Mac menu shows an item's alternate.
  function refreshLabel(e) { byId("unlocks-refresh").textContent = e.altKey ? "Force refresh" : "Refresh"; }
  document.addEventListener("keydown", refreshLabel);
  document.addEventListener("keyup", refreshLabel);
  window.addEventListener("blur", function () { byId("unlocks-refresh").textContent = "Refresh"; });
  function showUnlocks() {
    showScreen("unlocks");
    if (unlocksHasKey === null) {
      api("/api/unlocks/key").then(function (r) {
        if (unlocksHasKey === null) { unlocksHasKey = r.has_key; renderUnlocks(); }
      }).catch(function () {});
    }
    loadUnlocks(false);
  }

  // The section title, secondary navigation and action share fixed slots.
  // The new contents of a section or tab ease in where the old ones were
  // (see .swap-in), so a change reads as one page changing, not a new one.
  function swapIn(el) {
    if (!local || !el) return;
    el.classList.remove("swap-in");
    void el.offsetWidth;  // so the animation starts again
    el.classList.add("swap-in");
  }
  var workspaceShown = null;
  function syncWorkspace() {
    if (!local) return;
    var screen = document.body.getAttribute("data-screen");
    var runs = screen === "work" && currentView === "runs";
    var title = screen === "guide" ? "Settings" : screen === "unlocks" ? "Library" : runs ? "Runs" : "Schedule";
    if (workspaceShown && workspaceShown !== title) swapIn(byId("page"));
    workspaceShown = title;
    byId("workspace-title").textContent = title;
    byId("workspace-runs-tabs").hidden = !runs;
    // Settings: General (every section), then Run settings and Library
    // display, each a tab of its own (see enableLocal).
    byId("workspace-settings-tabs").hidden = screen !== "guide";
    byId("schedule-tabs").hidden = screen !== "work" || runs;
  }

  // Main app sections in the top bar.
  function syncScreenSwitch() {
    var work = document.body.getAttribute("data-screen") === "work";
    byId("switch-schedule").classList.toggle("active", work && currentView !== "runs");
    byId("switch-runs").classList.toggle("active", work && currentView === "runs");
    byId("switch-unlocks").classList.toggle("active", document.body.getAttribute("data-screen") === "unlocks");
    byId("switch-guide").classList.toggle("active", document.body.getAttribute("data-screen") === "guide");
    byId("screen-switch").querySelectorAll("button").forEach(function (button) {
      button.setAttribute("aria-pressed", String(button.classList.contains("active")));
      if (button.classList.contains("active")) button.setAttribute("aria-current", "page");
      else button.removeAttribute("aria-current");
    });
    syncWorkspace();
  }
  byId("switch-schedule").addEventListener("click", function () { showScreen("work"); setView(scheduleView); });
  byId("switch-runs").addEventListener("click", function () { showScreen("work"); setView("runs"); });
  byId("switch-unlocks").addEventListener("click", showUnlocks);
  byId("switch-guide").addEventListener("click", showGuide);
  document.querySelector(".topbar .brand").addEventListener("click", function (e) {
    e.preventDefault();
    showScreen("work");
    setView("runs");
  });

  // This page is STAR's own (the app, or runsteamunlocker --ui). Without
  // STAR's server behind it (the website), it goes to the website; in the
  // app, it asks again.
  function ping() {
    api("/api/ping").then(function (data) { if (data.app === "steam-unlocker") enableLocal(); else noServer(); }).catch(noServer);
  }
  function noServer() {
    if (document.documentElement.hasAttribute("data-desktop")) setTimeout(ping, 1000);
    else location.replace("index.html");
  }
  if (/^https?:$/.test(location.protocol)) ping();
  else noServer();

  // ---------------------------------------------------------------
  loadDraft();
  recompute();
  render();
})();
