// Reproduces: "Committed paint drag can be discarded without flushing,
// wedging the undo batch open forever and losing unsaved cells"
// (app.js line 554 / 558 vs. beginUndoBatch()/commitUndoBatch() at 968/992).
//
// Scenario under test (desktop/trackpad, paint mode ON): a paint drag is
// started and crosses the commit threshold (beginUndoBatch() opens
// currentUndoBatch). Before the drag is released, a second pointerdown
// fires with the *same* pointerId/isPrimary=true (exactly what real mouse
// hardware delivers for a second button pressed while the first is still
// held — pointerId and isPrimary do not vary by button). The cell
// pointerdown handler unconditionally overwrites `paintDrag` with a fresh,
// uncommitted object, so the pending pointerup sees `wasCommitted === false`
// and never calls commitUndoBatch()/saveJSON(). currentUndoBatch is now
// permanently non-null, so every future pushUndoRecord() call is silently
// swallowed into that orphaned array instead of undoStack: the "Rückgängig"
// button stays disabled and undo is dead for the rest of the session.
//
// This test drives the real app.js through synthetic PointerEvents
// dispatched on the actual DOM (top-level `let`/`function` bindings from a
// classic <script> are visible to Playwright's page.evaluate in the same
// realm, so we can also read internal state like `paintDrag` /
// `currentUndoBatch` / `undoStack` directly for a precise assertion).
//
// FAILS against current app.js (undo stays disabled forever).
// PASSES once the fix flushes/commits (or discards cleanly) any in-progress
// committed paintDrag before replacing/dropping it.
const { test } = require("@playwright/test");
const assert = require("node:assert/strict");

// The app registers a service worker whose controllerchange handler
// triggers a page reload on a fresh/incognito context; that's irrelevant to
// this test but can race with the drag below, so block it entirely.
test.use({ serviceWorkers: "block" });

test("interrupting a committed paint drag with a second pointerdown does not wedge undo open forever", async ({ page }) => {
  await page.goto("/");
  await page.waitForSelector("#dayGrid .day-cell");

  // Turn on paint mode so pointerdown on a day-cell stages a paintDrag.
  await page.click("#paintModeBtn");

  const state = await page.evaluate(() => {
    function fire(el, type, props) {
      el.dispatchEvent(
        new PointerEvent(type, {
          bubbles: true,
          cancelable: true,
          pointerId: 1,
          isPrimary: true, // real mouse pointers are always isPrimary, regardless of which button
          pointerType: "mouse",
          ...props,
        })
      );
    }

    const cells = Array.from(document.querySelectorAll("#dayGrid .day-cell")).filter(
      (c) => !c.classList.contains("outside")
    );
    const cellA = cells[0];
    const cellC = cells[2];
    const rectA = cellA.getBoundingClientRect();
    const rectC = cellC.getBoundingClientRect();
    const ax = rectA.left + rectA.width / 2;
    const ay = rectA.top + rectA.height / 2;

    // 1) Left-button press on cellA, then drag far enough to cross the
    //    commit threshold -> beginUndoBatch() opens currentUndoBatch and
    //    the drag paints cellA.
    fire(cellA, "pointerdown", { clientX: ax, clientY: ay });
    fire(document, "pointermove", { clientX: ax + 40, clientY: ay });

    const committedBeforeInterrupt = paintDrag !== null && paintDrag.committed === true;
    const batchOpenBeforeInterrupt = currentUndoBatch !== null;

    // 2) Without releasing, a second pointerdown arrives with the SAME
    //    pointerId/isPrimary (e.g. the right button going down while the
    //    left button is still held) -> the handler unconditionally
    //    replaces paintDrag with a fresh, uncommitted object.
    fire(cellA, "pointerdown", { clientX: ax, clientY: ay });

    // 3) Pointer is released -> endPaintDrag sees wasCommitted === false
    //    on the replacement object, so it never flushes the first batch.
    fire(document, "pointerup", { clientX: ax, clientY: ay });

    // Stop any pending long-press timers from firing later and disturbing
    // state after this evaluate() call returns (a separate, already-known
    // leak; irrelevant to what this test is checking).
    if (typeof longPressTimer !== "undefined" && longPressTimer) {
      clearTimeout(longPressTimer);
      longPressTimer = null;
    }
    longPressFired = false;

    const undoStackLenAfterInterrupt = undoStack.length;
    const batchStillOpenAfterInterrupt = currentUndoBatch !== null;

    // 4) A plain, unrelated tap on a third cell afterwards -- this is the
    //    observable, user-facing symptom: undo should start recording
    //    again for a normal action, but stays dead because
    //    pushUndoRecord() keeps feeding the orphaned currentUndoBatch.
    cellC.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));

    return {
      committedBeforeInterrupt,
      batchOpenBeforeInterrupt,
      undoStackLenAfterInterrupt,
      batchStillOpenAfterInterrupt,
      undoStackLenAfterFollowUpTap: undoStack.length,
      undoBtnDisabledAfterFollowUpTap: document.getElementById("undoBtn").disabled,
    };
  });

  console.log("Observed state:", state);

  // Sanity: the drag really did commit and open an undo batch before the
  // interrupting press (otherwise the test isn't exercising the bug).
  assert.equal(state.committedBeforeInterrupt, true, "setup failed: drag never committed");
  assert.equal(state.batchOpenBeforeInterrupt, true, "setup failed: undo batch never opened");

  // The bug: currentUndoBatch is left permanently open by the interrupted
  // drag (whether or not the fix also chooses to flush/save that drag's own
  // cells), so a later, completely normal tap still can't get an undo
  // record in.
  assert.equal(
    state.batchStillOpenAfterInterrupt,
    false,
    "currentUndoBatch should have been closed (committed or cleanly " +
      "discarded) once the drag was interrupted, but was left open"
  );
  assert.equal(
    state.undoStackLenAfterFollowUpTap,
    state.undoStackLenAfterInterrupt + 1,
    "undo stack should gain exactly one entry for the follow-up tap, but the " +
      "leaked currentUndoBatch swallowed it instead"
  );
  assert.equal(
    state.undoBtnDisabledAfterFollowUpTap,
    false,
    "Rückgängig button should be enabled after the follow-up tap, but stayed " +
      "disabled because undo is permanently wedged"
  );
});
