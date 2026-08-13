// Reproduces: "First pointermove of every swipe builds a 42-cell peek card
// and then forces a layout, inside the event handler" (app.js ~line 1162,
// ensurePeek() inside initSwipeNavigation()'s viewport pointermove handler).
//
// ensurePeek() is only invoked once a pointermove crosses the 10px swipe
// threshold (app.js:1248, `if (Math.abs(dx) <= 10 ...) return;`). On that
// very first qualifying move it lazily calls buildCardContent() (creates a
// month title + weekday row + 42 day cells, ~90 DOM nodes), appends the
// result to #calendarViewport, and immediately reads
// peekCard.getBoundingClientRect().height — a synchronous forced layout of
// the subtree it just inserted. All of that happens synchronously inside
// the pointermove listener's call stack, on the frame where the swipe
// starts tracking the finger.
//
// This test instruments document.createElement and Element.appendChild
// before app.js loads, drives a real swipe gesture with synthetic
// PointerEvents, and asserts that the pointermove call which first crosses
// the swipe threshold did NOT itself create/append a `.calendar-card--peek`
// subtree. A fix that pre-builds the two neighbour cards ahead of time
// (e.g. right after render(), or via requestIdleCallback, keeping them
// until the displayed month changes) means that first pointermove finds an
// already-built peek card and does no DOM construction of its own.
//
// FAILS against current app.js: the threshold-crossing pointermove call
// itself appends a brand-new 42-cell `.calendar-card--peek` node.
// PASSES once neighbour peek cards are built ahead of the gesture instead
// of lazily inside the pointermove handler.
const { test } = require("@playwright/test");
const assert = require("node:assert/strict");

test.use({ serviceWorkers: "block" });

test("threshold-crossing pointermove did not itself build a peek card", async ({ page }) => {
  // Instrument *before* any app script runs, so we can attribute DOM
  // construction to the specific pointermove call that crosses the swipe
  // threshold.
  await page.addInitScript(() => {
    window.__peekBuildEvents = [];
    window.__pointermoveCallCount = 0;

    // Track how many nodes with class "calendar-card--peek" get appended
    // to the DOM, tagged with which pointermove call (by ordinal) was
    // executing on the call stack at the time.
    const originalAppendChild = Node.prototype.appendChild;
    Node.prototype.appendChild = function (node) {
      if (
        node &&
        node.classList &&
        node.classList.contains &&
        node.classList.contains("calendar-card--peek")
      ) {
        window.__peekBuildEvents.push({
          duringPointermoveCall: window.__pointermoveCallCount,
        });
      }
      return originalAppendChild.call(this, node);
    };

    // Wrap addEventListener so we can count pointermove invocations on
    // #calendarViewport specifically (the handler under test), regardless
    // of load order relative to app.js.
    const originalAdd = EventTarget.prototype.addEventListener;
    EventTarget.prototype.addEventListener = function (type, listener, opts) {
      if (type === "pointermove" && this && this.id === "calendarViewport") {
        const wrapped = function (event) {
          window.__pointermoveCallCount += 1;
          return listener.call(this, event);
        };
        return originalAdd.call(this, type, wrapped, opts);
      }
      return originalAdd.call(this, type, listener, opts);
    };
  });

  await page.goto("/");
  await page.waitForSelector("#calendarViewport #calendarCard .day-grid .day-cell");

  const result = await page.evaluate(async () => {
    function fire(el, type, props) {
      el.dispatchEvent(
        new PointerEvent(type, {
          bubbles: true,
          cancelable: true,
          pointerId: 1,
          isPrimary: true,
          pointerType: "touch",
          ...props,
        })
      );
    }

    const viewport = document.getElementById("calendarViewport");
    const rect = viewport.getBoundingClientRect();
    const startX = rect.left + rect.width * 0.8;
    const y = rect.top + rect.height / 2;

    fire(viewport, "pointerdown", { clientX: startX, clientY: y });

    // Step past the 10px threshold in several small increments so the
    // *first* qualifying pointermove is unambiguous, then keep dragging a
    // bit further (mimicking a real, gradual swipe) to also exercise the
    // "steady state" moves for comparison.
    const callCountBeforeThresholdCross = window.__pointermoveCallCount;
    let thresholdCrossingCall = null;
    for (let dx = 2; dx <= 60; dx += 2) {
      fire(viewport, "pointermove", { clientX: startX - dx, clientY: y });
      if (thresholdCrossingCall === null && dx > 10) {
        thresholdCrossingCall = window.__pointermoveCallCount;
      }
      await new Promise((r) => setTimeout(r, 0));
    }

    fire(document, "pointerup", { clientX: startX - 60, clientY: y });

    return {
      callCountBeforeThresholdCross,
      thresholdCrossingCall,
      peekBuildEvents: window.__peekBuildEvents,
      totalPointermoveCalls: window.__pointermoveCallCount,
    };
  });

  console.log("pointermove calls before threshold crossed:", result.callCountBeforeThresholdCross);
  console.log("pointermove call that crossed the 10px threshold:", result.thresholdCrossingCall);
  console.log("peek-card build events (tagged by pointermove call ordinal):", result.peekBuildEvents);

  assert.ok(
    result.thresholdCrossingCall !== null,
    "expected the synthetic drag to cross the swipe threshold at least once"
  );
  assert.ok(
    result.peekBuildEvents.length > 0,
    "expected a peek card to be built at some point during the gesture (sanity check — if this " +
      "fails the drag simulation itself is broken, not the fix under test)"
  );

  const builtDuringThresholdCrossingCall = result.peekBuildEvents.some(
    (e) => e.duringPointermoveCall === result.thresholdCrossingCall
  );

  assert.equal(
    builtDuringThresholdCrossingCall,
    false,
    "the pointermove call that first crosses the 10px swipe threshold constructed a new " +
      "`.calendar-card--peek` subtree synchronously on its own call stack. The peek card must " +
      "already exist (built ahead of the gesture) by the time the swipe threshold is crossed, " +
      "instead of being built lazily inside the pointermove handler."
  );
});
