// Repro for review finding: "`typeof x === \"object\"` guard lets a
// backup/localStorage array become `state.notes`, silently destroying every
// note the user writes afterwards" (webapp/app.js:892/915 in handleRestoreFile,
// and the equivalent guard in loadJSON at webapp/app.js:229-230).
//
// Root cause: `typeof [] === "object"` in JS, so the guard
//   data.notes && typeof data.notes === "object" ? data.notes : {}
// (meant to reject *any* non-plain-object value, per the comment above it)
// happily accepts an Array. The same shape of guard is reused in loadJSON
// for a raw localStorage string. Unlike entries/splitOrder, notes are never
// routed through migrateLegacyOwnerMap, which would have rebuilt them as a
// plain object and closed this hole.
//
// Concrete failure chain exercised below:
//   1. Import a backup `{"entries":{},"notes":[],"splitOrder":{}}`. The
//      array passes the guard, so `state.notes` becomes an Array.
//   2. Long-press a day, type a note, save. `closeNoteDialog` does
//      `state.notes[key] = text`, which succeeds on an Array (it's just an
//      object with a non-index property) - no error, note dot renders fine.
//   3. `saveJSON("notes")` runs `JSON.stringify(state.notes)`. For an Array
//      with only a non-index own property, JSON.stringify serializes *only*
//      index elements, producing the literal string "[]" - the note text is
//      silently dropped from what's persisted to localStorage.
//   4. On reload, `loadJSON` parses "[]" back into an Array and the same
//      `typeof === "object"` guard re-accepts it, so the app is now stuck
//      permanently discarding notes on every future save/reload, with no
//      error and no visible symptom until after the fact.
//
// This test FAILS on current code: after step 4, the note the user typed in
// step 2 is gone from both the DOM (note dialog reopens empty) and
// localStorage["kk.notes"] (still "[]").
//
// It will PASS once both guards reject arrays (e.g. `!Array.isArray(x)`, or
// by rebuilding notes into a fresh plain object the way migrateLegacyOwnerMap
// does for entries/splitOrder), so a restored/stored notes array is
// discarded in favor of `{}` instead of being adopted as `state.notes`.
const { test } = require("@playwright/test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

// A date inside the current month (env "today" is 2026-08-13) so it's
// visible on the initial month view without navigating.
const TARGET_DATE_KEY = "2026-08-15";
const NOTE_TEXT = "Kinderarzt 15 Uhr";

test.use({ serviceWorkers: "block" });

test("an Array restored as the notes field did not cause a subsequently saved note to be silently lost", async ({ page }) => {
  // Auto-accept the native confirm() dialog that handleRestoreFile shows.
  page.on("dialog", (dialog) => dialog.accept());

  await page.goto("/", { waitUntil: "load" });
  // Start from a clean slate so the scenario is deterministic.
  await page.evaluate(() => localStorage.clear());
  await page.reload({ waitUntil: "load" });

  // 1) Import a backup whose `notes` field is an empty Array instead of a
  //    plain object - e.g. hand-edited, or produced by some other tool that
  //    serializes an empty map as `[]`.
  const backup = {
    version: 2,
    entries: {},
    notes: [],
    splitOrder: {},
    settings: {},
  };
  const backupPath = path.join(os.tmpdir(), `kk-array-notes-backup-${Date.now()}.json`);
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

  // 3) Right after saving, in-memory state.notes[TARGET_DATE_KEY] is set (the
  //    write "succeeds" against the Array), so what actually got persisted
  //    is what matters. Reload the page fresh to force everything through
  //    localStorage, simulating the user coming back later.
  await page.reload({ waitUntil: "load" });

  const storedNotesRawAfterReload = await page.evaluate(() => localStorage.getItem("kk.notes"));

  // Re-open the note dialog for the same day and read back what the app
  // thinks the note is now.
  const cellAfterReload = page.locator(`.day-cell[data-date="${TARGET_DATE_KEY}"]`);
  await cellAfterReload.scrollIntoViewIfNeeded();
  const boxAfterReload = await cellAfterReload.boundingBox();
  await page.mouse.move(boxAfterReload.x + boxAfterReload.width / 2, boxAfterReload.y + boxAfterReload.height / 2);
  await page.mouse.down();
  await page.waitForTimeout(650);
  await page.mouse.up();
  const noteInputValueAfterReload = await page.locator("#noteInput").inputValue();
  await page.keyboard.press("Escape").catch(() => {});

  let storedNotesAfterReload;
  try {
    storedNotesAfterReload = JSON.parse(storedNotesRawAfterReload);
  } catch {
    storedNotesAfterReload = storedNotesRawAfterReload;
  }

  assert.ok(
    storedNotesAfterReload &&
      typeof storedNotesAfterReload === "object" &&
      !Array.isArray(storedNotesAfterReload) &&
      storedNotesAfterReload[TARGET_DATE_KEY] === NOTE_TEXT,
    `BUG: after restoring a backup with an Array "notes" field ([]), the note the user typed and saved through the ` +
      `real UI was silently discarded on the next reload instead of being persisted. ` +
      `localStorage["kk.notes"] is ${JSON.stringify(storedNotesRawAfterReload)} ` +
      `(expected an object containing {"${TARGET_DATE_KEY}":"${NOTE_TEXT}"}).`
  );

  assert.strictEqual(
    noteInputValueAfterReload,
    NOTE_TEXT,
    `BUG: after reload, re-opening the note dialog for ${TARGET_DATE_KEY} shows "${noteInputValueAfterReload}" ` +
      `instead of the previously saved note "${NOTE_TEXT}" - the note vanished with no error and no visible symptom.`
  );
});
