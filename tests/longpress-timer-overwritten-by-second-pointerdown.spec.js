/**
 * Reproduces: "longPressTimer is overwritten by a second pointerdown without
 * being cleared, firing a note dialog for a cell the user is not pressing"
 * (app.js, cell pointerdown handler ~line 550 vs. cancelLongPress ~line 572).
 *
 * Root cause: `longPressTimer` is a single shared global. Every pointerdown
 * unconditionally does `longPressTimer = setTimeout(...)`, clobbering
 * whatever timer id was already stored there. `cancelLongPress` only ever
 * clears "whatever is currently in the global", so once a second
 * pointerdown has overwritten it, the *first* timer becomes orphaned: no
 * pointerup/pointerleave/pointercancel can reach it anymore, and it still
 * fires 500ms after its own pointerdown.
 *
 * Scenario under test (two concurrent touches, both released well under
 * 500ms - i.e. from the user's perspective neither press should ever open
 * the note dialog):
 *   t=0    pointerdown (pointerId 1) on cell A         -> timer A scheduled
 *   t=50   pointerdown (pointerId 2) on cell B         -> global overwritten
 *                                                          with timer B;
 *                                                          timer A orphaned
 *   t=100  pointerup   (pointerId 2) on cell B         -> clears timer B
 *   t=150  pointerup   (pointerId 1) on cell A         -> cancelLongPress()
 *                                                          finds the global
 *                                                          already null;
 *                                                          timer A is NOT
 *                                                          cleared
 *   t=600  (nothing further happens)
 *
 * Expected (fixed) behavior: since both fingers were lifted well before
 * 500ms elapsed, no long-press should ever fire and the note dialog must
 * stay closed.
 *
 * Current (buggy) behavior: the orphaned timer A fires anyway at
 * t=500 (measured from cell A's own pointerdown), calling
 * openNoteDialog(dateA) - popping the note dialog open for a cell the user
 * released 350ms earlier.
 */
const { test } = require("@playwright/test");
const assert = require("node:assert");

// The app registers a service worker whose controllerchange handler
// triggers a page reload on a fresh/incognito context; that's irrelevant to
// this test but can race with the timers below, so block it entirely.
test.use({ serviceWorkers: "block" });

test("concurrent presses released early never leave an orphaned long-press timer", async ({ page }) => {
  const pageErrors = [];
  page.on("pageerror", (err) => pageErrors.push(err.message));

  await page.goto("/index.html");
  await page.evaluate(() => localStorage.clear());
  await page.reload();
  await page.waitForSelector("#dayGrid .day-cell[data-date]");

  const result = await page.evaluate(async () => {
    function fire(el, type, pointerId, extra) {
      el.dispatchEvent(
        new PointerEvent(type, {
          bubbles: true,
          cancelable: true,
          pointerId,
          isPrimary: pointerId === 1,
          pointerType: "touch",
          ...extra,
        })
      );
    }
    function wait(ms) {
      return new Promise((resolve) => setTimeout(resolve, ms));
    }

    const cells = Array.from(document.querySelectorAll("#dayGrid .day-cell[data-date]"));
    const cellA = cells[0];
    const cellB = cells[10];
    const dateKeyA = cellA.dataset.date;

    // t=0: finger 1 lands on cell A -> long-press timer A scheduled.
    fire(cellA, "pointerdown", 1);

    await wait(50);
    // t=50: finger 2 briefly touches cell B -> clobbers the shared
    // `longPressTimer` global with timer B, orphaning timer A.
    fire(cellB, "pointerdown", 2);

    await wait(50);
    // t=100: finger 2 lifts -> cancelLongPress() clears timer B (the
    // current value of the global).
    fire(cellB, "pointerup", 2);

    await wait(50);
    // t=150: finger 1 lifts too, well under the 500ms long-press
    // threshold -> cancelLongPress() runs again, but the global is
    // already null, so orphaned timer A is never cleared.
    fire(cellA, "pointerup", 1);

    // Wait past the 500ms mark measured from cell A's own pointerdown
    // (already ~150ms elapsed above, so 500ms more is comfortably past it).
    await wait(500);

    const dialog = document.getElementById("noteDialog");
    return {
      dialogOpen: dialog.open,
      dialogTitle: document.getElementById("noteDialogTitle").textContent,
      dateKeyA,
    };
  });

  assert.strictEqual(
    result.dialogOpen,
    false,
    `Both touches were released well under the 500ms long-press threshold, so the ` +
      `note dialog should never open. Instead it opened for "${result.dialogTitle}" ` +
      `(cell ${result.dateKeyA}) - the orphaned first long-press timer fired anyway ` +
      `because the second pointerdown clobbered the shared longPressTimer global ` +
      `without the first pointerup ever being able to cancel it.`
  );

  assert.deepStrictEqual(pageErrors, [], `Unexpected page errors: ${pageErrors.join(", ")}`);
});
