// Reproduces: ensurePeek() (app.js, initSwipeNavigation) rebuilds the whole
// 42-cell preview card from scratch every time the drag's delta sign flips
// (ensurePeek only caches the *latest* direction: `if (peekCard && peekDelta
// === delta) return;`). A hesitant swipe that wobbles back and forth across
// its own start X therefore tears down and rebuilds (buildCardContent: 42
// Date allocations + 42 <button> + up to 84 <span> + describeCell, followed
// by a forced getBoundingClientRect layout) on every single crossing.
//
// A correct implementation only ever needs at most one preview build per
// direction (delta === 1, delta === -1) -- e.g. by keeping both neighbour
// cards around, or by debouncing the flip -- no matter how many times the
// finger wobbles across the origin during one continuous drag.
//
// This test drives a real pointer-drag gesture over the live app, oscillating
// the pointer across its start X eight times without lifting it, and counts
// how many ".calendar-card--peek" elements get inserted into
// #calendarViewport via a MutationObserver. Today that count tracks the
// number of direction flips (>= 8); once fixed it must stay bounded
// regardless of how many times the gesture wobbles.
const { test } = require("@playwright/test");
const assert = require("node:assert");

const FLIP_COUNT = 8; // number of direction changes during the drag

// The calendar card can be taller than Playwright's default 720px viewport
// (5-6 week rows); use a tall enough window so the drag point we compute
// below actually lands inside #calendarViewport instead of being clipped
// outside the visible window (elementFromPoint => null).
//
// The app also registers a service worker (app.js) that reloads the page on
// `controllerchange` when a new SW takes control -- that mid-test reload
// would destroy our MutationObserver/counter mid-gesture, so block service
// workers entirely for this test.
test.use({ viewport: { width: 1280, height: 1000 }, serviceWorkers: "block" });

test("a hesitant, oscillating swipe rebuilds the peek card at most once per direction", async ({ page }) => {
  await page.goto("/");
  await page.waitForLoadState("networkidle");
  await page.waitForSelector("#calendarViewport");
  await page.waitForSelector("#calendarCard");

  // Count DOM insertions of the peek (preview) card.
  await page.evaluate(() => {
    window.__peekAdds = 0;
    const viewport = document.getElementById("calendarViewport");
    const mo = new MutationObserver((mutations) => {
      for (const m of mutations) {
        for (const node of m.addedNodes) {
          if (
            node.nodeType === 1 &&
            node.classList &&
            node.classList.contains("calendar-card--peek")
          ) {
            window.__peekAdds++;
          }
        }
      }
    });
    mo.observe(viewport, { childList: true });
    window.__peekMo = mo; // keep a reference alive
  });

  const box = await page.locator("#calendarViewport").boundingBox();
  assert.ok(box, "#calendarViewport must be visible/measurable");
  const startX = box.x + box.width / 2;
  // Stay near the top of the card: it can be much taller than the window.
  const y = box.y + Math.min(80, box.height / 4);

  await page.mouse.move(startX, y);
  await page.mouse.down();

  // First move must exceed the 10px threshold to arm isSwiping.
  await page.mouse.move(startX + 20, y, { steps: 2 });

  // Now wobble the pointer back and forth across startX several times,
  // without ever releasing the button -- exactly the "hesitant swipe" from
  // the bug report.
  for (let i = 0; i < FLIP_COUNT; i++) {
    const offset = i % 2 === 0 ? -20 : 20;
    await page.mouse.move(startX + offset, y, { steps: 2 });
  }

  await page.mouse.up();

  const peekAdds = await page.evaluate(() => window.__peekAdds);
  assert.ok(
    Number.isFinite(peekAdds),
    `window.__peekAdds was ${peekAdds} instead of a number -- the page context was likely ` +
      `replaced mid-gesture (e.g. an unrelated navigation/reload); rerun the test.`,
  );

  // A correct implementation needs at most one preview-card build per
  // direction (delta === -1 and delta === 1), i.e. 2 builds total, no
  // matter how many times the gesture flips direction. The current code
  // rebuilds on every flip, so peekAdds tracks FLIP_COUNT (>= 8) instead.
  assert.ok(
    peekAdds <= 2,
    `Expected at most 2 peek-card (re)builds for an ${FLIP_COUNT}-flip oscillating drag ` +
      `(one per direction), but ensurePeek() rebuilt the 42-cell preview card ${peekAdds} times ` +
      `-- it destroys and reconstructs the whole preview on every direction flip instead of caching ` +
      `both neighbour cards.`,
  );

  console.log("peek card rebuilt", peekAdds, "times for", FLIP_COUNT, "direction flips");
});
