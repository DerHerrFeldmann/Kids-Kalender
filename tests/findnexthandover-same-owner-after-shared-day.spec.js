// Regression test for: findNextHandover compares against today's owner
// instead of the previous day's, so a transition back to the current
// parent (after a shared/"both" or unfilled day) is never announced.
//
// Bug: app.js's findNextHandover() keeps `fromOwner = ownerAt(today)` fixed
// for the whole scan and skips any candidate day whose owner equals it.
// That means a "both" -> p1 handover the day after today, where today's
// owner already happens to be p1, gets silently skipped, and the function
// reports the *next* real handover far in the future instead.
//
// This test extracts the live source of dateKey/addDays/ownerAt/
// findNextHandover straight out of app.js (so it exercises the real
// implementation, not a re-derived copy) and runs it against a small,
// fixed calendar:
//
//   today (day 0): p1
//   day 1:         both   (shared day)
//   day 2:         p1     (Fr) <- should be reported: this is the moment
//                                 someone "takes over" from the shared day
//   day 14:        p2
//
// Correct behavior (per the function's own doc comment: "a move *out of*
// 'both' ... into a single person does count") is to report day 2 as the
// next handover (both -> p1). The current buggy implementation instead
// skips day 2 (because its owner, p1, equals today's owner) and reports
// day 14 (p1 -> p2) instead.

const { test } = require("@playwright/test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

const APP_JS_PATH = path.join(__dirname, "..", "app.js");

// Pulls "function <name>(...) { ... }" out of the source by brace-matching,
// so the test always runs against whatever the current implementation is
// (including after the bug is fixed), not a hand-copied snapshot of it.
function extractFunction(source, name) {
  const marker = `function ${name}(`;
  const start = source.indexOf(marker);
  assert.ok(start !== -1, `could not find "${marker}" in app.js`);
  const braceStart = source.indexOf("{", start);
  assert.ok(braceStart !== -1, `could not find opening brace for ${name}`);
  let depth = 0;
  let end = braceStart;
  for (; end < source.length; end++) {
    if (source[end] === "{") depth++;
    else if (source[end] === "}") {
      depth--;
      if (depth === 0) {
        end++;
        break;
      }
    }
  }
  return source.slice(start, end);
}

function extractConst(source, name) {
  const re = new RegExp(`const ${name}\\s*=\\s*[^;\\n]+`);
  const match = source.match(re);
  assert.ok(match, `could not find "const ${name} = ..." in app.js`);
  return match[0];
}

function loadHandoverLogic() {
  const source = fs.readFileSync(APP_JS_PATH, "utf8");

  const snippet = [
    "const state = { entries: {} };",
    extractConst(source, "HANDOVER_HORIZON_DAYS"),
    extractFunction(source, "dateKey"),
    extractFunction(source, "addDays"),
    extractFunction(source, "ownerAt"),
    extractFunction(source, "findNextHandover"),
    "module.exports = { state, dateKey, findNextHandover };",
  ].join("\n\n");

  const Module = require("node:module");
  const m = new Module(APP_JS_PATH);
  m._compile(snippet, APP_JS_PATH);
  return m.exports;
}

test("findNextHandover reports a both->p1 handover the day after a shared day, even though p1 is also today's owner", () => {
  const { state, dateKey, findNextHandover } = loadHandoverLogic();

  const today = new Date(2026, 0, 7); // arbitrary fixed reference date
  const day1 = new Date(2026, 0, 8); // today + 1: shared day
  const day2 = new Date(2026, 0, 9); // today + 2: takeover back to p1
  const day14 = new Date(2026, 0, 21); // today + 14: next real p1 -> p2 handover

  state.entries[dateKey(today)] = "p1";
  state.entries[dateKey(day1)] = "both";
  state.entries[dateKey(day2)] = "p1";
  state.entries[dateKey(day14)] = "p2";

  const handover = findNextHandover(today);

  assert.ok(handover, "expected findNextHandover to find a handover, got null");
  assert.strictEqual(
    dateKey(handover.date),
    dateKey(day2),
    `expected the reported handover to be on ${dateKey(day2)} (the both->p1 takeover the day after the shared day), ` +
      `but got ${dateKey(handover.date)} instead (current buggy code skips day2 because its owner equals today's fixed fromOwner, ` +
      `and instead reports the later p1->p2 handover on day 14)`
  );
  assert.strictEqual(handover.toOwner, "p1");
});
