// Reproduces: "Undo silently rewrites a month the user cannot see after
// navigating away" (app.js undoLastAction() around line 387-405, changeMonth()
// around line 933-936, refreshChrome()'s undoBtn.disabled check at line 639).
//
// Scenario under test: tap a cell in the currently displayed month (single
// tap -> setOwner() -> pushUndoRecord() pushes a one-record batch onto
// undoStack). Navigate forward one month via the "nextMonth" button --
// changeMonth() never touches undoStack, and it isn't keyed by month at all.
// Click "Rückgängig" (undoBtn). undoLastAction() pops that batch and reverts
// state.entries for the *original* month's date, then calls render() -- but
// render() draws state.displayedMonth, which is still the navigated-to
// month. So the mutation happens for real (saved to localStorage) to a month
// the grid never repaints for, and the UI gives no indication anything
// happened. Repeating the tap silently destroys further, older edits in a
// month the user cannot see.
//
// This test drives the real app.js through the actual DOM for the tap
// (dispatching a click on a day-cell, exactly like applyBrush() expects),
// then reads/calls the internal `state.entries` / `state.displayedMonth` /
// `changeMonth()` / `monthTitle()` top-level bindings directly via
// page.evaluate (visible in the same realm since app.js is a classic
// <script>). Navigation uses changeMonth() directly rather than clicking
// "nextMonth", which only starts an animated slide (requestAnimationFrame +
// transitionend) that wouldn't land synchronously within one evaluate().
//
// FAILS against current app.js: the tapped cell's entry is reverted (the
// mutation happened) while state.displayedMonth/the visible grid still shows
// the navigated-to month (the mutation is invisible).
//
// PASSES once fixed by either documented option: (a) undoLastAction()
// navigates to the popped batch's month before rendering -- so
// displayedMonth ends up back on the original month -- or (b) undoStack is
// cleared on month change -- so the click is a no-op and the entry is left
// untouched.
const { test } = require("@playwright/test");
const assert = require("node:assert/strict");

// The app registers a service worker whose controllerchange handler
// triggers a page reload on a fresh/incognito context; that's irrelevant to
// this test but can race with the navigation below, so block it entirely.
test.use({ serviceWorkers: "block" });

test("undo does not silently rewrite a month the user navigated away from", async ({ page }) => {
  // Start from a clean slate so leftover localStorage state from manual
  // testing can't affect which cells are already owned or what's on the
  // undo stack.
  await page.goto("/");
  await page.evaluate(() => localStorage.clear());
  await page.reload();
  await page.waitForSelector("#dayGrid .day-cell");

  const result = await page.evaluate(() => {
    // Pick an in-month, currently-unowned cell so a single tap deterministically
    // creates a fresh "p1" entry (state.activeBrush defaults to "p1").
    const cells = Array.from(document.querySelectorAll("#dayGrid .day-cell"));
    const cell = cells.find((c) => !c.classList.contains("outside") && !state.entries[c.dataset.date]);
    if (!cell) throw new Error("setup failed: no unowned in-month cell found");
    const key = cell.dataset.date;
    const originalMonthTitle = monthTitle(state.displayedMonth);

    // Single tap -> applyBrush() -> setOwner() -> pushUndoRecord() pushes a
    // one-record batch onto undoStack for `key`.
    cell.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));

    const entryAfterTap = state.entries[key];
    const undoStackLenAfterTap = undoStack.length;

    // Navigate away, exactly like a user swiping/tapping to the next month.
    // Calling changeMonth() directly (rather than clicking "nextMonth", which
    // only kicks off an animated slide via requestAnimationFrame +
    // transitionend and wouldn't have landed synchronously here) still
    // exercises exactly the code path the bug report names: "changeMonth
    // does not touch the stack".
    changeMonth(1);
    const navigatedMonthTitle = monthTitle(state.displayedMonth);
    const undoStackLenAfterNav = undoStack.length;

    // Click "Rückgängig" while looking at the *next* month, not the one the
    // tapped cell belongs to.
    document.getElementById("undoBtn").click();

    return {
      key,
      originalMonthTitle,
      entryAfterTap,
      undoStackLenAfterTap,
      navigatedMonthTitle,
      undoStackLenAfterNav,
      entryAfterUndo: state.entries[key],
      displayedMonthTitleAfterUndo: monthTitle(state.displayedMonth),
      domMonthTitleAfterUndo: document.getElementById("monthTitle").textContent,
    };
  });

  console.log("Observed:", result);

  // Sanity: the setup actually exercised the bug's precondition -- a tap
  // created the entry and opened exactly one undo batch, and navigating
  // forward really changed the displayed month without touching the stack.
  assert.equal(result.entryAfterTap, "p1", "setup failed: tap didn't create a p1 entry");
  assert.equal(result.undoStackLenAfterTap, 1, "setup failed: tap didn't push exactly one undo batch");
  assert.notEqual(
    result.navigatedMonthTitle,
    result.originalMonthTitle,
    "setup failed: changeMonth(1) didn't actually change the displayed month"
  );
  assert.equal(
    result.undoStackLenAfterNav,
    1,
    "setup failed: navigating months already cleared the stack before undo was even clicked"
  );

  // The bug: undo popped the batch and reverted the entry (a real,
  // persisted mutation) while the grid is still showing the month the user
  // navigated to -- i.e. the mutation happened to a month invisibly, with no
  // on-screen change at all.
  const mutationHappenedInvisibly =
    result.entryAfterUndo === undefined && // the tapped-month entry really got reverted
    result.displayedMonthTitleAfterUndo === result.navigatedMonthTitle; // yet the view never left the navigated-to month

  assert.equal(
    mutationHappenedInvisibly,
    false,
    "undo silently reverted an entry in a month the user can't see: " +
      `entries['${result.key}'] went from 'p1' to '${result.entryAfterUndo}', ` +
      `but the visible month stayed '${result.displayedMonthTitleAfterUndo}' ` +
      `instead of returning to '${result.originalMonthTitle}'`
  );

  // The displayed month title in the DOM must always agree with
  // state.displayedMonth (render() keeps them in lockstep) -- catches a
  // fix that flips displayedMonth back without actually re-rendering.
  assert.equal(
    result.domMonthTitleAfterUndo,
    result.displayedMonthTitleAfterUndo,
    "DOM month title and state.displayedMonth disagree after undo"
  );
});
