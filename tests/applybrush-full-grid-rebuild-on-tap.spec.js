/**
 * Reproduces: "Every day-cell tap tears down and rebuilds the entire grid
 * even though single-cell repaint machinery already exists" (app.js,
 * applyBrush -> render(), around lines 332-339 / 506-614).
 *
 * applyBrush() (a single-cell color change from a tap) ends by calling the
 * full render(), which does `grid.innerHTML = ""` and rebuilds all 42 day
 * cells from scratch. That means every cell in the grid -- not just the
 * tapped one -- gets thrown away and replaced with a brand-new DOM node,
 * even though paintCell()/applyOwnerVisual() already exist to mutate a
 * single cell in place (used by the drag-paint feature).
 *
 * This test marks an *untouched* day cell (not the one being tapped) by
 * keeping a live reference to its DOM node, taps a *different* day cell,
 * and then checks whether the untouched cell's original DOM node is still
 * attached to the document.
 *
 * - Current (buggy) code: render() wipes grid.innerHTML, so the untouched
 *   cell's original node is detached (isConnected === false) even though
 *   its date/content never changed.
 * - Fixed code: only the tapped cell (plus dependent chrome like stats/
 *   handover/undo button) should be touched; the untouched cell's original
 *   node must remain connected (isConnected === true).
 */
const { test } = require("@playwright/test");
const assert = require("node:assert/strict");

// The app registers a service worker whose controllerchange handler
// triggers a page reload; that's irrelevant to this test but can race with
// the click below, so keep it out of the picture entirely.
test.use({ viewport: { width: 500, height: 900 }, serviceWorkers: "block" });

test("tapping a day cell does not rebuild the entire grid", async ({ page }) => {
  await page.goto("/index.html");
  await page.waitForSelector("#dayGrid .day-cell");

  // Pick two distinct, non-"outside" (current-month) day cells: one we'll
  // tap, one we'll leave untouched and watch for survival.
  const dates = await page.evaluate(() => {
    const cells = [...document.querySelectorAll("#dayGrid .day-cell:not(.outside)")];
    return cells.slice(0, 2).map((c) => c.dataset.date);
  });
  assert.equal(dates.length, 2, "test setup: need at least 2 current-month day cells");
  const [untouchedDate, tappedDate] = dates;

  // Stash a direct reference to the untouched cell's *current* DOM node.
  await page.evaluate((untouchedDate) => {
    const cell = document.querySelector(`#dayGrid .day-cell[data-date="${untouchedDate}"]`);
    window.__untouchedCellRef = cell;
  }, untouchedDate);

  // Tap a *different* cell (a normal, quick click -> applyBrush -> render()).
  await page.click(`#dayGrid .day-cell[data-date="${tappedDate}"]`);

  // Give any (non-existent, in the buggy path synchronous) async work a tick.
  await page.waitForTimeout(50);

  const survived = await page.evaluate(() => {
    const ref = window.__untouchedCellRef;
    return !!ref && ref.isConnected;
  });

  console.log(
    `untouched cell's original DOM node still connected after tapping a different cell: ${survived}`
  );

  // Buggy code: render() rebuilds the whole grid on every tap, so even a
  // cell that was never touched gets a brand-new node -> isConnected===false.
  // Fixed code: only the tapped cell is mutated in place -> isConnected===true.
  assert.equal(
    survived,
    true,
    "expected the untouched day cell's original DOM node to survive a tap on a " +
      "different cell (single-cell repaint), but it was detached -- the whole grid " +
      "was torn down and rebuilt for a one-cell color change"
  );
});
