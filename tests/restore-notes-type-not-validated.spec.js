// Repro for review finding: "Restored `notes` is not type-checked; a
// non-object value silently discards every note the user writes"
// (webapp/app.js, handleRestoreFile ~line 866: `state.notes = data.notes || {}`).
//
// Scenario:
//   1. handleRestoreFile only checks `typeof data.entries === "object"`
//      (line 858) before accepting a backup file. `data.notes` is never
//      validated - `state.notes = data.notes || {}` accepts *any* truthy
//      value, e.g. the number 42.
//   2. After importing a backup with `{"entries":{},"notes":42}`,
//      state.notes becomes the primitive number 42.
//   3. app.js is a classic script with no "use strict", so the later
//      write `state.notes[key] = text` in closeNoteDialog is a silent
//      no-op on a primitive - no error, and the value is simply dropped.
//   4. saveJSON("notes") then persists `JSON.stringify(state.notes)`,
//      i.e. the string "42", into localStorage under "kk.notes" -
//      overwriting/discarding whatever note the user just typed.
//
// This test FAILS on current code: after restoring a poisoned backup and
// then saving a note through the real UI (long-press a day -> type text ->
// click "Speichern"), localStorage["kk.notes"] still reads "42" - the
// user's note silently vanished with no error shown anywhere.
//
// It will PASS once handleRestoreFile validates `data.notes` as a plain
// object (and coerces values to strings) before assigning it into state,
// so that a corrupt/malicious `notes` field is dropped/sanitized instead
// of clobbering the notes map with a non-object.
const { test } = require("@playwright/test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

// A date inside the current month (env "today" is 2026-08-12) so it's
// visible on the initial month view without navigating.
const TARGET_DATE_KEY = "2026-08-15";
const NOTE_TEXT = "Kinderarzt 15 Uhr";

test.use({ serviceWorkers: "block" });

test("a non-object restored notes field did not cause a subsequently saved note to be silently lost", async ({ page }) => {
  // Auto-accept the native confirm() dialog that handleRestoreFile shows.
  page.on("dialog", (dialog) => dialog.accept());

  await page.goto("/", { waitUntil: "load" });
  // Start from a clean slate so the scenario is deterministic.
  await page.evaluate(() => localStorage.clear());
  await page.reload({ waitUntil: "load" });

  // 1) Import a backup whose `notes` field is a bare number instead of an
  //    object - a corrupt/malicious backup file.
  const backup = {
    version: 2,
    entries: {},
    notes: 42,
    splitOrder: {},
    settings: {},
  };
  const backupPath = path.join(os.tmpdir(), `kk-poisoned-notes-backup-${Date.now()}.json`);
  fs.writeFileSync(backupPath, JSON.stringify(backup));

  await page.locator("#settingsBtn").click();
  await page.locator("#restoreBtn").click();
  await page.locator("#restoreInput").setInputFiles(backupPath);
  fs.unlinkSync(backupPath);

  // Wait for the restore to actually apply.
  await page.waitForFunction(() => localStorage.getItem("kk.entries") !== null, { timeout: 5000 });

  // Settings dialog stays open after restore in this app's flow; close it
  // so the day grid is interactable again.
  await page.keyboard.press("Escape").catch(() => {});
  await page.waitForTimeout(100);

  // 2) Now do exactly what a real user does to save a note: long-press a
  //    day cell (>= 500ms opens the note dialog), type text, and click
  //    "Speichern".
  const cell = page.locator(`.day-cell[data-date="${TARGET_DATE_KEY}"]`);
  await cell.scrollIntoViewIfNeeded();
  const box = await cell.boundingBox();
  assert.ok(box, `precondition: target day cell ${TARGET_DATE_KEY} should be visible in the current month view`);

  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.waitForTimeout(650); // longer than the 500ms long-press threshold
  await page.mouse.up();

  const noteDialogOpen = await page.locator("#noteDialog").evaluate((dlg) => dlg.open);
  assert.ok(noteDialogOpen, "precondition: long-press should open the note dialog");

  await page.fill("#noteInput", NOTE_TEXT);
  await page.locator('#noteDialog button[value="save"]').click();

  await page.waitForTimeout(100);

  // 3) The note the user just typed should now be persisted.
  const storedNotesRaw = await page.evaluate(() => localStorage.getItem("kk.notes"));

  let storedNotes;
  try {
    storedNotes = JSON.parse(storedNotesRaw);
  } catch {
    storedNotes = storedNotesRaw;
  }

  assert.ok(
    storedNotes && typeof storedNotes === "object" && storedNotes[TARGET_DATE_KEY] === NOTE_TEXT,
    `BUG: after restoring a backup with a non-object "notes" field (42), the note the user just typed and saved ` +
      `through the real UI was silently discarded instead of being persisted. localStorage["kk.notes"] is ` +
      `${JSON.stringify(storedNotesRaw)} (expected an object containing {"${TARGET_DATE_KEY}":"${NOTE_TEXT}"}).`
  );
});
