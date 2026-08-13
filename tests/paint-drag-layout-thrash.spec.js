/**
 * Reproduces: "paintAlongSegment interleaves elementFromPoint reads with
 * style writes, forcing a synchronous layout per painted cell"
 * (webapp/app.js, paintAlongSegment / paintCell / applyOwnerVisual).
 *
 * paintAlongSegment() walks the segment from the last pointermove sample to
 * the current one in PAINT_DRAG_STEP-sized hops, and for *each* hop it:
 *   1. calls document.elementFromPoint() (a read that forces layout), then
 *   2. calls paintCell() -> applyOwnerVisual() which mutates classList /
 *      inline custom properties on that cell (a write that dirties layout).
 * Because this happens inside one loop, a single fast pointermove that
 * crosses several cells produces read,write,read,write,... instead of doing
 * all the reads first and all the writes after (which would cost one layout
 * instead of one per newly painted cell).
 *
 * This test instruments document.elementFromPoint and DOMTokenList
 * add/remove (what applyOwnerVisual uses to (de)select a cell's owner
 * class) to record the order operations happen in, then performs one fast
 * multi-cell drag in a *single* native pointermove (a mouse.move with no
 * interpolation covering several cell-widths at once, so paintAlongSegment's
 * internal step loop is what produces the multiple hits, not multiple
 * browser-level events).
 *
 * FAILS against current code: at least one 'read' is recorded after the
 * first 'write' (reads and writes are interleaved).
 * PASSES once fixed: every 'read' happens before every 'write' (cells are
 * resolved in a read-only pass, then painted in a batch).
 */
const { test } = require("@playwright/test");
const assert = require("node:assert");

// The app registers a service worker whose controllerchange handler
// triggers a page reload on a fresh/incognito context; that's irrelevant to
// this test but can race with the drag below, so block it entirely.
test.use({ serviceWorkers: "block" });

test("reads and writes are batched (all reads precede all writes)", async ({ page }) => {
  await page.goto("/index.html", { waitUntil: "load" });

  // Enable "Mehrfachauswahl" (paint-drag) mode.
  await page.click("#paintModeBtn");

  // Grab a run of same-row, in-month day cells to drag across.
  const rects = await page.evaluate(() => {
    const cells = Array.from(document.querySelectorAll("#dayGrid .day-cell"))
      .filter((c) => !c.classList.contains("outside"));
    // Find a contiguous run of >=6 cells on the same visual row.
    for (let i = 0; i + 5 < cells.length; i++) {
      const rs = cells.slice(i, i + 6).map((c) => c.getBoundingClientRect());
      if (rs.every((r) => Math.abs(r.top - rs[0].top) < 1)) {
        return rs.map((r) => ({ x: r.left + r.width / 2, y: r.top + r.height / 2 }));
      }
    }
    throw new Error("no same-row run of 6 day cells found");
  });
  assert.ok(rects.length === 6, "expected 6 same-row cell centers");

  const start = rects[0];
  const end = rects[5];

  // Instrument reads (elementFromPoint) and writes (classList mutation,
  // which is what applyOwnerVisual uses to paint a cell's owner).
  await page.evaluate(() => {
    window.__log = [];
    const origElementFromPoint = document.elementFromPoint.bind(document);
    document.elementFromPoint = function (x, y) {
      window.__log.push("read");
      return origElementFromPoint(x, y);
    };
    const origAdd = DOMTokenList.prototype.add;
    const origRemove = DOMTokenList.prototype.remove;
    DOMTokenList.prototype.add = function (...args) {
      window.__log.push("write");
      return origAdd.apply(this, args);
    };
    DOMTokenList.prototype.remove = function (...args) {
      window.__log.push("write");
      return origRemove.apply(this, args);
    };
  });

  // Start the drag on the first cell...
  await page.mouse.move(start.x, start.y);
  await page.mouse.down();

  // ...then jump straight to a cell 5 cell-widths away in one single,
  // non-interpolated pointermove. This distance is well over
  // PAINT_DRAG_STEP (12px), so paintAlongSegment's own internal loop -
  // not multiple browser events - is what visits the in-between cells.
  await page.mouse.move(end.x, end.y, { steps: 1 });

  await page.mouse.up();

  const log = await page.evaluate(() => window.__log);

  const writeCount = log.filter((e) => e === "write").length;
  const readCount = log.filter((e) => e === "read").length;
  assert.ok(
    readCount >= 4,
    `expected several elementFromPoint reads during the drag, got ${readCount} (log: ${JSON.stringify(log)})`
  );
  assert.ok(
    writeCount >= 4,
    `expected several classList writes during the drag (multiple new cells painted), got ${writeCount} (log: ${JSON.stringify(log)})`
  );

  const firstWriteIndex = log.indexOf("write");
  const readsAfterFirstWrite = log.slice(firstWriteIndex + 1).filter((e) => e === "read").length;

  assert.strictEqual(
    readsAfterFirstWrite,
    0,
    `expected all elementFromPoint reads to happen before any classList write (batched read-then-write), ` +
      `but ${readsAfterFirstWrite} read(s) occurred after the first write - reads and writes are interleaved ` +
      `(log: ${JSON.stringify(log)})`
  );

  console.log("PASS: reads and writes are batched (all reads precede all writes). Log:", log);
});
