// Repro for review finding: "loadState runs the p1/p2 owner migration over
// the notes map" (webapp/app.js, loadState ~line 258-262).
//
// Two independent bugs are exercised here:
//
// Bug A - notes get silently rewritten:
//   `JSON_FIELDS` only has entries/notes/splitOrder (no "settings" entry), so
//   the `stateKey === "settings"` branch in loadState() is dead code and
//   *every* loaded map - including free-form user notes - is passed through
//   migrateLegacyOwnerMap(), which rewrites string values "mine" -> "p1" and
//   "ex" -> "p2". A user who long-presses a day and types the note "ex" (a
//   perfectly reasonable note, e.g. short for a name) will see it silently
//   turned into "p2" after the next reload.
//
// Bug B - a literal-string "null" value in one JSON field crashes init():
//   loadJSON() does `raw ? JSON.parse(raw) : fallback`. If a key's stored
//   value is the *string* "null" (non-empty, so truthy), JSON.parse returns
//   the actual `null` (not the object fallback). migrateLegacyOwnerMap(null)
//   then does `Object.entries(null)`, which throws, aborting loadState() -
//   and therefore init() - before render() ever runs. The calendar grid
//   stays empty, contradicting the comment at app.js:213-214 that a corrupt
//   value in one key can't affect the others.
//
// This test FAILS on current code:
//   - Bug A: the reloaded note reads "p2" instead of the user's own "ex".
//   - Bug B: #dayGrid has zero .day-cell children after reload (blank
//     screen) and/or a pageerror is emitted.
// It PASSES once loadState() (1) only migrates owner-like fields (entries/
// splitOrder), not notes, and (2) tolerates a literal "null" JSON value in
// any one field without throwing.

const { test } = require("@playwright/test");
const assert = require("node:assert");

const TARGET_DATE_KEY = "2026-08-12"; // matches env "today", visible on initial month view without navigation

test.use({ serviceWorkers: "block" });

test('notes are not owner-migrated and a literal "null" field value can\'t crash loadState()', async ({ page }) => {
  const pageErrors = [];
  page.on("pageerror", (err) => pageErrors.push(err.message));

  await page.goto("/", { waitUntil: "load" });
  await page.evaluate(() => localStorage.clear());

  // ---- Bug A setup: a user note whose text happens to be "ex" ----
  await page.evaluate(
    (key) => localStorage.setItem("kk.notes", JSON.stringify({ [key]: "ex" })),
    TARGET_DATE_KEY
  );

  await page.reload({ waitUntil: "load" });

  const noteAfterReload = await page.evaluate((key) => state.notes[key], TARGET_DATE_KEY);
  assert.strictEqual(
    noteAfterReload,
    "ex",
    `BUG A: user's free-text note "ex" was rewritten to "${noteAfterReload}" by the owner migration, ` +
      "which should only ever touch entries/splitOrder, not notes"
  );

  // ---- Bug B setup: one JSON field literally holds the string "null" ----
  await page.evaluate(() => {
    localStorage.clear();
    localStorage.setItem("kk.entries", "null");
  });

  pageErrors.length = 0;
  await page.reload({ waitUntil: "load" });

  const cellCount = await page.evaluate(() => document.querySelectorAll("#dayGrid .day-cell").length);
  assert.ok(
    cellCount > 0,
    `BUG B: a literal "null" value for kk.entries crashed init() before render() ran, ` +
      `leaving #dayGrid with ${cellCount} .day-cell elements (blank screen). ` +
      `Page errors: ${JSON.stringify(pageErrors)}`
  );
  assert.deepStrictEqual(
    pageErrors,
    [],
    `BUG B: reload with kk.entries = "null" raised uncaught error(s): ${JSON.stringify(pageErrors)}`
  );
});
