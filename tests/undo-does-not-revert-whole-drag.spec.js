// Repro for review finding: "One drag pushes one undo record per painted
// cell, so a drag cannot be undone in one step and drags over 20 cells can
// never be fully undone" (webapp/app.js:811, paintCell()/pushUndoRecord()/
// undoLastAction()).
//
// Root cause: paintCell() -> setOwner() -> pushUndoRecord() runs once per
// cell touched by a drag, pushing one undo record per cell onto undoStack.
// undoLastAction() pops exactly one record per call. So a single drag
// gesture that paints N cells needs N taps of "Rückgängig" to fully revert,
// instead of one tap reverting the whole gesture.
//
// Scenario (scenario A from the review): Mehrfachauswahl is on; three
// consecutive empty ("none") days are dragged over in one continuous
// pointer gesture, painting all three with the active brush. The user then
// taps "Rückgängig" (undoBtn) exactly once, as they would for any other
// single action in the app.
//
// Expected (once fixed): one tap of undo reverts the *entire* drag -> all
// three days go back to "none".
// Actual (current code): one tap of undo only pops the record for the last
// touched cell -> only the last day reverts; the first two stay painted.
//
// This test FAILS on current app.js (only 1 of 3 days reverts) and should
// PASS once one drag gesture is undoable in a single undo step.
const { test } = require("@playwright/test");
const assert = require("node:assert");

// The app registers a service worker whose controllerchange handler
// triggers a page reload on a fresh/incognito context; that's irrelevant to
// this test but can race with the drag below, so block it entirely.
test.use({ viewport: { width: 480, height: 1000 }, serviceWorkers: "block" });

test("one undo tap reverted the entire multi-cell drag gesture", async ({ page }) => {
  page.on("pageerror", (err) => console.log("PAGEERROR:", err.message));

  // First load just to get onto the right origin so we can seed localStorage.
  await page.goto("/index.html");

  // Pick three consecutive dates within the displayed month (today's month)
  // that are guaranteed to be empty, without duplicating dateKey()'s
  // formatting logic.
  const dateKeys = await page.evaluate(() => {
    const now = new Date();
    const y = now.getFullYear();
    const m = String(now.getMonth() + 1).padStart(2, "0");
    const pad = (d) => String(d).padStart(2, "0");
    return {
      d10: `${y}-${m}-${pad(10)}`,
      d11: `${y}-${m}-${pad(11)}`,
      d12: `${y}-${m}-${pad(12)}`,
    };
  });

  // Seed a clean slate: no entries, no splitOrder.
  await page.evaluate(() => {
    localStorage.setItem("kk.entries", JSON.stringify({}));
    localStorage.setItem("kk.splitOrder", JSON.stringify({}));
    localStorage.setItem("kk.activeBrush", "p1");
  });

  await page.reload();
  await page.waitForSelector("#dayGrid .day-cell");

  // Turn on Mehrfachauswahl (paint-drag) mode.
  await page.click("#paintModeBtn");
  await page.waitForSelector("#dayGrid.paint-mode");

  const cell10 = page.locator(`.day-cell[data-date="${dateKeys.d10}"]`);
  const cell11 = page.locator(`.day-cell[data-date="${dateKeys.d11}"]`);
  const cell12 = page.locator(`.day-cell[data-date="${dateKeys.d12}"]`);

  const box10 = await cell10.boundingBox();
  const box11 = await cell11.boundingBox();
  const box12 = await cell12.boundingBox();
  assert.ok(box10 && box11 && box12, "expected days 10-12 to be visible in the grid");

  const center = (box) => ({ x: box.x + box.width / 2, y: box.y + box.height / 2 });
  const c10 = center(box10);
  const c11 = center(box11);
  const c12 = center(box12);

  // One continuous drag gesture across all three days.
  await page.mouse.move(c10.x, c10.y);
  await page.mouse.down();
  // Jitter under PAINT_DRAG_THRESHOLD=8px first, then real movement.
  await page.mouse.move(c10.x + 2, c10.y + 1);
  await page.mouse.move(c11.x, c11.y, { steps: 5 });
  await page.mouse.move(c12.x, c12.y, { steps: 5 });
  await page.mouse.up();

  const readOwners = () =>
    page.evaluate((keys) => {
      const cells = document.querySelectorAll("#dayGrid .day-cell");
      const byDate = {};
      for (const cell of cells) byDate[cell.dataset.date] = cell;
      const ownerOf = (cell) =>
        cell.classList.contains("both") ? "both" : cell.classList.contains("p1") ? "p1" : cell.classList.contains("p2") ? "p2" : "none";
      return { d10: ownerOf(byDate[keys.d10]), d11: ownerOf(byDate[keys.d11]), d12: ownerOf(byDate[keys.d12]) };
    }, dateKeys);

  const afterDrag = await readOwners();
  assert.deepStrictEqual(afterDrag, { d10: "p1", d11: "p1", d12: "p1" },
    `expected all three dragged days to become "p1" right after the drag, got ${JSON.stringify(afterDrag)}`);

  // The user taps "Rückgängig" exactly once, as they would for any other
  // single action.
  await page.click("#undoBtn");

  const afterOneUndo = await readOwners();
  console.log("owners after ONE undo tap following a 3-cell drag:", afterOneUndo);

  // One undo tap should revert the whole drag gesture back to how it was
  // before the drag (all three days "none" again) — not just the last
  // touched cell.
  assert.deepStrictEqual(
    afterOneUndo,
    { d10: "none", d11: "none", d12: "none" },
    `expected one undo tap to revert the entire 3-cell drag to "none", but got ${JSON.stringify(afterOneUndo)} ` +
      '(current app.js pushes one undo record per painted cell, so one undo tap only reverts the last cell touched by the drag)'
  );
});
