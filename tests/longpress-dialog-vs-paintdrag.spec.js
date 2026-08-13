/**
 * Reproduces: "Long-press note dialog and paint drag are not mutually
 * exclusive; a hold-then-drag flips a day's color behind the open dialog"
 * (app.js, cell pointerdown handler around line 463-481, and
 * commitPaintDrag/initPaintDragTracking around line 819-865).
 *
 * Scenario: Mehrfachauswahl (paint mode) is on. The user presses down on a
 * day cell and holds for >500ms (the long-press timer fires and opens the
 * note dialog for that day) *before* moving the pointer past the
 * PAINT_DRAG_THRESHOLD (8px). Only after the dialog is open does the finger
 * move enough to cross the threshold.
 *
 * Expected (fixed) behavior: opening the note dialog should cancel/void the
 * staged paintDrag, so no color change is committed for that day while the
 * dialog is open.
 *
 * Current (buggy) behavior: commitPaintDrag() has no awareness of the note
 * dialog. The document-level pointermove handler commits the paint drag
 * anyway, directly mutating state.entries and (on pointerup) persisting it
 * to localStorage under "kk.entries" - even though the note dialog is open
 * and the user never intended a color change.
 */
const { test } = require("@playwright/test");
const assert = require("node:assert");

// The app registers a service worker whose controllerchange handler
// triggers a page reload on a fresh/incognito context; that's irrelevant to
// this test but can race with the long-press below, so block it entirely.
test.use({ serviceWorkers: "block" });

test("note dialog long-press and paint drag are mutually exclusive", async ({ page }) => {
  const pageErrors = [];
  page.on("pageerror", (err) => pageErrors.push(err.message));

  await page.goto("/index.html");
  await page.evaluate(() => localStorage.clear());
  await page.reload();
  await page.waitForSelector("#paintModeBtn", { state: "visible" });

  // Turn on Mehrfachauswahl (paint mode).
  await page.click("#paintModeBtn");
  const paintActive = await page.getAttribute("#paintModeBtn", "aria-pressed");
  assert.strictEqual(paintActive, "true", "paint mode should be active after toggling it on");

  // Grab an arbitrary, currently-unpainted day cell and remember its date key.
  const cellHandle = await page.locator(".day-cell[data-date]").first();
  const dateKey = await cellHandle.getAttribute("data-date");
  const box = await cellHandle.boundingBox();
  const cx = box.x + box.width / 2;
  const cy = box.y + box.height / 2;

  // Press down and hold past the 500ms long-press timer, WITHOUT moving yet.
  await page.mouse.move(cx, cy);
  await page.mouse.down();
  await page.waitForTimeout(650);

  const dialogOpenAfterHold = await page.evaluate(
    () => document.getElementById("noteDialog").open
  );
  assert.strictEqual(
    dialogOpenAfterHold,
    true,
    "note dialog should have opened after the 500ms long-press while holding still"
  );

  // Only now does the pointer move enough to cross the paint-drag threshold
  // (the user hesitated, then started dragging, exactly like the report
  // describes).
  await page.mouse.move(cx + 30, cy, { steps: 5 });
  await page.mouse.up();
  await page.waitForTimeout(100);

  const entriesAfter = await page.evaluate(() => localStorage.getItem("kk.entries"));
  const parsed = entriesAfter ? JSON.parse(entriesAfter) : {};

  assert.ok(
    !(dateKey in parsed),
    `Expected no color to have been committed for ${dateKey} while the note ` +
      `dialog was open, but kk.entries contains: ${JSON.stringify(parsed)}. ` +
      `A hold-then-drag past the long-press threshold committed a paint ` +
      `drag behind the open note dialog.`
  );

  assert.deepStrictEqual(pageErrors, [], `Unexpected page errors: ${pageErrors.join(", ")}`);
});
