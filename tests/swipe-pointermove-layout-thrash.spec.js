/**
 * Reproduces: "Swipe pointermove forces a synchronous layout every frame to
 * re-read two constant heights" (app.js, initSwipeNavigation, pointermove
 * handler around lines 1163-1164).
 *
 * The pointermove handler re-reads `card.getBoundingClientRect().height` and
 * `peekCard.getBoundingClientRect().height` on *every* pointermove, even
 * though neither height can change mid-drag. This test drives a real swipe
 * gesture (mouse-driven pointer events, so viewport.setPointerCapture works
 * exactly as it does for a real user) over the calendar viewport and counts
 * how many times getBoundingClientRect() is invoked on the card / peek-card
 * elements specifically during pointermove events *after* the swipe has
 * already been initialized (i.e. steady-state dragging, not the one-time
 * setup on the first move that crosses the swipe threshold).
 *
 * - Current (buggy) code: 2 calls per subsequent pointermove (card + peek).
 * - Fixed code: heights are measured once (at init / when the peek card is
 *   built) and the per-move path only writes style properties, so this
 *   should be 0.
 */
const { test } = require("@playwright/test");
const assert = require("node:assert/strict");

// The app registers a service worker whose controllerchange handler
// triggers a page reload on a fresh/incognito context; that's irrelevant to
// this test but can race with the drag below, so block it entirely.
test.use({ viewport: { width: 500, height: 900 }, serviceWorkers: "block" });

test("pointermove handler does not re-measure card/peek height every frame", async ({ page }) => {
  // Instrument getBoundingClientRect on the card + peek-card elements
  // *before* any app script runs, so every call during the test is caught.
  await page.addInitScript(() => {
    window.__rectCallCount = 0;
    const original = Element.prototype.getBoundingClientRect;
    Element.prototype.getBoundingClientRect = function (...args) {
      if (
        this.id === "calendarCard" ||
        (this.classList && this.classList.contains("calendar-card--peek"))
      ) {
        window.__rectCallCount++;
      }
      return original.apply(this, args);
    };
  });

  await page.goto("/index.html");
  await page.waitForSelector("#calendarCard");

  const viewportBox = await page.locator("#calendarViewport").boundingBox();
  const startX = viewportBox.x + viewportBox.width / 2;
  const startY = viewportBox.y + viewportBox.height / 2;

  // Begin the drag and cross the swipe-activation threshold (dx > 10px)
  // with a first move — this is the one-time init move (sets isSwiping,
  // pins viewport height, builds the peek card).
  await page.mouse.move(startX, startY);
  await page.mouse.down();
  await page.mouse.move(startX + 20, startY, { steps: 1 });

  // Sanity check: the drag actually activated (peek card got created).
  const peekExists = await page.locator(".calendar-card--peek").count();
  assert.equal(peekExists, 1, "swipe did not activate (no peek card built) — test setup is broken");

  const baseline = await page.evaluate(() => window.__rectCallCount);

  // Steady-state dragging: 15 further pointermoves, well within
  // SWIPE_THRESHOLD (60px) so we stay in the "still dragging" branch.
  const numMoves = 15;
  for (let i = 1; i <= numMoves; i++) {
    await page.mouse.move(startX + 20 + i * 2, startY, { steps: 1 });
  }

  const after = await page.evaluate(() => window.__rectCallCount);
  await page.mouse.up();

  const callsDuringSteadyDrag = after - baseline;
  console.log(
    `getBoundingClientRect() calls on card/peek during ${numMoves} steady-state pointermoves: ${callsDuringSteadyDrag}`
  );

  // Buggy code: 2 reads (card + peek) per move -> 30 for 15 moves.
  // Fixed code: heights are cached once outside the per-move path -> 0.
  assert.equal(
    callsDuringSteadyDrag,
    0,
    `expected 0 getBoundingClientRect() calls on card/peek elements during steady-state ` +
      `pointermove handling (heights should be cached, not re-measured every frame), got ${callsDuringSteadyDrag}`
  );
});
