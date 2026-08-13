// Reproduces: "Month swipe permanently stops working if a non-swiping
// pointer is released outside the viewport"
// (app.js: initSwipeNavigation(), pointerdown guard at line 1195,
// startPointerId only reset by the viewport's own pointerup/pointercancel
// listeners at lines 1232/1257).
//
// Scenario under test (mouse/trackpad, matches how the PWA behaves on
// macOS/iPadOS): the user presses down on the calendar card and drags
// mostly *vertically* (dx small enough / dy large enough that the
// pointermove handler's `Math.abs(dx) <= Math.abs(dy) * 1.5` check keeps
// `isSwiping` false), ending up over the footer's brush bar, and releases
// there. Since `isSwiping` never became true, `viewport.setPointerCapture()`
// (line 1209) was never called, so the resulting `pointerup` is dispatched
// on the brush button, not on `#calendarViewport`. It bubbles up through
// the footer/body, never through the viewport, so neither the viewport's
// `pointerup` nor `pointercancel` listener ever runs, and `startPointerId`
// is never reset to null.
//
// From that point on, `initSwipeNavigation`'s pointerdown guard
// (`startPointerId !== null`) makes every subsequent pointerdown on the
// viewport a no-op: horizontal swipe-to-change-month is permanently dead
// for the rest of the session, even though a perfectly normal, real
// horizontal swipe gesture follows.
//
// This test drives the real app.js through synthetic PointerEvents
// dispatched on the actual DOM.
//
// FAILS against current app.js (month title never changes -- swipe is dead).
// PASSES once the fix makes sure a pointer released outside the viewport
// (with no capture taken) still resets startPointerId/isSwiping, e.g. by
// listening on document instead of (or in addition to) the viewport, or by
// always taking pointer capture on pointerdown.
const { test } = require("@playwright/test");
const assert = require("node:assert/strict");

// The app registers a service worker whose controllerchange handler
// triggers a page reload on a fresh/incognito context; that's irrelevant to
// this test but can race with the gestures below, so block it entirely.
test.use({ serviceWorkers: "block" });

test("a stray vertical release outside the viewport does not permanently kill swipe navigation", async ({ page }) => {
  await page.goto("/");
  await page.waitForSelector("#calendarViewport");
  await page.waitForSelector("#p1Brush");

  const initialTitle = await page.textContent("#monthTitle");

  const setup = await page.evaluate(() => {
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

    const viewport = document.getElementById("calendarViewport");
    const brush = document.getElementById("p1Brush");
    const vRect = viewport.getBoundingClientRect();
    const bRect = brush.getBoundingClientRect();

    const startX = vRect.left + vRect.width / 2;
    const startY = vRect.top + 10;

    // 1) Press down inside the viewport...
    fire(viewport, "pointerdown", { clientX: startX, clientY: startY });

    // 2) ...then drag mostly vertically (small dx, large dy) so the
    //    pointermove handler's slope check keeps isSwiping === false and
    //    setPointerCapture() is never called.
    const midX = startX + 5;
    const midY = bRect.top + bRect.height / 2;
    fire(viewport, "pointermove", { clientX: midX, clientY: midY });

    // 3) Release over the brush button, i.e. outside #calendarViewport's
    //    subtree -- since no capture was taken, the pointerup event is
    //    dispatched (and bubbles) from the brush button, never reaching the
    //    viewport's own pointerup listener.
    fire(brush, "pointerup", {
      clientX: bRect.left + bRect.width / 2,
      clientY: bRect.top + bRect.height / 2,
    });

    return { vRectWidth: vRect.width, startX, startY };
  });

  // Sanity: that stray release must not have accidentally triggered a real
  // paint/click side effect that would confuse the follow-up assertion.
  assert.ok(setup.vRectWidth > 0, "setup failed: viewport has no width");

  // 4) Now perform a completely normal, real horizontal swipe gesture that
  //    should change the displayed month.
  await page.evaluate(({ startX, startY }) => {
    function fire(el, type, props) {
      el.dispatchEvent(
        new PointerEvent(type, {
          bubbles: true,
          cancelable: true,
          pointerId: 2,
          isPrimary: true,
          pointerType: "mouse",
          ...props,
        })
      );
    }
    const viewport = document.getElementById("calendarViewport");
    fire(viewport, "pointerdown", { clientX: startX, clientY: startY });
    fire(viewport, "pointermove", { clientX: startX - 100, clientY: startY });
    fire(viewport, "pointerup", { clientX: startX - 100, clientY: startY });
  }, setup);

  // Let the slide-to-month animation/transitionend handling settle.
  await page.waitForTimeout(400);

  const titleAfterRealSwipe = await page.textContent("#monthTitle");

  console.log("Initial month:", initialTitle, "| After real swipe:", titleAfterRealSwipe);

  assert.notEqual(
    titleAfterRealSwipe,
    initialTitle,
    "a real horizontal swipe after a stray vertical-release-outside-the-" +
      "viewport should still change the displayed month, but swipe " +
      "navigation was left permanently stuck (startPointerId never reset)"
  );
});
