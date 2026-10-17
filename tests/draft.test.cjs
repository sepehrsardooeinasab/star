const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { test } = require("node:test");

const source = fs.readFileSync(path.join(__dirname, "../docs/script.js"), "utf8");
// Run the app's actual storage functions and native close callback without
// starting its network polling or requiring a desktop webview: the code
// between script.js's ">>> draft storage" and "<<< draft storage" markers.
function between(start, end) {
  const from = source.indexOf(start), to = source.indexOf(end);
  assert.ok(from >= 0 && to > from, `docs/script.js needs its "${start}" and "${end}" markers, in that order`);
  return source.slice(from + start.length, to);
}
const storageFunctions = between("// >>> draft storage", "// <<< draft storage");
const closeCallback = (source.match(/window\.starWindowClosed = function \(\) \{[\s\S]*?\n  \};/) ||
  assert.fail("docs/script.js no longer defines window.starWindowClosed"))[0];

test("closing the window preserves edits and restores the schedule on the next launch", () => {
  const values = new Map();
  const store = {
    setItem: (key, value) => values.set(key, value),
    getItem: key => values.get(key) || null,
    removeItem: key => values.delete(key),
  };
  function page() {
    const fields = ["exportText", "appid", "gameName", "copiedFrom", "gapLimit", "cumLimit", "minGap"];
    const context = vm.createContext({
      window: {}, draftStore: store,
      els: Object.fromEntries(fields.map(key => [key, { value: "" }])),
      edits: {}, breaks: {}, currentView: "runs",
      runEdit: { name: "review", config: { delay: 120 } },
      resetAll: () => assert.fail("closing the window must not reset the draft"),
      setView: () => assert.fail("closing the window must not change the screen"),
    });
    vm.runInContext(storageFunctions + "\n" + closeCallback, context);
    return context;
  }

  const before = page();
  const expected = {
    exportText: "copied achievement page", appid: "730", gameName: "Review",
    copiedFrom: "player", gapLimit: "3", cumLimit: "6", minGap: "0",
    edits: { 1: 120 }, breaks: { 2: true },
  };
  for (const [key, value] of Object.entries(expected)) {
    if (key in before.els) before.els[key].value = value;
    else before[key] = value;
  }
  const timelineEdit = before.runEdit;
  before.window.starWindowClosed();
  assert.equal(before.runEdit, timelineEdit);
  assert.equal(before.currentView, "runs");
  assert.deepEqual(JSON.parse(values.get("unlock-scheduler-draft")), expected);

  const reopened = page();
  vm.runInContext("loadDraft()", reopened);
  for (const [key, value] of Object.entries(expected)) {
    const actual = key in reopened.els ? reopened.els[key].value : reopened[key];
    assert.equal(JSON.stringify(actual), JSON.stringify(value), key);
  }
});
