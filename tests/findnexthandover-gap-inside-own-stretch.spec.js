// Regression test for: findNextHandover() advances `prevOwner` on *every*
// day, including unfilled ("none") days, instead of only on days that have
// a known owner. That means an unfilled gap that sits *inside* one parent's
// own stretch (e.g. the user only ever marks their own days and leaves the
// other days blank) gets treated as if it were a real handover, because the
// first filled day after the gap is compared against "none" rather than
// against the last *known* owner.
//
// This directly contradicts the function's own doc comment: "a run of
// unfilled days ahead just means nobody's scheduled it yet (not a real
// switch)".
//
// Failure scenario mirrored here: Papa (p1) marks only Mon/Wed/Fri and never
// marks Mama (p2) at all, leaving Tue/Thu blank. Today is Monday, and Papa
// already has the children today. Because the gap on Tuesday resets
// `prevOwner` to "none", Wednesday's owner (p1) is compared against "none"
// instead of against Monday's p1, so the buggy code reports a bogus
// "handover to Papa" on Wednesday -- even though Papa already has the kids
// and there's no p2 anywhere in the schedule at all.
//
// Correct behavior: since only p1 ever appears, there is no real handover
// within the horizon, so findNextHandover() must return null.
//
// This test extracts the live source of dateKey/addDays/ownerAt/
// findNextHandover straight out of app.js (so it exercises the real
// implementation, not a re-derived copy), so it will fail against the
// current buggy code and pass once `prevOwner` is only advanced on days
// with a known owner.

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

test("findNextHandover does not report a handover for an unfilled gap inside one parent's own stretch", () => {
  const { state, dateKey, findNextHandover } = loadHandoverLogic();

  const monday = new Date(2026, 7, 10); // today: Papa (p1)
  const tuesday = new Date(2026, 7, 11); // unfilled gap
  const wednesday = new Date(2026, 7, 12); // Papa (p1) again
  const thursday = new Date(2026, 7, 13); // unfilled gap
  const friday = new Date(2026, 7, 14); // Papa (p1) again

  state.entries[dateKey(monday)] = "p1";
  // Tuesday intentionally left unfilled ("none").
  state.entries[dateKey(wednesday)] = "p1";
  // Thursday intentionally left unfilled ("none").
  state.entries[dateKey(friday)] = "p1";
  // Mama (p2) never appears anywhere in the schedule.

  const handover = findNextHandover(monday);

  assert.strictEqual(
    handover,
    null,
    "expected findNextHandover to find no handover (p1 holds every filled day, p2 never appears), " +
      `but got ${JSON.stringify(handover)} instead -- the buggy code resets prevOwner to "none" on the ` +
      "unfilled Tuesday gap, then reports a bogus handover on Wednesday from \"none\" to p1, even though " +
      "p1 already had the children on Monday and nothing actually changed"
  );
});
