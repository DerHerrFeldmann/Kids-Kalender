/**
 * Repro for review finding: "A peek card is orphaned in the DOM forever when
 * pointerup commits to a direction that does not match peekDelta"
 * (webapp/app.js, slideToMonth() call inside the viewport's pointerup handler,
 * around line 1200-1201).
 *
 * initSwipeNavigation() computes `peekDelta` from the sign of dx seen during
 * the most recent `pointermove`, but on `pointerup` it recomputes dx fresh
 * from that event instead of reusing the tracked `lastDx`. If the pointer's
 * final release position implies the *opposite* direction from the one the
 * last pointermove committed to (entirely realistic for a fast flick with
 * sparse move sampling — no second finger required), slideToMonth() is asked
 * to slide toward a delta that doesn't match the already-built/appended
 * `peekCard`. It then builds and appends a brand-new second peek card for the
 * correct delta and only ever removes *that* one in finish(); the original
 * peekCard (still a non-`display:none`, absolutely positioned child of
 * #calendarViewport) is silently abandoned in the DOM forever, since the
 * local `peekCard` variable that pointed to it gets reset to null right after.
 *
 * This test drives the real page with raw CDP mouse events so we can force
 * exactly that mismatch (mouseMoved dx=+80 -> peekDelta=-1, then a
 * mouseReleased at dx=-80 with NO intervening mousemove at that position),
 * then asserts no leftover ".calendar-card--peek" node remains once the
 * (possibly buggy) slide settles.
 */
const { test } = require("@playwright/test");
const assert = require("node:assert");

// The app registers a service worker whose controllerchange handler
// triggers a page reload on a fresh/incognito context; that's irrelevant to
// this test but can race with the drag below, so block it entirely.
test.use({ viewport: { width: 900, height: 900 }, serviceWorkers: "block" });

test("no orphaned peek card left behind in #calendarViewport", async ({ page }) => {
  await page.goto("/");
  await page.waitForSelector("#calendarViewport");

  const box = await page.locator("#calendarViewport").boundingBox();
  assert.ok(box, "#calendarViewport should be visible");
  const startX = box.x + box.width / 2;
  const y = box.y + box.height / 2;

  const client = await page.context().newCDPSession(page);

  // pointerdown
  await client.send("Input.dispatchMouseEvent", {
    type: "mousePressed",
    x: startX,
    y,
    button: "left",
    clickCount: 1,
    pointerType: "mouse",
  });

  // pointermove: drag 80px RIGHT (past the 60px SWIPE_THRESHOLD) -> this is
  // the last move the drag handler ever sees, so it commits peekDelta = -1
  // (a "previous month" preview card gets built and appended to the viewport).
  await client.send("Input.dispatchMouseEvent", {
    type: "mouseMoved",
    x: startX + 80,
    y,
    button: "left",
    pointerType: "mouse",
  });

  // pointerup: released 80px to the LEFT of the start point instead, with no
  // pointermove in between reporting that position first. dx computed fresh
  // from *this* event is <= -SWIPE_THRESHOLD, i.e. it commits to the
  // opposite direction (delta = +1) from what peekDelta (-1) says.
  await client.send("Input.dispatchMouseEvent", {
    type: "mouseReleased",
    x: startX - 80,
    y,
    button: "left",
    pointerType: "mouse",
  });

  // Let the slide animation (SLIDE_DURATION = 220ms) and its transitionend
  // cleanup fully settle.
  await page.waitForTimeout(700);

  const peekCount = await page.locator("#calendarViewport .calendar-card--peek").count();
  assert.strictEqual(
    peekCount,
    0,
    `expected 0 leftover ".calendar-card--peek" nodes in #calendarViewport after the swipe settled, found ${peekCount} ` +
      `(the mismatched-direction peek card from the earlier pointermove was never removed)`
  );
});
