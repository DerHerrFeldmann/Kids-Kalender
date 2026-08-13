// Repro for review finding: "Notiz-Dialog hat keinen Abbrechen-Weg und
// löscht ohne Rückfrage" (index.html around line 144, noteDialog form).
//
// Root cause: the note dialog's <form method="dialog"> only contains two
// <button type="submit"> elements — value="save" ("Speichern") and
// value="delete" ("Löschen"). There is no third, visually neutral
// cancel/close control (no "Abbrechen" button, no close "X"), and the
// dialog has no backdrop-click handler either. A user who long-presses a
// day by accident, or who just opened the dialog to re-read an existing
// note, has no way to back out without either persisting an edit or
// instantly deleting the note — and on an installed iOS PWA without a
// hardware keyboard, Escape isn't a realistic fallback either.
//
// Scenario: a note already exists for a day (so the user has something to
// lose). The dialog is reopened via the same long-press gesture a real user
// would trigger, exactly to "just look" at the note. We then look for any
// button inside the dialog that is neither the destructive "Löschen" nor
// the committing "Speichern" action — i.e. a neutral way to close the
// dialog while leaving the note untouched — and, if found, verify that
// clicking it actually closes the dialog without touching the note.
//
// Expected (once fixed): a neutral cancel/close button exists in the
// dialog; clicking it closes the dialog and leaves the existing note
// exactly as it was.
// Actual (current code): no such button exists at all, so the test fails
// before it can even click anything.
const { test } = require("@playwright/test");
const assert = require("node:assert");

// The app registers a service worker whose controllerchange handler
// triggers a page reload on a fresh/incognito context; that's irrelevant to
// this test but can race with the interactions below, so block it entirely.
test.use({ serviceWorkers: "block" });

test("note dialog offers a neutral cancel path that doesn't touch the note", async ({ page }) => {
  const pageErrors = [];
  page.on("pageerror", (err) => pageErrors.push(err.message));

  await page.goto("/index.html");
  await page.evaluate(() => localStorage.clear());
  await page.reload();
  await page.waitForSelector("#paintModeBtn", { state: "visible" });

  const cellHandle = page.locator(".day-cell[data-date]").first();
  const dateKey = await cellHandle.getAttribute("data-date");

  // Seed an existing note for this day directly through the app's own
  // save path (long-press -> type -> Speichern), so there is something a
  // careless "Löschen" tap, or a lack of any cancel option, could destroy.
  const openViaLongPress = async () => {
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

  await openViaLongPress();
  await page.fill("#noteInput", "Kinderarzt 15 Uhr");
  await page.click("#noteDialog button[value='save']");
  // Wait on the actual persisted side effect rather than dialog.open: the
  // native <dialog> sets .open = false synchronously on close(), but fires
  // the "close" event (which is what runs closeNoteDialog()/saveJSON()) as
  // a separately queued task, so polling .open alone can race ahead of the
  // save actually landing in localStorage.
  await page.waitForFunction(
    (key) => {
      const raw = localStorage.getItem("kk.notes");
      return raw !== null && JSON.parse(raw)[key] !== undefined;
    },
    dateKey,
    { timeout: 5000 }
  );

  const notesAfterSeed = await page.evaluate(() => JSON.parse(localStorage.getItem("kk.notes") || "{}"));
  assert.strictEqual(
    notesAfterSeed[dateKey],
    "Kinderarzt 15 Uhr",
    "precondition failed: seeding the note through the dialog's own Speichern flow didn't persist it"
  );

  // The user reopens the dialog — e.g. an accidental long-press, or simply
  // wanting to re-read the note — and now wants to back out without
  // changing anything.
  await openViaLongPress();

  const dialogButtons = page.locator("#noteDialog button");
  const buttonCount = await dialogButtons.count();
  let neutralCancelButton = null;
  for (let i = 0; i < buttonCount; i += 1) {
    const btn = dialogButtons.nth(i);
    const value = (await btn.getAttribute("value")) || "";
    const text = ((await btn.textContent()) || "").trim();
    const isSave = value === "save" || /speichern/i.test(text);
    const isDelete = value === "delete" || /löschen/i.test(text);
    if (!isSave && !isDelete) {
      neutralCancelButton = btn;
      break;
    }
  }

  assert.ok(
    neutralCancelButton,
    "expected the note dialog to expose a neutral cancel/close button " +
      "(neither 'Speichern' nor 'Löschen') so a user who long-pressed by " +
      "accident, or just wants to re-read the note, isn't trapped between " +
      "committing an edit and instantly deleting the note. Dialog only " +
      `contained ${buttonCount} button(s), all save/delete.`
  );

  // If a neutral button exists (post-fix), using it must actually close
  // the dialog and must not touch the pre-existing note.
  if (neutralCancelButton) {
    await neutralCancelButton.click();
    await page.waitForFunction(() => !document.getElementById("noteDialog").open, null, {
      timeout: 5000,
    });
    // Give the dialog's queued "close" event (closeNoteDialog()/render())
    // a turn of the event loop to actually run before inspecting state.
    await page.evaluate(() => new Promise((resolve) => setTimeout(resolve, 0)));

    const dialogOpen = await page.evaluate(() => document.getElementById("noteDialog").open);
    assert.strictEqual(dialogOpen, false, "clicking the neutral cancel button should close the dialog");

    const notesAfterCancel = await page.evaluate(() =>
      JSON.parse(localStorage.getItem("kk.notes") || "{}")
    );
    assert.strictEqual(
      notesAfterCancel[dateKey],
      "Kinderarzt 15 Uhr",
      "the neutral cancel button must leave the existing note untouched"
    );
  }

  assert.deepStrictEqual(pageErrors, [], `Unexpected page errors: ${pageErrors.join(", ")}`);
});
