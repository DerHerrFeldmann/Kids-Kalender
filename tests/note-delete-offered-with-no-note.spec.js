// Repro for review finding: "'Notiz löschen' is always offered — even on
// days with no note — and confirms a deletion of nothing" (index.html line
// 158, #noteDeleteBtn inside #noteDialog; state from app.js
// openNoteDialog() lines 971-980, confirm handler in init() lines
// 1573-1577, effect in closeNoteDialog() lines 982-997).
//
// Root cause: openNoteDialog() populates #noteInput from state.notes but
// never touches #noteDeleteBtn's visibility, so the button (and its full
// red "danger" styling) is unconditionally present in the dialog markup.
// Long-pressing a day that has never had a note opens the dialog with an
// empty input and a fully visible, clickable "Notiz löschen" button.
// Clicking it fires window.confirm("Notiz wirklich löschen?") and then
// closeNoteDialog() runs `delete state.notes[key]` on a key that was never
// set — a real, functioning confirm dialog for a deletion that deletes
// nothing. That both erodes trust in the confirm prompt (it "fires" but
// there was never anything to lose) and wastes the primary red visual
// weight in the most common case: creating a brand-new note.
//
// Scenario: seed one day with a note and leave a second day untouched.
// Long-press the day *without* a note and assert the delete button is not
// offered at all. As a sanity check that the fix doesn't just hide the
// button unconditionally, also long-press the day *with* a note and assert
// the delete button is offered there.
//
// Expected (once fixed): #noteDeleteBtn is hidden when the opened day has
// no note, and visible when it does.
// Actual (current code): #noteDeleteBtn is visible regardless of whether
// the day has a note, so the "no note" assertion fails.
const { test, expect } = require("@playwright/test");
const assert = require("node:assert");

// The app registers a service worker whose controllerchange handler
// triggers a page reload on a fresh/incognito context; that's irrelevant to
// this test but can race with the interactions below, so block it entirely.
test.use({ serviceWorkers: "block" });

test("note-less day does not offer 'Notiz löschen', noted day does", async ({ page }) => {
  const pageErrors = [];
  page.on("pageerror", (err) => pageErrors.push(err.message));

  await page.goto("/index.html");
  await page.evaluate(() => localStorage.clear());
  await page.reload();
  await page.waitForSelector("#paintModeBtn", { state: "visible" });

  const cells = page.locator(".day-cell[data-date]");
  const cellCount = await cells.count();
  assert.ok(cellCount >= 2, `expected at least 2 day cells, found ${cellCount}`);

  const notedCell = cells.nth(0);
  const noteLessCell = cells.nth(1);
  const notedKey = await notedCell.getAttribute("data-date");
  const noteLessKey = await noteLessCell.getAttribute("data-date");
  assert.notStrictEqual(notedKey, noteLessKey, "precondition: need two distinct days");

  const longPress = async (cellHandle) => {
    // The grid is rebuilt (innerHTML wiped and repopulated) every time
    // closeNoteDialog() -> render() runs, including on a plain cancel. That
    // rebuild is async relative to the "close" event we just waited on, so
    // querying boundingBox() immediately after can land in the brief window
    // where the previous cell nodes have been removed but the new ones
    // aren't attached yet. Wait for the cell to be genuinely visible again
    // first so this doesn't flake.
    await cellHandle.waitFor({ state: "visible", timeout: 5000 });
    const box = await cellHandle.boundingBox();
    const cx = box.x + box.width / 2;
    const cy = box.y + box.height / 2;
    await page.mouse.move(cx, cy);
    await page.mouse.down();
    // Poll instead of a single fixed sleep so this doesn't flake under a
    // slow/loaded dev server: keep waiting (well past the 500ms long-press
    // threshold) until the dialog actually reports open.
    await page.waitForFunction(() => document.getElementById("noteDialog").open, null, {
      timeout: 5000,
      polling: 50,
    });
    await page.mouse.up();
  };

  // Seed a note on the first day through the dialog's own long-press ->
  // type -> Speichern flow, exactly like a real user would.
  await longPress(notedCell);
  await page.fill("#noteInput", "Kinderarzt 15 Uhr");
  await page.click("#noteDialog button[value='save']");
  // Wait on the actual persisted side effect rather than dialog.open: the
  // native <dialog> sets .open = false synchronously on close(), but fires
  // the "close" event (which runs closeNoteDialog()/saveJSON()) as a
  // separately queued task, so polling .open alone can race ahead of the
  // save actually landing in localStorage.
  await page.waitForFunction(
    (key) => {
      const raw = localStorage.getItem("kk.notes");
      return raw !== null && JSON.parse(raw)[key] !== undefined;
    },
    notedKey,
    { timeout: 5000 }
  );

  // Sanity check the seed actually landed, and that the second day is
  // genuinely note-less before we assert anything about it.
  const notesAfterSeed = await page.evaluate(() => JSON.parse(localStorage.getItem("kk.notes") || "{}"));
  assert.strictEqual(
    notesAfterSeed[notedKey],
    "Kinderarzt 15 Uhr",
    "precondition failed: seeding the note through the dialog's own Speichern flow didn't persist it"
  );
  assert.strictEqual(
    notesAfterSeed[noteLessKey],
    undefined,
    "precondition failed: the second day already has a note, it must stay note-less"
  );

  // Reopen the noted day: the delete button must be offered here.
  await longPress(notedCell);
  await expect(
    page.locator("#noteDeleteBtn"),
    "the day with an existing note should still offer 'Notiz löschen'"
  ).toBeVisible();
  await page.click("#noteDialog button[value='cancel']");
  await page.waitForFunction(() => !document.getElementById("noteDialog").open, null, { timeout: 5000 });

  // Open the note-less day: the delete button must NOT be offered, since
  // there is nothing to delete and confirming its removal is meaningless.
  await longPress(noteLessCell);
  const noteInputValue = await page.inputValue("#noteInput");
  assert.strictEqual(noteInputValue, "", "precondition failed: the note-less day's input should start empty");

  const deleteBtn = page.locator("#noteDeleteBtn");
  const isHiddenAttr = await deleteBtn.evaluate((el) => el.hidden);
  assert.strictEqual(
    isHiddenAttr,
    true,
    "expected 'Notiz löschen' to be hidden on a day with no note (nothing exists to delete), " +
      "but the button is present and unhidden — offering, and letting the user confirm, a " +
      "deletion of a note that was never created"
  );
  await expect(
    deleteBtn,
    "'Notiz löschen' must not be visible on a day with no note"
  ).toBeHidden();

  assert.deepStrictEqual(pageErrors, [], `Unexpected page errors: ${pageErrors.join(", ")}`);
});
