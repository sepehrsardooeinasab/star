(function () {
  "use strict";

  // ---------------------------------------------------------------
  // Parsing / session-splitting / CSV logic — unchanged pure functions
  // (verified byte-identical to builder/*.py's output).
  // ---------------------------------------------------------------
  var MONTHS = {jan:0,feb:1,mar:2,apr:3,may:4,jun:5,jul:6,aug:7,sep:8,oct:9,nov:10,dec:11};
  var SKIP_LINE_RE = /^\d+\s+guides?$/i;
  // "2,944 / 7,212   197   39.8 %" — unlocked / owners, points, percentage.
  var STATS_RE = /^[\d,]+\s*\/\s*[\d,]+\s+([\d,]+)\s+(\d+(?:\.\d+)?)\s*%$/;
  var TIME_RE = /(\d{1,2})\s+(\w{3})\s+'(\d{2})\s+@\s+(\d{1,2}):(\d{2})(?::(\d{2}))?\s+(am|pm)/i;

  function groupIntoBlocks(lines) {
    var blocks = [], current = [], blankRun = 0;
    for (var i = 0; i < lines.length; i++) {
      var line = lines[i];
      if (line === "") { blankRun++; continue; }
      if (blankRun >= 2 && current.length) { blocks.push(current); current = []; }
      blankRun = 0;
      current.push(line);
    }
    if (current.length) blocks.push(current);
    return blocks;
  }

  function parseTimestamp(match) {
    var month = MONTHS[match[2].toLowerCase()];
    if (month === undefined) return null;
    var hour = parseInt(match[4], 10) % 12;
    if (match[7].toLowerCase() === "pm") hour += 12;
    var year = 2000 + parseInt(match[3], 10);
    var d = new Date(year, month, parseInt(match[1], 10), hour, parseInt(match[5], 10), match[6] ? parseInt(match[6], 10) : 0);
    return isNaN(d.getTime()) ? null : d.getTime();
  }

  function parseExport(text) {
    var lines = text.split(/\r?\n/).map(function (l) { return l.trim(); });
    var blocks = groupIntoBlocks(lines);
    var achievements = [];
    var entries = []; // every achievement, locked or not, in pasted order
    var totalCount = 0;

    blocks.forEach(function (block, bi) {
      var orderIndex = bi + 1;
      var idx = 0;
      while (idx < block.length && SKIP_LINE_RE.test(block[idx])) idx++;
      if (idx >= block.length) return;

      var achName = block[idx];
      idx++;
      totalCount++;

      var unlockTime = null, points = null, percent = null;
      for (var i = idx; i < block.length; i++) {
        var s = block[i].match(STATS_RE);
        if (s && percent === null) {
          points = parseInt(s[1].replace(/,/g, ""), 10);
          percent = parseFloat(s[2]);
          continue;
        }
        var m = block[i].match(TIME_RE);
        if (m) { unlockTime = parseTimestamp(m); break; }
      }
      entries.push({name: achName, points: points, percent: percent});

      if (unlockTime !== null) {
        achievements.push({ach_name: achName, ach_id: orderIndex, unlock_time: unlockTime});
      }
    });

    // ach_id is the achievement's position as pasted, which must match the
    // game's default/schema order (same order ASF's alist/aset use) for the
    // generated config to target the right achievements. If the paste comes
    // out fully ordered (either direction) by one of SteamHunters' other
    // sort keys, that's a strong sign the page was sorted by it instead,
    // which would silently scramble ach_id even though the delay/session
    // math below stays correct either way (it re-sorts by real timestamp
    // regardless of paste order).
    var sortedBy = detectSort(achievements, entries);

    achievements.sort(function (a, b) { return a.unlock_time - b.unlock_time; });
    return {list: achievements, sortedBy: sortedBy, totalCount: totalCount};
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

  // Returns the name of the sort key the paste appears ordered by, or null.
  function detectSort(unlocked, entries) {
    var byNumber = function (a, b) { return a - b; };
    var known = function (key) {
      var vals = entries.map(function (e) { return e[key]; });
      // Only trust a key if it parsed for every entry.
      return vals.every(function (v) { return v !== null; }) ? vals : [];
    };

    if (isMonotonic(unlocked.map(function (a) { return a.unlock_time; }), byNumber)) return "unlock date";
    if (isMonotonic(entries.map(function (e) { return e.name; }), NAME_COLLATOR.compare)) return "name";
    if (isMonotonic(known("percent"), byNumber)) return "percentage";
    if (isMonotonic(known("points"), byNumber)) return "points";
    return null;
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

    items.forEach(function (ach) {
      var delay = ach.delay;

      if (current.length) {
        var key = String(ach.ach_id);
        var auto = delay > gapLimit || cumulative + delay > cumulativeLimit;
        autoBreaks[key] = auto;
        if (key in breaks ? breaks[key] : auto) {
          sessions.push(current); durations.push(cumulative); current = []; cumulative = 0;
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

  function buildConfig(appid, sessions, gaps, copiedFrom) {
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
    if (copiedFrom) config.copied_from = copiedFrom;
    config.achievements = achievements;
    return config;
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
  function parseDelayInput(text) {
    var t = String(text).trim();
    return /^\d+$/.test(t) ? parseInt(t, 10) : null;
  }

  function isLabelRow(row) {
    return row[3] === "";
  }

  // ui (optional) = {targets, gapActions, edits, originals, breaks,
  // autoBreaks} makes delay_s cells clickable to edit (edited ones are
  // highlighted with an undo button) and adds small add/remove-gap
  // buttons after the session number / gap label. achievementClass
  // (optional) gives each achievement row a class, by its index.
  function rowsToTable(rows, ui, achievementClass) {
    var achievement = -1;
    var head = rows[0];
    var body = rows.slice(1);
    var html = '<div class="table-wrap"><table class="csv-table"><thead><tr>';
    head.forEach(function (h) { html += "<th>" + escapeHtml(h) + "</th>"; });
    html += "</tr></thead><tbody>";

    function delayCell(r, ri) {
      var id = ui && ui.targets[ri + 1];
      if (!id) return "<td>" + escapeHtml(r[CSV_DELAY_COL + 1]) + "</td>";
      var edited = id in ui.edits;
      var title = edited
        ? "Edited (was " + ui.originals[id] + "s) — click to change"
        : "Click to edit this delay";
      return '<td class="delay-cell editable' + (edited ? " edited" : "") + '" data-id="' + escapeHtml(id) +
        '" title="' + escapeHtml(title) + '">' + escapeHtml(r[CSV_DELAY_COL + 1]) +
        (edited ? '<button class="undo-edit" type="button" data-undo="' + escapeHtml(id) + '" title="Undo this edit">↺</button>' : "") +
        "</td>";
    }

    // A gap is manual when it differs from what the limits would decide:
    // an added gap shows a highlighted −, a removed one a highlighted +.
    function gapButton(ri) {
      var act = ui && ui.gapActions[ri + 1];
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

    body.forEach(function (r, ri) {
      if (isLabelRow(r)) {
        var cls = /^Gap/.test(r[0]) ? "gap-row" : /^Copied from:/.test(r[0]) ? "meta-row" : "session-row";
        html += '<tr class="' + cls + '"><td colspan="' + CSV_DELAY_COL + '">' + escapeHtml(r[0]) + gapButton(ri) + "</td>" +
          "<td>" + escapeHtml(r[CSV_DELAY_COL]) + "</td>" + delayCell(r, ri) + "</tr>";
      } else {
        var rowClass = achievementClass ? achievementClass(++achievement) : "";
        html += "<tr" + (rowClass ? ' class="' + rowClass + '"' : "") + "><td>" + escapeHtml(r[0]) + gapButton(ri) + "</td>" +
          r.slice(1, CSV_DELAY_COL).map(function (c) { return "<td>" + escapeHtml(c) + "</td>"; }).join("") +
          "<td>" + escapeHtml(r[CSV_DELAY_COL]) + "</td>" + delayCell(r, ri) + "</tr>";
      }
    });
    html += "</tbody></table></div>";
    return html;
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
    folderBtn: document.getElementById("folder-btn"),
    folderStatus: document.getElementById("folder-status"),
    boxTitle: document.getElementById("box-title"),
    statsStrip: document.getElementById("stats-strip"),
    toast: document.getElementById("toast"),
    jsonSlot: document.getElementById("json-slot"),
    csvSlot: document.getElementById("csv-slot"),
    runsList: document.getElementById("runs-list"),
    runsLog: document.getElementById("runs-log"),
    runsLogTitle: document.getElementById("runs-log-title"),
    inputAlertSlot: document.getElementById("input-alert-slot")
  };

  function sortedByMsg(key) {
    return "This paste looks sorted by " + key + ", not the game's default order. Achievement numbering needs default order, so the generated IDs will be wrong. Re-copy the page with the default sort.";
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
  var dirHandle = null;

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
    render();
    if (view === "runs") refreshRuns();
  }

  Object.keys(navButtons).forEach(function (key) {
    navButtons[key].addEventListener("click", function () { setView(key); });
  });

  function noticeHtml(kind, text) {
    return '<div class="notice ' + kind + '">' + escapeHtml(text) + "</div>";
  }

  function emptyHtml(glyph, text) {
    return '<div class="empty-hint"><div class="glyph">' + glyph + "</div><p>" + escapeHtml(text) + "</p></div>";
  }

  function saveDraft() {
    try {
      localStorage.setItem("unlock-scheduler-draft", JSON.stringify({
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
      var raw = localStorage.getItem("unlock-scheduler-draft");
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

  // ---- core recompute (pure, runs on every input change) ----
  function recompute() {
    var appidVal = parseInt(els.appid.value, 10);
    var gameName = els.gameName.value.trim().toLowerCase();
    var copiedFrom = els.copiedFrom.value.trim();
    var gapLimitSec = (parseFloat(els.gapLimit.value) || 0) * 3600;
    var cumLimitSec = (parseFloat(els.cumLimit.value) || 0) * 3600;
    var minGapSec = (parseFloat(els.minGap.value) || 0) * 3600;

    var errors = [];
    if (!appidVal || appidVal <= 0) errors.push("Enter a valid numeric App ID in Settings.");
    if (!gameName) errors.push("Enter a game name in Settings.");

    var parsed = parseExport(els.exportText.value || "");
    if (parsed.list.length === 0) errors.push("No unlocked achievements with a valid timestamp were found in the pasted text.");

    if (errors.length) { latest = {errors: errors}; return; }

    var withDelays = addDelays(parsed.list);

    var timeMap = {};
    withDelays.forEach(function (a, i) {
      if (i === 0) return;
      (timeMap[a.unlock_time] = timeMap[a.unlock_time] || []).push(a.ach_name);
    });
    var simultaneous = Object.keys(timeMap).filter(function (t) { return timeMap[t].length > 1; });

    var split = applyEdits(splitSessions(withDelays, gapLimitSec, cumLimitSec, breaks), edits);
    var config = buildConfig(appidVal, split.sessions, split.gaps, copiedFrom);

    // Unlike the warnings below, a re-sorted paste makes every ach_id
    // wrong, so it's surfaced loudly (red Download button, input-pane
    // notice) rather than only as a notice in the output tabs.
    var dangers = [];
    if (parsed.sortedBy) dangers.push(sortedByMsg(parsed.sortedBy));

    var warnings = [];
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
    if (longWaits.length === 1) {
      warnings.push(longWaits[0] + " waits longer than your \"Session break after\" setting after your edits. It stays in its session, " +
        "so the game keeps running in ASF the whole time.");
    } else if (longWaits.length) {
      warnings.push(longWaits.length + " achievements wait longer than your \"Session break after\" setting after your edits: " +
        longWaits.join(", ") + ". They stay in their sessions, so the game keeps running in ASF the whole time.");
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
        gapRange: split.gaps.length ? roughDuration(Math.min.apply(null, split.gaps)) + " – " + roughDuration(Math.max.apply(null, split.gaps)) : "—"
      }
    };
  }

  function fileKeyForView(view) {
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

  // First click arms `key` (render shows a "click again" label); a second
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
    var label = isArmed("discard")
      ? "Click again to discard " + n + " edit" + (n === 1 ? "" : "s")
      : "Discard edits";
    return '<div class="notice info edits-banner"><span>' + n + " Timeline edit" + (n === 1 ? "" : "s") +
      ", so the pasted text is locked until you download or discard " + (n === 1 ? "it" : "them") + ".</span>" +
      '<button class="btn-ghost discard-edits' + (isArmed("discard") ? " armed" : "") + '" type="button">' + label + "</button></div>";
  }

  function render() {
    // Pasted text is locked while there are edits: changing it would
    // re-parse into a different achievement list the edits don't match.
    var locked = editCount() > 0;
    els.exportText.readOnly = locked;
    els.exportText.classList.toggle("locked", locked);
    els.resetBtn.textContent = locked && isArmed("reset")
      ? "Click again to reset (discards edits)" : "Reset all fields";
    els.resetBtn.classList.toggle("armed", locked && isArmed("reset"));

    // nav "has content" dots
    var ok = latest && !latest.errors.length;
    ["json", "csv"].forEach(function (k) {
      navButtons[k].classList.toggle("has-content", !!ok);
    });

    // stats strip (shown once we have valid data, regardless of view)
    if (ok) {
      els.statsStrip.innerHTML =
        "<span><b>" + latest.stats.achievements + " / " + latest.stats.totalAchievements + "</b> achievements</span>" +
        "<span><b>" + latest.stats.sessions + "</b> sessions</span>" +
        "<span>len <b>" + latest.stats.sessionLen + "</b></span>" +
        "<span>gap <b>" + latest.stats.gapRange + "</b></span>";
    } else {
      // Kept (with a hint) so the bar doesn't change height on paste.
      els.statsStrip.innerHTML = "<span>Paste an export to see its achievements, sessions and gaps.</span>";
    }

    // Download always saves everything together, so it only depends on
    // whether we have valid data at all — not on which tab is open.
    els.downloadBtn.disabled = !ok;

    var dangers = ok ? latest.dangers : [];
    var dangerHtml = dangers.map(function (d) { return noticeHtml("danger", d); }).join("");
    els.inputAlertSlot.innerHTML = dangerHtml + editsBannerHtml();
    els.downloadBtn.classList.toggle("btn-danger", dangers.length > 0);
    els.downloadBtn.textContent = local
      ? (dangers.length ? "Save anyway" : "Save to project")
      : (dangers.length ? "Download anyway" : "Download All");
    els.downloadBtn.title = dangers.join("\n");

    var fileKey = fileKeyForView(currentView);
    if (!fileKey) return;

    var slot = fileKey === "json" ? els.jsonSlot : els.csvSlot;
    if (fileKey === "csv" && ok) els.boxTitle.textContent = "Timeline (" + latest.filenames.csv + ")";

    if (!latest || latest.errors.length) {
      var msgs = latest ? latest.errors : ["Paste an export first."];
      slot.innerHTML = msgs.map(function (m) { return noticeHtml("danger", m); }).join("") +
        emptyHtml("{ }", "Fix the issue above to generate this file.");
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
    } else {
      slot.innerHTML = rowsToTable(latest.csvRows, {
        targets: latest.csvTargets, gapActions: latest.gapActions, edits: edits,
        originals: latest.originals, breaks: breaks, autoBreaks: latest.autoBreaks
      }) + warningsHtml;
    }
  }

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
  els.exportText.addEventListener("input", resetSettingFields);

  [els.exportText, els.appid, els.gameName, els.copiedFrom, els.gapLimit, els.cumLimit, els.minGap].forEach(function (el) {
    el.addEventListener("input", scheduleRecompute);
  });

  function resetAll() {
    els.exportText.value = "";
    resetSettingFields();
    edits = {};
    breaks = {};
    armedUntil = {};
    try { localStorage.removeItem("unlock-scheduler-draft"); } catch (e) {}
    recompute();
    setView("input");
  }

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
    input.value = currentDelay(id);
    input.placeholder = "seconds";
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
        showToast("Enter a whole number of seconds, e.g. 90");
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
    // A new gap starts as the achievement's old delay; open its duration
    // for editing right away.
    if (on) {
      var cell = document.querySelector('tr.gap-row td.delay-cell.editable[data-id="' + id.replace(/["\\]/g, "\\$&") + '"]');
      if (cell) startEditing(cell);
    }
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
  }

  function setAppearanceOpen(open) {
    appearanceMenu.hidden = !open;
    appearanceToggle.setAttribute("aria-expanded", String(open));
  }

  appearanceToggle.addEventListener("click", function () { setAppearanceOpen(appearanceMenu.hidden); });
  appearanceMenu.addEventListener("click", function (e) {
    var b = e.target.closest("button");
    if (!b) return;
    var theme = b.getAttribute("data-theme-choice"), accent = b.getAttribute("data-accent-choice");
    if (theme) {
      document.documentElement.setAttribute("data-theme", theme);
      try { localStorage.setItem("unlock-scheduler-theme", theme); } catch (err) {}
    }
    if (accent) {
      document.documentElement.setAttribute("data-accent", accent);
      try { localStorage.setItem("unlock-scheduler-accent", accent); } catch (err) {}
    }
    syncThemeControls();
  });
  // Closes on a click elsewhere or Escape.
  document.addEventListener("click", function (e) {
    if (!appearanceMenu.hidden && !e.target.closest(".appearance")) setAppearanceOpen(false);
  });
  document.addEventListener("keydown", function (e) {
    if (e.key === "Escape" && !appearanceMenu.hidden) { setAppearanceOpen(false); appearanceToggle.focus(); }
  });
  syncThemeControls();

  // ---------------------------------------------------------------
  // Saving: File System Access API folder (silent, Chromium-only,
  // won't work in a sandboxed iframe) > claude.ai downloads capability
  // > plain Blob download, in that order.
  // ---------------------------------------------------------------
  function useClaudeDownloads() {
    if (typeof claude === "undefined" || !claude.use) return Promise.resolve(null);
    return claude.use("downloads");
  }

  function blobDownload(filename, mime, content) {
    try {
      var blob = new Blob([content], {type: mime});
      var url = URL.createObjectURL(blob);
      var a = document.createElement("a");
      a.href = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
      return true;
    } catch (e) {
      return false;
    }
  }

  // Walks/creates each folder in dirParts under dirHandle (never clearing
  // or recreating a folder that already exists — getDirectoryHandle with
  // create:true just opens it if present), then writes filename into it.
  function saveIntoFolder(dirParts, filename, content) {
    var p = Promise.resolve(dirHandle);
    dirParts.forEach(function (part) {
      p = p.then(function (dir) { return dir.getDirectoryHandle(part, {create: true}); });
    });
    return p
      .then(function (dir) { return dir.getFileHandle(filename, {create: true}); })
      .then(function (handle) { return handle.createWritable(); })
      .then(function (writable) { return writable.write(content).then(function () { return writable.close(); }); });
  }

  function ensureFolderPermission(handle) {
    if (!handle.queryPermission) return Promise.resolve(true);
    var opts = {mode: "readwrite"};
    return handle.queryPermission(opts).then(function (state) {
      if (state === "granted") return true;
      return handle.requestPermission(opts).then(function (s) { return s === "granted"; });
    });
  }

  function setFolder(handle) {
    dirHandle = handle;
    els.folderStatus.innerHTML = handle
      ? 'Saving to <b>' + escapeHtml(handle.name) + '/</b><button class="forget-folder" type="button" ' +
        'title="Stop saving here (use normal downloads)" aria-label="Forget save folder">×</button>'
      : "";
  }

  // The chosen folder survives reloads and new windows by keeping its
  // handle in IndexedDB (handles can't go in localStorage). It's a separate
  // store from the draft, so Reset never touches it.
  var FOLDER_DB = "unlock-scheduler", FOLDER_STORE = "handles", FOLDER_KEY = "save-folder";

  function openFolderDb() {
    return new Promise(function (resolve, reject) {
      var req = indexedDB.open(FOLDER_DB, 1);
      req.onupgradeneeded = function () { req.result.createObjectStore(FOLDER_STORE); };
      req.onsuccess = function () { resolve(req.result); };
      req.onerror = function () { reject(req.error); };
    });
  }

  function folderDbRequest(mode, fn) {
    return openFolderDb().then(function (db) {
      return new Promise(function (resolve, reject) {
        var req = fn(db.transaction(FOLDER_STORE, mode).objectStore(FOLDER_STORE));
        req.onsuccess = function () { db.close(); resolve(req.result); };
        req.onerror = function () { db.close(); reject(req.error); };
      });
    });
  }

  function storeFolderHandle(handle) {
    return folderDbRequest("readwrite", function (store) {
      return handle ? store.put(handle, FOLDER_KEY) : store.delete(FOLDER_KEY);
    }).catch(function () { /* storage blocked: folder just won't persist */ });
  }

  function loadFolderHandle() {
    return folderDbRequest("readonly", function (store) { return store.get(FOLDER_KEY); })
      .catch(function () { return null; });
  }

  function saveOneFallback(downloads, filename, mime, content) {
    if (downloads) {
      return downloads.save({filename: filename, data: content}).catch(function (err) {
        if (err && err.code === "declined") throw err;
        blobDownload(filename, mime, content);
      });
    }
    blobDownload(filename, mime, content);
    return Promise.resolve();
  }

  // Saves config.json + the CSV together in one action:
  //   <folder>/jsons/config[_<name>].json
  //   <folder>/csvs/<name>.csv
  // Falls back to one browser/claude.ai save prompt per file (with a small
  // stagger) when no folder has been chosen.
  els.downloadBtn.addEventListener("click", function () {
    if (!latest || latest.errors.length) return;
    if (local) {
      var overwrite = isArmed("overwrite");
      delete armedUntil["overwrite"];
      saveToProject(overwrite);
      return;
    }

    var files = [
      {dirParts: ["jsons"], filename: latest.filenames.json, mime: "application/json", content: latest.jsonText},
      {dirParts: ["csvs"], filename: latest.filenames.csv, mime: "text/csv", content: latest.csvText}
    ];

    if (dirHandle) {
      // Must run straight from the click: requestPermission needs the
      // user gesture, and a handle restored from IndexedDB starts at "prompt".
      ensureFolderPermission(dirHandle)
        .then(function (granted) {
          if (!granted) throw new Error("permission to " + dirHandle.name + "/ was denied");
          return Promise.all(files.map(function (f) { return saveIntoFolder(f.dirParts, f.filename, f.content); }));
        })
        .then(function () { resetAll(); showToast("Saved config.json + CSV to " + dirHandle.name + "/ — fields reset"); })
        .catch(function (err) { showToast("Couldn't save: " + (err && err.message ? err.message : "unknown error")); });
      return;
    }

    useClaudeDownloads().then(function (downloads) {
      var chain = Promise.resolve();
      files.forEach(function (f, i) {
        chain = chain.then(function () {
          return saveOneFallback(downloads, f.filename, f.mime, f.content)
            .then(function () { return new Promise(function (r) { setTimeout(r, i < files.length - 1 ? 300 : 0); }); });
        });
      });
      chain.then(function () { resetAll(); showToast("Saved config.json + CSV — fields reset"); }).catch(function () {});
    }).catch(function () {
      files.forEach(function (f) { blobDownload(f.filename, f.mime, f.content); });
      resetAll();
      showToast("Saved config.json + CSV — fields reset");
    });
  });

  if (typeof window.showDirectoryPicker === "function") {
    els.folderBtn.style.display = "inline-block";
    els.folderBtn.addEventListener("click", function () {
      window.showDirectoryPicker({mode: "readwrite"}).then(function (handle) {
        setFolder(handle);
        storeFolderHandle(handle);
        showToast("Folder selected — downloads will save there silently");
      }).catch(function () { /* user cancelled, or blocked (e.g. inside a sandboxed iframe) */ });
    });
    els.folderStatus.addEventListener("click", function (e) {
      if (!e.target.closest(".forget-folder")) return;
      setFolder(null);
      storeFolderHandle(null);
      showToast("Save folder forgotten — downloads go to your browser's default");
    });
    loadFolderHandle().then(function (handle) { if (handle) setFolder(handle); });
  }

  // ---------------------------------------------------------------
  // Local app (runsteamunlocker --ui): the same page, served from this
  // machine, which can also save straight into the project and run games.
  // Runs are background processes, so this page only shows and controls
  // them; closing it never stops anything.
  // ---------------------------------------------------------------
  var local = false;
  var runsData = null, runsError = null, runsFetchedAt = 0;
  var selectedRun = null;
  var runsTimer = null;

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
    var name = els.gameName.value.trim().toLowerCase();
    api("/api/save", {name: name, config: latest.config, csv: latest.csvText, overwrite: overwrite})
      .then(function () {
        resetAll();
        delete timelines[name];  // re-saved: read its timeline again
        selectedRun = name;  // picked when Runs is opened
        showToast("Saved " + name + ". Start it from Runs in the top bar.");
      })
      .catch(function (err) {
        // Asked with a second click rather than a dialog, which the
        // desktop app's window may not show.
        if (err.data && err.data.exists) {
          armedUntil["overwrite"] = Date.now() + ARM_MS;
          showToast(err.message + " Click Save again within 4 seconds to replace it (its progress is kept).");
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
  function fmtAt(seconds) {
    var at = new Date(Date.now() + seconds * 1000);
    var time = at.toLocaleTimeString([], {hour: "2-digit", minute: "2-digit"});
    return at.toDateString() === new Date().toDateString()
      ? time : at.toLocaleDateString([], {weekday: "short"}) + " " + time;
  }

  // Countdowns come from the last fetch; count them down in between.
  function left(seconds) {
    return Math.max(0, seconds - (Date.now() - runsFetchedAt) / 1000);
  }

  function runCardHtml(g) {
    var badge = {
      in_session: ["live", "In session"],
      waiting: ["wait", g.auto ? "Waiting for next session" : "Waiting"],
      idle: ["", "Not running"],
      completed: ["", "Completed"],
      invalid: ["bad", "Invalid config"]
    }[g.state];
    var lines = [];
    if (g.state === "invalid") {
      lines.push('<span class="bad">' + escapeHtml(g.error) + "</span>");
    } else if (g.finished) {
      lines.push("All achievements unlocked. Its files moved to completed/.");
    } else if (g.total) {
      lines.push("<b>" + g.done + " / " + g.total + "</b> achievements" + (g.appid ? " · app " + g.appid : ""));
      if (g.session) {
        lines.push("Session <b>" + g.session + " of " + g.sessions + "</b> · " + g.count + " to go, ~" + fmtDur(g.duration));
        if (g.state === "in_session") {
          lines.push(g.next_unlock_in == null ? "Unlocking…"
            : "Next unlock in <b>" + fmtDur(left(g.next_unlock_in)) + "</b>");
        } else {
          var wait = left(g.ready_in);
          lines.push(wait > 0
            ? "Next session in <b>" + fmtDur(wait) + "</b> (" + fmtAt(wait) + ")"
            : "Next session can start <b>now</b>");
        }
      }
      if (g.config_changed) {
        lines.push('<span class="warn">The achievement order changed since it started. Run it once from the terminal to confirm.</span>');
      }
      if (g.stop_after) lines.push('<span class="warn">Stops after this session.</span>');
    }

    var actions = [];
    function btn(action, label, cls) {
      var armed = action === "stop" && isArmed("stop:" + g.name);
      return '<button class="' + (cls || "btn-ghost") + (armed ? " armed" : "") + '" type="button" data-action="' +
        action + '" data-name="' + escapeHtml(g.name) + '">' + (armed ? "Click again to stop" : label) + "</button>";
    }
    if (g.running) {
      actions.push(btn("stop", "Stop"));
      if (g.auto && g.state === "in_session") {
        actions.push(g.stop_after ? btn("keep-going", "Keep going") : btn("stop-after", "Stop after this session"));
      }
    } else if (g.finished) {
      actions.push(btn("dismiss", "Dismiss"));
    } else if (g.state === "idle" && !g.config_changed) {
      actions.push(btn("run", g.done ? "Continue" : "Run", "btn-primary"));
    }

    var pct = g.total ? Math.round(100 * g.done / g.total) : (g.finished ? 100 : 0);
    return '<div class="run-card' + (g.name === selectedRun ? " selected" : "") + '" data-name="' + escapeHtml(g.name) + '">' +
      '<div class="run-head"><span class="run-name">' + escapeHtml(g.name) + "</span>" +
      '<span class="run-badge ' + badge[0] + '">' + badge[1] + "</span></div>" +
      (lines.length ? '<div class="run-meta">' + lines.join("<br>") + "</div>" : "") +
      (g.state !== "invalid" ? '<div class="run-progress"><span style="width:' + pct + '%"></span></div>' : "") +
      (actions.length ? '<div class="run-actions">' + actions.join("") + "</div>" : "") +
      "</div>";
  }

  function renderRuns() {
    var games = runsData ? runsData.games : [];
    var running = games.filter(function (g) { return g.running; }).length;
    byId("switch-runs").classList.toggle("has-content", running > 0);
    if (currentView !== "runs") return;
    els.statsStrip.innerHTML = runsData
      ? "<span><b>" + games.length + "</b> game" + (games.length === 1 ? "" : "s") + "</span>" +
        "<span><b>" + running + "</b> running</span>" +
        (runsData.session ? "<span>in session: <b>" + escapeHtml(runsData.session) + "</b></span>" : "")
      : "";

    if (runsError) {
      els.runsList.innerHTML = noticeHtml("danger", "Can't reach the app: " + runsError +
        ". Start it again with runsteamunlocker --ui.");
    } else if (!runsData) {
      els.runsList.innerHTML = "";
    } else if (!games.length) {
      els.runsList.innerHTML = emptyHtml("▶", "No games yet. Make one under Schedule, then Save to project.");
    } else {
      if (!games.some(function (g) { return g.name === selectedRun; })) {
        var pick = games.filter(function (g) { return g.running; })[0] || games[0];
        selectedRun = pick.name;
      }
      els.runsList.innerHTML = games.map(runCardHtml).join("");
    }
    var paneName = runsPane === "timeline" ? "Timeline" : "Output";
    els.runsLogTitle.innerHTML = selectedRun ? paneName + " · <b>" + escapeHtml(selectedRun) + "</b>" : paneName;
    if (runsPane === "timeline") renderTimeline();
  }

  // ---- a game's timeline on Runs: its saved CSV, in the builder's table
  // (read-only), with what's unlocked so far dimmed ----
  var runsPane = "output";
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

  function timelineHtml(rows, done, running, editable) {
    var html = '<div class="table-wrap"><table class="csv-table"><thead><tr>' +
      rows[0].map(function (h) { return "<th>" + escapeHtml(h) + "</th>"; }).join("") + "</tr></thead><tbody>";
    var index = -1;
    function delayCell(r, ri) {
      var original = runEdit ? runEdit.edited[ri] : undefined;
      var cls = "delay-cell" + (editable && editable[ri] ? " run-editable" : "") + (original !== undefined ? " edited" : "");
      return '<td class="' + cls + '" data-row="' + ri + '">' + escapeHtml(r[CSV_DELAY_COL + 1]) +
        (original !== undefined ? '<button class="undo-edit" type="button" data-run-undo="' + ri +
          '" title="Undo (was ' + original + 's)">↺</button>' : "") + "</td>";
    }
    rows.slice(1).forEach(function (r, i) {
      var ri = i + 1;
      if (isLabelRow(r)) {
        var cls = /^Gap/.test(r[0]) ? "gap-row" : /^Copied from:/.test(r[0]) ? "meta-row" : "session-row";
        html += '<tr class="' + cls + '"><td colspan="' + CSV_DELAY_COL + '">' + escapeHtml(r[0]) + "</td>" +
          "<td>" + escapeHtml(r[CSV_DELAY_COL]) + "</td>" + delayCell(r, ri) + "</tr>";
        return;
      }
      index++;
      var rowClass = index < done ? "done-row" : index === done && running ? "next-row" : "";
      html += "<tr" + (rowClass ? ' class="' + rowClass + '"' : "") + ">" +
        r.slice(0, CSV_DELAY_COL + 1).map(function (c) { return "<td>" + escapeHtml(c) + "</td>"; }).join("") +
        delayCell(r, ri) + "</tr>";
    });
    return html + "</tbody></table></div>";
  }

  function renderTimeline() {
    var data = selectedRun ? timelines[selectedRun] : undefined;
    if (data === undefined && selectedRun) loadTimeline(selectedRun);
    if (data === undefined || data === "loading") return;
    if (runEdit && runEdit.name !== selectedRun) runEdit = null;
    var game = runGame(), done = doneCount(game);
    var rows = runEdit ? runEdit.rows : data && data.rows;
    var key = [selectedRun, done, !!game.running, !!rows, runEdit ? JSON.stringify(runEdit.rows) : ""].join("|");
    if (key === timelineShown) return;
    timelineShown = key;

    var canEdit = !!(data && data.config && rows && rows.length > 1 && game.state !== "completed");
    byId("timeline-bar").hidden = !canEdit;
    byId("timeline-edit").hidden = !!runEdit;
    byId("timeline-cancel").hidden = byId("timeline-save").hidden = !runEdit;
    byId("timeline-save").disabled = !runEdit || !Object.keys(runEdit.edited).length;
    byId("timeline-bar-text").textContent = runEdit
      ? "Click a delay to change it (in seconds). Only what isn't unlocked yet can change."
      : game.running ? "Locked. Stop the game to edit its timeline." : "Locked.";
    byId("timeline-edit").disabled = !!game.running;

    byId("timeline-table").innerHTML = rows && rows.length > 1
      ? timelineHtml(rows, done, game.running, runEdit && editableRows(rows, done))
      : emptyHtml("☰", "No timeline was saved with this game.");
  }

  // A session's total is the sum of its achievements' delays.
  function updateSessionTotals(rows) {
    var label = null;
    rows.forEach(function (r, ri) {
      if (ri === 0) return;
      if (isLabelRow(r)) {
        if (/^Session/.test(r[0])) { label = r; r[CSV_DELAY_COL + 1] = 0; }
        else label = null;
      } else if (label) {
        label[CSV_DELAY_COL + 1] += Number(r[CSV_DELAY_COL + 1]) || 0;
      }
    });
    rows.forEach(function (r) {
      if (/^Session/.test(r[0]) && isLabelRow(r)) r[CSV_DELAY_COL] = roughDurationCsv(r[CSV_DELAY_COL + 1]);
    });
  }

  function setRunDelay(ri, seconds) {
    var r = runEdit.rows[ri];
    var original = runEdit.edited[ri] !== undefined ? runEdit.edited[ri] : Number(r[CSV_DELAY_COL + 1]);
    r[CSV_DELAY_COL + 1] = seconds;
    r[CSV_DELAY_COL] = roughDurationCsv(seconds);
    if (seconds === original) delete runEdit.edited[ri];
    else runEdit.edited[ri] = original;
    updateSessionTotals(runEdit.rows);
    renderTimeline();
  }

  // The config with the edited delays: an achievement's own delay, or for
  // the first of a later session, the gap before it (as the builder does).
  function editedConfig(config, rows) {
    var delays = {}, gap = null;
    rows.forEach(function (r, ri) {
      if (ri === 0) return;
      if (isLabelRow(r)) { if (/^Gap/.test(r[0])) gap = Number(r[CSV_DELAY_COL + 1]); return; }
      var first = String(r[1]) === "1";
      if (!first) delays[r[3]] = Number(r[CSV_DELAY_COL + 1]);
      else if (gap !== null) delays[r[3]] = gap;
      gap = null;
    });
    var copy = JSON.parse(JSON.stringify(config));
    copy.achievements.forEach(function (a) {
      if (String(a.id) in delays) a.delay = delays[String(a.id)];
    });
    return copy;
  }

  byId("timeline-edit").addEventListener("click", function () {
    var data = timelines[selectedRun];
    if (!data || !data.rows) return;
    runEdit = {name: selectedRun, rows: JSON.parse(JSON.stringify(data.rows)), edited: {}};
    timelineShown = "";
    renderTimeline();
  });
  byId("timeline-cancel").addEventListener("click", function () {
    runEdit = null;
    timelineShown = "";
    renderTimeline();
  });
  byId("timeline-save").addEventListener("click", function () {
    var data = timelines[selectedRun], name = selectedRun;
    if (!runEdit || !data || !data.config) return;
    api("/api/save", {name: name, config: editedConfig(data.config, runEdit.rows),
                      csv: toCsv(runEdit.rows), overwrite: true})
      .then(function () {
        runEdit = null;
        delete timelines[name];
        timelineShown = "";
        renderTimeline();
        showToast("Saved " + name + ". The next sessions use the new timing.");
      })
      .catch(function (err) { showToast("Couldn't save: " + err.message); });
  });

  byId("timeline-table").addEventListener("click", function (e) {
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
    input.value = runEdit.rows[ri][CSV_DELAY_COL + 1];
    cell.textContent = "";
    cell.appendChild(input);
    input.focus();
    input.select();
    var finished = false;
    function finish(save) {
      if (finished) return;
      finished = true;
      var seconds = save ? parseDelayInput(input.value) : null;
      if (save && seconds === null) showToast("Enter a whole number of seconds, e.g. 90");
      if (seconds === null) { timelineShown = ""; renderTimeline(); return; }
      setRunDelay(ri, seconds);
    }
    input.addEventListener("keydown", function (ev) {
      if (ev.key === "Enter") finish(true);
      else if (ev.key === "Escape") finish(false);
    });
    input.addEventListener("blur", function () { finish(true); });
  });

  function loadTimeline(name) {
    timelines[name] = "loading";
    api("/api/timeline?name=" + encodeURIComponent(name)).then(function (data) {
      timelines[name] = data.found ? {rows: parseCsv(data.text), config: data.config} : null;
    }).catch(function () { timelines[name] = null; }).then(function () {
      timelineShown = "";
      if (name === selectedRun && runsPane === "timeline") renderTimeline();
    });
  }

  function setRunsPane(pane) {
    runsPane = pane;
    document.querySelectorAll("[data-runs-pane]").forEach(function (b) {
      b.setAttribute("aria-pressed", String(b.getAttribute("data-runs-pane") === pane));
    });
    els.runsLog.hidden = pane !== "output";
    byId("runs-timeline").hidden = pane !== "timeline";
    document.querySelector('.view-pane[data-view="runs"]').setAttribute("data-pane", pane);
    if (pane === "timeline" && selectedRun && !runEdit) delete timelines[selectedRun];  // re-read: it may have been re-saved
    timelineShown = "";
    renderRuns();
  }
  document.querySelectorAll("[data-runs-pane]").forEach(function (b) {
    b.addEventListener("click", function () { setRunsPane(b.getAttribute("data-runs-pane")); });
  });

  function refreshLog() {
    if (!selectedRun) { els.runsLog.textContent = ""; return; }
    var name = selectedRun;
    api("/api/log?name=" + encodeURIComponent(name)).then(function (data) {
      if (name !== selectedRun) return;
      var pre = els.runsLog;
      var atBottom = pre.scrollHeight - pre.scrollTop - pre.clientHeight < 40;
      pre.textContent = data.text || "No output yet. Games run from here write their progress here.";
      if (atBottom) pre.scrollTop = pre.scrollHeight;
    }).catch(function () {});
  }

  function refreshRuns() {
    if (!local) return;
    clearTimeout(runsTimer);
    api("/api/games").then(function (data) {
      runsData = data;
      runsError = null;
      runsFetchedAt = Date.now();
    }).catch(function (err) {
      runsError = err.message;
    }).then(function () {
      renderRuns();
      if (currentView === "runs") refreshLog();
      // Quick while it's being looked at, slow otherwise (just the tab dot).
      var visible = currentView === "runs" && !document.hidden;
      runsTimer = setTimeout(refreshRuns, visible ? 3000 : 20000);
    });
  }

  function runAction(action, name) {
    var requests = {
      run: ["/api/run", {name: name}, "Started " + name + ". You can close this page; it keeps running."],
      stop: ["/api/stop", {name: name}, "Stopping " + name + "…"],
      "stop-after": ["/api/stop-after", {name: name, on: true}, name + " will stop after this session."],
      "keep-going": ["/api/stop-after", {name: name, on: false}, name + " will keep going."],
      dismiss: ["/api/dismiss", {name: name}, null]
    };
    var req = requests[action];
    if (action === "stop" && !confirmTwice("stop:" + name)) { renderRuns(); return; }
    api(req[0], req[1]).then(function (data) {
      showToast(data.stopped && action === "stop-after"
        ? "Stopped " + name + " (it was between sessions)." : req[2] || "Done.");
    }).catch(function (err) {
      showToast(err.message);
    }).then(function () {
      setTimeout(refreshRuns, 400);  // let the run start/stop before re-reading
    });
  }

  els.runsList.addEventListener("click", function (e) {
    var button = e.target.closest("button[data-action]");
    if (button) { runAction(button.getAttribute("data-action"), button.getAttribute("data-name")); return; }
    var card = e.target.closest(".run-card");
    if (card && card.getAttribute("data-name") !== selectedRun) {
      selectedRun = card.getAttribute("data-name");
      els.runsLog.textContent = "";
      renderRuns();
      refreshLog();
    }
  });

  // render() redraws the cards for the "click again" labels too.
  var baseRender = render;
  render = function () { baseRender(); if (local) renderRuns(); };

  document.addEventListener("visibilitychange", function () { if (!document.hidden) refreshRuns(); });

  function enableLocal() {
    local = true;
    byId("screen-switch").hidden = false;
    syncScreenSwitch();
    els.folderBtn.style.display = "none";
    els.folderStatus.style.display = "none";
    byId("hero-note").textContent = "Games keep running when you close this window.";
    byId("hero-install").hidden = true;
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
      if (setupData === null && !setupOpen) setupOpen = setupAutoClose = !(d.asf && d.plugin && d.bot);
      setupData = d;
      renderSetup();
      if (d.busy) setupTimer = setTimeout(refreshSetup, 800);
    }).catch(function () {});
  }

  function renderSetup() {
    var d = setupData;
    if (!d) return;
    var asfDone = d.asf && d.plugin;
    if (d.signed_in) changingAccount = false;
    if (setupOpen && setupAutoClose && asfDone && d.signed_in && !d.busy) {
      setupOpen = setupAutoClose = false;
      showToast("All set. Make a schedule, then run it.");
    }
    var signedIn = d.signed_in || (d.bot && !changingAccount);
    var firstRun = !(asfDone && (d.signed_in || d.bot));
    byId("hero-setup").hidden = !setupOpen;
    byId("hero-actions").hidden = setupOpen && firstRun;
    byId("hero-note").hidden = setupOpen;
    if (!setupOpen) return;
    byId("setup-title").textContent = firstRun ? "Finish setting up" : "Settings";

    var installing = d.busy === "install";
    var asfCurrent = asfDone && !d.outdated;
    byId("step-asf").className = "setup-step" + (installing ? " busy" : asfCurrent ? " done" : "");
    byId("step-asf-text").textContent = installing ? (d.message || "Starting…")
      : asfCurrent ? "Installed: ArchiSteamFarm " + d.asf_version + " with\nASFAchievementManager " +
        d.plugin_version + "."
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
    byId("asf-latest-text").hidden = !asfCurrent || installing || !latest;
    if (latest) {
      byId("asf-latest-text").textContent = latest.error ? latest.error
        : latest.newer ? "ArchiSteamFarm " + latest.asf + " with ASFAchievementManager " + latest.plugin +
          " is out and they work together. Updating waits for any session that's playing."
        : "Up to date: no newer pair that work together.";
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
    byId("setup-error").hidden = !d.error;
    byId("setup-error").textContent = d.error || "";
  }

  // Keep awake & notifications: what this computer has, and how to get
  // what's missing. Shown once setup is done.
  function renderExtras(d) {
    var x = d.extras;
    byId("step-extras").hidden = !x || !(d.asf && d.plugin);
    if (!x) return;
    var awake = x.keep_awake, notes = x.notifications;
    var mac = awake.tool === "caffeinate" || notes.tool === "terminal-notifier" || notes.tool === "osascript";
    byId("step-extras").className = "setup-step" + (d.busy === "notifier" ? " busy"
      : awake.tool && notes.full ? " done" : "");
    byId("awake-text").textContent = awake.tool
      ? "Keep awake: on. While a game runs, " + awake.tool + (mac ? " (built into macOS)" : "") +
        " keeps the computer from sleeping."
      : "Keep awake: not available. systemd-inhibit (part of systemd) isn't here, so the computer may sleep during a run.";
    byId("notify-text").textContent = d.busy === "notifier" ? (d.message || "Installing…")
      : notes.full ? "Notifications: on (" + notes.tool + "). You get one when a session ends, a game is done, or a run stops."
      : notes.tool === "osascript" ? "Notifications: basic. Install terminal-notifier for the logo, the game's name, and ones that clear themselves."
      : "Notifications: off. Install notify-send to get one when a session ends, a game is done, or a run stops.";
    var command = !notes.full && notes.install;
    byId("notify-install").hidden = !command || d.busy === "notifier";
    byId("notify-cmd").textContent = command || "";
    byId("notify-run").hidden = !notes.can_run || !!d.busy;
    byId("notify-test").hidden = !notes.tool || !!d.busy;
  }

  function setupPost(path, body) {
    api(path, body).then(function (d) { setupData = d; renderSetup(); })
      .catch(function (err) { showToast(err.message); })
      .then(function () { setTimeout(refreshSetup, 300); });
  }

  byId("setup-install").addEventListener("click", function () { setupPost("/api/setup/install", {}); });
  byId("asf-check").addEventListener("click", function () {
    byId("asf-check").textContent = "Checking…";
    byId("asf-check").disabled = true;
    setupPost("/api/setup/asf-check", {});
  });
  byId("asf-update-latest").addEventListener("click", function () { setupPost("/api/setup/install", {latest: true}); });
  byId("notify-run").addEventListener("click", function () { setupPost("/api/setup/install-notifier", {}); });
  byId("notify-test").addEventListener("click", function () {
    api("/api/setup/test-notification", {}).then(function () { showToast("Sent. If nothing showed up, check System Settings → Notifications."); })
      .catch(function (err) { showToast(err.message); });
  });
  byId("notify-copy").addEventListener("click", function () {
    var text = byId("notify-cmd").textContent;
    (navigator.clipboard ? navigator.clipboard.writeText(text) : Promise.reject())
      .then(function () { showToast("Copied. Paste it into Terminal."); })
      .catch(function () { showToast("Select the command and copy it."); });
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
    var text = "Steam Auto Unlocker " + u.current + (updateChecked && !u.error ? " is up to date." : "");
    if (u.updating) {
      text = "Updating to " + u.latest + "… The app closes and opens again when it's done.";
    } else if (u.failed && u.available) {
      text = "The last update didn't finish (" + u.failed.replace(/^Error:\s*/, "") + ")";
    } else if (u.available) {
      text = "Version " + u.latest + " is out (you have " + u.current + ")." +
        (u.can_update ? "" : " Update with git pull.");
    } else if (u.error && updateChecked) {
      text = "Steam Auto Unlocker " + u.current + ". " + u.error;
    }
    byId("update-text").textContent = text;
    byId("update-btn").hidden = !u.available || u.updating;
    byId("update-btn").title = u.available ? "Version " + u.latest + " is out" : "";
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

  // In the app, the Guide tab; the public page shows the install steps.
  function showGuide() {
    if (!local) {
      showScreen("home");
      byId("hero-install").hidden = false;
      byId("hero-install").scrollIntoView({block: "center"});
      return;
    }
    setupOpen = true;
    showScreen("guide");
    renderSetup();
    refreshSetup();
  }

  byId("guide-btn").addEventListener("click", showGuide);
  byId("update-btn").addEventListener("click", showGuide);
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
    byId("update-row").scrollIntoView({block: "center"});
    checkUpdates(true);
  };

  // ---- start screen ----
  function showScreen(name) {
    document.body.setAttribute("data-screen", name);
    window.scrollTo(0, 0);
    byId("page").scrollTop = 0;  // in the app, the page scrolls on its own
    // Leaving the Guide tab closes the panel, unless it's first-run setup,
    // which stays on the start screen until it's done.
    if (name !== "guide" && setupOpen && !setupAutoClose) {
      setupOpen = false;
      renderSetup();
    }
    syncScreenSwitch();
  }

  // Schedule / Runs in the top bar (app only).
  function syncScreenSwitch() {
    var work = document.body.getAttribute("data-screen") === "work";
    byId("switch-schedule").classList.toggle("active", work && currentView !== "runs");
    byId("switch-runs").classList.toggle("active", work && currentView === "runs");
    byId("switch-guide").classList.toggle("active", document.body.getAttribute("data-screen") === "guide");
  }
  byId("switch-schedule").addEventListener("click", function () { showScreen("work"); setView(scheduleView); });
  byId("switch-runs").addEventListener("click", function () { showScreen("work"); setView("runs"); });
  byId("switch-guide").addEventListener("click", showGuide);

  byId("hero-new").addEventListener("click", function () { showScreen("work"); setView("input"); });
  byId("hero-run").addEventListener("click", function () {
    if (local) { showScreen("work"); setView("runs"); return; }
    // The public page can't run anything; offer the app instead.
    byId("hero-install").hidden = !byId("hero-install").hidden;
  });
  document.querySelector(".topbar .brand").addEventListener("click", function (e) {
    e.preventDefault();
    showScreen("home");
  });
  byId("copy-install").addEventListener("click", function () {
    var text = byId("install-cmd").textContent;
    (navigator.clipboard ? navigator.clipboard.writeText(text) : Promise.reject())
      .then(function () { showToast("Copied. Paste it into Terminal."); })
      .catch(function () { showToast("Select the line and copy it."); });
  });

  if (/^https?:$/.test(location.protocol)) {
    api("/api/ping").then(function (data) { if (data.app === "steam-unlocker") enableLocal(); }).catch(function () {});
  }

  // ---------------------------------------------------------------
  loadDraft();
  recompute();
  render();
})();
