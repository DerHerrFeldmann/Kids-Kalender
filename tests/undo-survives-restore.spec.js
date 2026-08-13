// Repro for review finding: "Undo stack survives a backup restore and
// corrupts the restored data" (webapp/app.js, handleRestoreFile ~line 777).
//
// Scenario:
//   1. User taps a day cell (2026-08-12), which pushes an undo record and
//      writes an entry for that date.
//   2. User opens "Einstellungen" -> "Wiederherstellen" and restores a
//      backup file that has a DIFFERENT value for that same date.
//   3. handleRestoreFile replaces state.entries wholesale but never clears
//      `undoStack`.
//   4. User taps "Rückgängig" (undo). It should be a no-op (disabled,
//      stack cleared by the restore) but instead it pops the stale record
//      and overwrites/deletes the just-restored value.
//
// This test FAILS on current code (the restored value gets clobbered by
// the stale undo, and/or the undo button is still enabled after restore)
// and should PASS once the restore handler clears `undoStack` (and keeps
// the undo button disabled).
const { test } = require("@playwright/test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const TARGET_DATE_KEY = "2026-08-12"; // matches env "today", visible on initial month view without navigation

test.use({ serviceWorkers: "block" });

test("undo stack is cleared by restore and cannot corrupt restored data", async ({ page }) => {
  // Auto-accept the native confirm() dialog that handleRestoreFile shows.
  page.on("dialog", (dialog) => dialog.accept());

  await page.goto("/", { waitUntil: "load" });
  // Start from a clean slate so the scenario is deterministic.
  await page.evaluate(() => localStorage.clear());
  await page.reload({ waitUntil: "load" });

  // Sanity check: target date starts with no entry.
  const beforeTap = await page.evaluate(
    (key) => JSON.parse(localStorage.getItem("kk.entries") || "{}")[key],
    TARGET_DATE_KEY
  );
  assert.strictEqual(beforeTap, undefined, "precondition: target date should start empty");

  // 1) Tap the day cell -> pushes an undo record + writes an entry (active brush, default p1).
  const cell = page.locator(`.day-cell[data-date="${TARGET_DATE_KEY}"]`);
  await cell.click();

  const afterTapEntries = await page.evaluate(() => JSON.parse(localStorage.getItem("kk.entries") || "{}"));
  assert.ok(afterTapEntries[TARGET_DATE_KEY], "tap should have written an entry for the target date");

  const undoEnabledAfterTap = await page.evaluate(() => !document.getElementById("undoBtn").disabled);
  assert.strictEqual(undoEnabledAfterTap, true, "undo should be enabled right after the tap");

  // 2) Restore a backup that has a DIFFERENT value for the same date.
  const backup = {
    entries: { [TARGET_DATE_KEY]: "p2" },
    notes: {},
    splitOrder: {},
    settings: {},
  };
  const backupPath = path.join(os.tmpdir(), `kk-backup-${Date.now()}.json`);
  fs.writeFileSync(backupPath, JSON.stringify(backup));

  await page.locator("#settingsBtn").click();
  await page.locator("#restoreBtn").click();
  await page.locator("#restoreInput").setInputFiles(backupPath);

  // handleRestoreFile reads the file asynchronously (FileReader) and shows
  // a confirm() dialog before applying it; wait until the restore has
  // actually landed in localStorage rather than racing it.
  await page.waitForFunction(
    (key) => {
      const entries = JSON.parse(localStorage.getItem("kk.entries") || "{}");
      return entries[key] === "p2";
    },
    TARGET_DATE_KEY,
    { timeout: 5000 }
  );

  // Restore should have applied (dialog auto-accepted above).
  const afterRestoreEntries = await page.evaluate(() => JSON.parse(localStorage.getItem("kk.entries") || "{}"));
  assert.strictEqual(
    afterRestoreEntries[TARGET_DATE_KEY],
    "p2",
    "restore should have applied the backup's value for the target date"
  );

  // 3) The undo button must now be disabled (undo stack must have been
  //    cleared by the restore) - this is the crux of the bug.
  const undoDisabledAfterRestore = await page.evaluate(() => document.getElementById("undoBtn").disabled);
  assert.strictEqual(
    undoDisabledAfterRestore,
    true,
    "BUG: undo button is still enabled after a restore, even though the pre-restore undo record no longer applies to the restored data"
  );

  // 4) Belt-and-suspenders: even if something still calls the undo logic
  //    directly, it must not resurrect pre-restore data. Force-invoke it
  //    the same way the button's click handler would.
  await page.evaluate(() => undoLastAction());
  const afterUndoEntries = await page.evaluate(() => JSON.parse(localStorage.getItem("kk.entries") || "{}"));
  assert.strictEqual(
    afterUndoEntries[TARGET_DATE_KEY],
    "p2",
    "BUG: undo after a restore overwrote/deleted the freshly restored value using a stale pre-restore undo record"
  );

  fs.unlinkSync(backupPath);
});
