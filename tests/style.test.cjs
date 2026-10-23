const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { test } = require("node:test");

// The stylesheet's text sizes and corners come from one scale, the tokens in
// :root (--fs-*, --radius-*). A raw value in a rule is a size the app
// doesn't otherwise use, so a new one fails here; use the nearest token.
const css = fs.readFileSync(path.join(__dirname, "../docs/style.css"), "utf8")
  .replace(/\/\*[\s\S]*?\*\//g, comment => comment.replace(/[^\n]/g, " "));

// Raw values that are shapes or glyphs, not part of the scale: circles,
// pills, small inner corners, sizes relative to the text around (em), and a
// few large glyphs.
const ALLOWED = {
  "font-size": [/^inherit$/, /^[\d.]+em$/, /^clamp\(/, /^2rem$/, /^1\.3rem$/],
  "border-radius": [/^0$/, /^50%$/, /^999px$/, /^[2-5]px$/],
};

function rawValues(prop) {
  const found = [];
  const re = new RegExp(`(?<![-\\w])${prop}\\s*:\\s*([^;}]+)`, "g");
  for (const m of css.matchAll(re)) {
    const value = m[1].trim();
    const line = css.slice(0, m.index).split("\n").length;
    const inRoot = /--[\w-]+\s*:\s*$/.test(css.slice(css.lastIndexOf("\n", m.index), m.index));
    if (!value.includes("var(") && !inRoot) found.push({ value, line });
  }
  return found;
}

for (const [prop, allowed] of Object.entries(ALLOWED)) {
  test(`${prop} uses the tokens in docs/style.css`, () => {
    const stray = rawValues(prop).filter(({ value }) => !allowed.some(re => re.test(value)));
    assert.deepEqual(stray.map(({ value, line }) => `line ${line}: ${prop}: ${value}`), [],
      `use a var(--${prop === "font-size" ? "fs" : "radius"}-…) token from :root instead`);
  });
}

test("the tokens are defined", () => {
  for (const token of ["--fs-tiny", "--fs-caption", "--fs-small", "--fs-body", "--fs-title",
                       "--radius-control", "--radius-card", "--radius-panel",
                       "--space-s", "--space-m", "--space-l", "--control-h", "--label-col"]) {
    assert.match(css, new RegExp(`${token}\\s*:`), `${token} is missing from :root`);
  }
});
