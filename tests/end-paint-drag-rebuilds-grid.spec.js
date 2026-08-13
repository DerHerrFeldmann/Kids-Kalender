// Reproduces: "render() after a paint drag rebuilds the entire grid that
// applyOwnerVisual already repainted" (app.js, endPaintDrag() inside
// initPaintDragTracking(), ~line 1047).
//
// Scenario under test (paint mode ON): a paint drag starts on one cell,
// crosses the commit threshold, and is released over the SAME cell (so no
// other cell's data changes). commitPaintDrag()/paintCell() ->
// applyOwnerVisual() already updated that cell's classes/custom-properties
// in place. endPaintDrag() then unconditionally calls render(), which does
// `document.getElementById("dayGrid").innerHTML = ""` and rebuilds all 42
// day-cell <button> elements from scratch (see buildDayCell()/render() in
// app.js). That means the exact DOM node the user was just interacting with
// is destroyed and replaced by a new, distinct node with equivalent content
// -- byte-identical output, but a different node identity and a full
// teardown/relayout that a plain refreshChrome() (which only touches
// #handoverRow / stats / undo button) wouldn't cause.
//
// This test captures a reference to the day-cell node before the drag,
// performs the drag+release, and asserts the SAME node reference is still
// attached to the grid afterwards. render() replacing the grid makes the
// captured reference go stale (isConnected === false); the fix (calling
// refreshChrome() instead of render()) leaves it in place.
//
// FAILS against current app.js (the pre-drag cell node is detached/replaced).
// PASSES once endPaintDrag() calls refreshChrome() instead of render().
const { test } = require("@playwright/test");
const assert = require("node:assert/strict");

// The app registers a service worker whose controllerchange handler
// triggers a page reload; that's irrelevant to this test but can race with
// the drag below, so keep it out of the picture entirely.
test.use({ serviceWorkers: "block" });

test("committed paint drag released over the same cell does not rebuild the grid", async ({ page }) => {
  await page.goto("/");
  await page.waitForSelector("#dayGrid .day-cell");

  // Turn on paint mode so pointerdown on a day-cell stages a paintDrag.
  await page.click("#paintModeBtn");

  const result = await page.evaluate(() => {
    function fire(el, type, props) {
      el.dispatchEvent(
        new PointerEvent(type, {
          bubbles: true,
          cancelable: true,
          pointerId: 1,
          isPrimary: true,
          pointerType: "mouse",
          ...props,
        })
      );
    }

    const cells = Array.from(document.querySelectorAll("#dayGrid .day-cell")).filter(
      (c) => !c.classList.contains("outside")
    );
    const cellA = cells[0];
    // Tag the node so we can find "the same node" back after the drag even
    // if some unrelated attribute changed.
    cellA.dataset.testMarker = "pre-drag-node";

    const rectA = cellA.getBoundingClientRect();
    const ax = rectA.left + rectA.width / 2;
    const ay = rectA.top + rectA.height / 2;

    // 1) Press on cellA.
    fire(cellA, "pointerdown", { clientX: ax, clientY: ay });
    // 2) Move far enough to cross PAINT_DRAG_THRESHOLD but stay over cellA
    //    (only cellA is touched -- no other cell's DOM should need to change).
    fire(document, "pointermove", { clientX: ax + 6, clientY: ay + 6 });
    fire(document, "pointermove", { clientX: ax + 9, clientY: ay + 9 });

    const committedDuringDrag = paintDrag !== null && paintDrag.committed === true;
    const gridBeforeRelease = document.getElementById("dayGrid");

    // 3) Release over the same spot.
    fire(document, "pointerup", { clientX: ax + 9, clientY: ay + 9 });

    // Stop any pending long-press timer from firing later.
    if (typeof longPressTimer !== "undefined" && longPressTimer) {
      clearTimeout(longPressTimer);
      longPressTimer = null;
    }
    longPressFired = false;

    const gridAfterRelease = document.getElementById("dayGrid");
    const sameNodeStillInGrid =
      cellA.isConnected && cellA.closest("#dayGrid") === gridAfterRelease;
    const markerCellStillPresent =
      document.querySelector('.day-cell[data-test-marker="pre-drag-node"]') === cellA;

    return {
      committedDuringDrag,
      gridElementReplaced: gridBeforeRelease !== gridAfterRelease, // #dayGrid itself is never replaced, only its children
      sameNodeStillInGrid,
      markerCellStillPresent,
    };
  });

  console.log("Observed state:", result);

  // Sanity: the drag really committed (painted something) before release.
  assert.equal(result.committedDuringDrag, true, "setup failed: drag never committed");

  // The bug: render() replaces #dayGrid's children wholesale, so the exact
  // node we grabbed before the drag is no longer the one in the live grid.
  assert.equal(
    result.sameNodeStillInGrid,
    true,
    "the pre-drag day-cell DOM node should still be the live node in #dayGrid " +
      "after the drag is released, but it was replaced by a full render() rebuild"
  );
  assert.equal(
    result.markerCellStillPresent,
    true,
    "a marker attribute set on the pre-drag cell should still be found on the " +
      "live cell after release, but the whole grid (all 42 cells) was torn down " +
      "and rebuilt from scratch"
  );
});
