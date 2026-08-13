// Repro for review finding: "Malicious/corrupt backup file permanently
// bricks the app (unvalidated owner value reaches classList.add)"
// (webapp/app.js, handleRestoreFile ~line 777 / applyOwnerVisual ~line 362).
//
// Scenario:
//   1. handleRestoreFile only checks `typeof data.entries === "object"` -
//      the map's *values* are never validated against the allowed set
//      ("p1"/"p2"/"both"). migrateLegacyOwnerMap passes any unknown string
//      through unchanged, so an arbitrary string lands in state.entries.
//   2. That value flows to applyOwnerVisual -> `cell.classList.add(owner)`.
//      DOMTokenList.add throws InvalidCharacterError for any token
//      containing ASCII whitespace, e.g. "p1 evil".
//   3. handleRestoreFile calls saveJSON("entries") (persisting the poisoned
//      map to localStorage) BEFORE calling render(), so the bad value
//      survives even though render() then throws.
//   4. Every subsequent launch: loadState() reads the poisoned value back
//      unchanged, and init() -> render() throws again, before any
//      addEventListener in init() runs. The app looks alive (static
//      header/footer) but the day grid is empty and no button works
//      (e.g. settingsBtn's click listener was never attached).
//
// This test FAILS on current code:
//   - importing the poisoned backup throws an uncaught exception, AND
//   - after that, even a page reload leaves the app permanently broken
//     (empty day grid, Settings button unresponsive) with no recovery
//     path other than wiping localStorage (which destroys the calendar).
//
// It will PASS once the fix validates owner values on import (and/or on
// load, and/or guards applyOwnerVisual), so the poisoned value is dropped
// or sanitized instead of crashing render()/init().
const { test } = require("@playwright/test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

// A date inside the current month (env "today" is 2026-08-12) so it's
// visible on the initial month view without navigating.
const TARGET_DATE_KEY = "2026-08-15";
const POISONED_OWNER = "p1 evil"; // any string containing a space breaks DOMTokenList.add

test.use({ serviceWorkers: "block" });

test("an unvalidated owner value in a restored backup did not crash render()/init() or brick the app", async ({ page }) => {
  const pageErrors = [];
  page.on("pageerror", (err) => pageErrors.push(err));

  // Auto-accept the native confirm() dialog that handleRestoreFile shows.
  page.on("dialog", (dialog) => dialog.accept());

  await page.goto("/", { waitUntil: "load" });
  // Start from a clean slate so the scenario is deterministic.
  await page.evaluate(() => localStorage.clear());
  await page.reload({ waitUntil: "load" });

  // Precondition: the day grid renders normally with real day cells.
  const cellCountBefore = await page.locator(".day-cell").count();
  assert.ok(cellCountBefore > 20, "precondition: day grid should render normal cells before the attack");

  // 1) Import a backup with a malicious/corrupt owner value for one date.
  const backup = {
    version: 2,
    entries: { [TARGET_DATE_KEY]: POISONED_OWNER },
    notes: {},
    splitOrder: {},
    settings: {},
  };
  const backupPath = path.join(os.tmpdir(), `kk-poisoned-backup-${Date.now()}.json`);
  fs.writeFileSync(backupPath, JSON.stringify(backup));

  await page.locator("#settingsBtn").click();
  await page.locator("#restoreBtn").click();
  await page.locator("#restoreInput").setInputFiles(backupPath);

  // handleRestoreFile writes state.entries to localStorage as part of the
  // restore (on current buggy code, BEFORE render() runs and crashes) -
  // wait for that write rather than racing it. Deliberately fix-agnostic:
  // a correct fix may sanitize/drop the poisoned value, so this only
  // checks that the restore ran at all, not what ended up in the map.
  await page.waitForFunction(() => localStorage.getItem("kk.entries") !== null, { timeout: 5000 });

  // Give the (expected, on current unfixed code) uncaught exception a tick to surface.
  await page.waitForTimeout(200);

  // 2) Reload - this simulates the user's *next app launch*. On current
  //    code, loadState() reads the poisoned value back unchanged and
  //    init() -> render() throws again, before any addEventListener runs.
  await page.reload({ waitUntil: "load" });
  await page.waitForTimeout(200);

  const cellCountAfter = await page.locator(".day-cell").count();

  // Try to open Settings the way a real user would, to check whether
  // init()'s addEventListener calls ever ran. On current code, render()
  // (called synchronously from init(), before any addEventListener) throws
  // while building the poisoned cell, so init() aborts and settingsBtn's
  // click listener is never attached - the button becomes permanently
  // unresponsive, with no way back into Settings -> "Wiederherstellen".
  await page.locator("#settingsBtn").click({ force: true }).catch(() => {});
  await page.waitForTimeout(100);
  const settingsOpenedAfterClick = await page.locator("#settingsDialog").evaluate((dlg) => dlg.open);

  fs.unlinkSync(backupPath);

  assert.strictEqual(
    settingsOpenedAfterClick,
    true,
    `BUG: a corrupt/malicious owner value permanently bricked the app after reload - ` +
      `clicking the Settings button no longer opens the dialog (init()'s addEventListener calls never ran ` +
      `because render() threw first), so there is no way back into "Wiederherstellen" to import a good backup. ` +
      `(day cells rendered: ${cellCountAfter}/full month, uncaught page errors seen: ` +
      `${pageErrors.map((e) => e.message).join(" | ") || "none"})`
  );
});
