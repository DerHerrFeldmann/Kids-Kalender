// Repro for review finding: "Fast paint drags skip cells because pointermove
// positions are not interpolated" (webapp/app.js:846/894, initPaintDragTracking()).
//
// The drag-paint pointermove handler only paints the single cell returned by
// `document.elementFromPoint(event.clientX, event.clientY)` for *each*
// pointermove sample it actually receives. There is no interpolation of the
// path between two consecutive samples, and `getCoalescedEvents()` is not
// used to recover intermediate positions the OS coalesced away. So if a real
// finger/mouse flick is fast enough that consecutive pointermove samples land
// on non-adjacent cells (e.g. Mo -> Do -> So instead of Mo -> Di -> Mi -> Do
// -> Fr -> Sa -> So), the cells in between (Di/Mi, Fr/Sa) never get painted.
//
// This test drives the exact same document-level pointermove path the app
// uses (dispatching real PointerEvents, matching pointerId, so it exercises
// initPaintDragTracking() itself) and deliberately samples only every other
// cell across a 7-day week row, the way a fast flick would. It asserts that
// every cell in the row ends up painted.
//
// This FAILS on current app.js (the skipped cells stay owner "none") and
// should PASS once the fix interpolates/backfills cells between samples.
const { test } = require("@playwright/test");
const assert = require("node:assert");

// Mobile-sized viewport so a whole week row fits on screen without
// scrolling (elementFromPoint returns null for off-screen coordinates).
// The app registers a service worker whose controllerchange handler
// triggers a page reload on a fresh/incognito context; that's irrelevant to
// this test but can race with the drag below, so block it entirely.
test.use({ viewport: { width: 480, height: 1000 }, serviceWorkers: "block" });

test("every cell along the fast-flick drag path got painted", async ({ page }) => {
  page.on("pageerror", (err) => console.log("PAGEERROR:", err.message));

  await page.goto("/index.html");

  // Start from a clean slate: no existing owners, so every cell we care
  // about starts as "none" and any painted cell is unambiguously our drag.
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

  // Find a full week row of 7 *in-month* cells (same DOM row, i.e. same
  // bounding-box top) so we have 7 real, currently-visible, non-"outside"
  // day cells to drag across.
  const week = await page.evaluate(() => {
    const cells = Array.from(document.querySelectorAll("#dayGrid .day-cell"));
    for (let i = 0; i + 7 <= cells.length; i++) {
      const slice = cells.slice(i, i + 7);
      if (slice.some((c) => c.classList.contains("outside"))) continue;
      const tops = slice.map((c) => c.getBoundingClientRect().top);
      const sameRow = tops.every((t) => Math.abs(t - tops[0]) < 1);
      if (!sameRow) continue;
      return slice.map((c) => {
        const r = c.getBoundingClientRect();
        return { date: c.dataset.date, x: r.x + r.width / 2, y: r.y + r.height / 2 };
      });
    }
    return null;
  });
  assert.ok(week && week.length === 7, "expected to find a full in-month week row of 7 day cells");

  // Perform ONE continuous drag gesture (single pointerId) from day 0 to
  // day 6, but only sample days 0, 2, 4, 6 — exactly like a fast flick whose
  // pointermove events land on non-adjacent cells. Days 1, 3, 5 never get a
  // pointermove of their own.
  await page.mouse.move(week[0].x, week[0].y);
  await page.mouse.down();
  // Small jitter-sized move first (kept under PAINT_DRAG_THRESHOLD=8px),
  // matching how the app tells a tap apart from a drag.
  await page.mouse.move(week[0].x + 2, week[0].y + 1);
  // Jump straight to day 2, day 4, day 6 with a single mousemove event each
  // (steps: 1 means Playwright dispatches only the destination position, no
  // interpolated events in between) — days 1, 3, 5 get no sample at all.
  await page.mouse.move(week[2].x, week[2].y, { steps: 1 });
  await page.mouse.move(week[4].x, week[4].y, { steps: 1 });
  await page.mouse.move(week[6].x, week[6].y, { steps: 1 });
  await page.mouse.up();

  const owners = await page.evaluate((dates) => {
    const cells = document.querySelectorAll("#dayGrid .day-cell");
    const byDate = {};
    for (const cell of cells) byDate[cell.dataset.date] = cell;
    const ownerOf = (cell) =>
      cell.classList.contains("both") ? "both" : cell.classList.contains("p1") ? "p1" : cell.classList.contains("p2") ? "p2" : "none";
    return dates.map((d) => ownerOf(byDate[d]));
  }, week.map((w) => w.date));

  console.log("owners after fast flick across the week:", week.map((w, i) => `${w.date}=${owners[i]}`).join(", "));

  const unpainted = week.filter((_, i) => owners[i] === "none").map((w) => w.date);
  assert.deepStrictEqual(
    unpainted,
    [],
    `expected the whole dragged week to be painted, but these cells were skipped (owner still "none"): ${JSON.stringify(unpainted)}`
  );
});
