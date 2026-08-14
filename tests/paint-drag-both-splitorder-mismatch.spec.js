// Regression coverage for two related, previously-broken behaviors of
// Mehrfachauswahl (paint-drag):
//
// 1. Each touched cell now decides its own next owner from its OWN current
//    owner (same nextOwner/COMBINE_TABLE rule a lone tap would use), instead
//    of the whole drag being locked to one owner decided from the first
//    cell touched. So dragging from day 14 (owned by p1) through days
//    15-17 (empty), with active brush p2, must NOT turn every day "both" —
//    only day 14 (the actual conflict) does; 15-17 become plain "p2".
//
// 2. Original review finding this file used to cover on its own: "Drag-
//    painting 'both' produces mirrored diagonals within the same drag"
//    (webapp/app.js, setOwner()). state.splitOrder is derived purely from
//    the drag's fixed state.activeBrush, not from each cell's own prior
//    owner, so every "both" cell produced by ONE drag gesture — wherever it
//    occurs, and regardless of what that cell's own previous owner was —
//    must still share the same diagonal split orientation. Seeding day 16
//    as a SECOND p1-owned day (also touched by the same drag) keeps this
//    invariant covered even though the per-cell fix above means not every
//    touched day becomes "both" anymore.
const { test, expect } = require("@playwright/test");
const assert = require("node:assert");

// A mobile-sized viewport so the whole month grid (including the row
// holding days 15-17) fits on screen without scrolling — otherwise
// elementFromPoint() during the drag returns null for off-screen cells.
// The app registers a service worker whose controllerchange handler
// triggers a page reload on a fresh/incognito context; that's irrelevant to
// this test but can race with the drag below, so block it entirely.
test.use({ viewport: { width: 480, height: 1000 }, serviceWorkers: "block" });

test('per-cell owner is correct, and every "both" cell from one drag shares a consistent split orientation', async ({ page }) => {
  page.on("pageerror", (err) => console.log("PAGEERROR:", err.message));

  // First load just to get onto the right origin so we can seed localStorage.
  await page.goto("/index.html");

  // Figure out which dateKeys the app will use for "day 14/15/16/17" of the
  // month it displays by default (today's month), so we don't have to
  // duplicate dateKey()'s formatting logic and stay in sync with whatever
  // month is "current" when this test runs.
  const dateKeys = await page.evaluate(() => {
    const now = new Date();
    const y = now.getFullYear();
    const m = String(now.getMonth() + 1).padStart(2, "0");
    const pad = (d) => String(d).padStart(2, "0");
    return {
      d14: `${y}-${m}-${pad(14)}`,
      d15: `${y}-${m}-${pad(15)}`,
      d16: `${y}-${m}-${pad(16)}`,
      d17: `${y}-${m}-${pad(17)}`,
    };
  });

  // Seed state: days 14 and 16 = p1 ("Papa"), 15 and 17 = empty, active
  // brush = p2 ("Mama"), and make sure there's no leftover splitOrder
  // bookkeeping.
  await page.evaluate((keys) => {
    localStorage.setItem("kk.entries", JSON.stringify({ [keys.d14]: "p1", [keys.d16]: "p1" }));
    localStorage.setItem("kk.splitOrder", JSON.stringify({}));
    localStorage.setItem("kk.activeBrush", "p2");
  }, dateKeys);

  await page.reload();
  await page.waitForSelector("#dayGrid .day-cell");

  // Turn on Mehrfachauswahl (paint-drag) mode.
  await page.click("#paintModeBtn");
  await page.waitForSelector("#dayGrid.paint-mode");

  const cell14 = page.locator(`.day-cell[data-date="${dateKeys.d14}"]`);
  const cell15 = page.locator(`.day-cell[data-date="${dateKeys.d15}"]`);
  const cell16 = page.locator(`.day-cell[data-date="${dateKeys.d16}"]`);
  const cell17 = page.locator(`.day-cell[data-date="${dateKeys.d17}"]`);

  const box14 = await cell14.boundingBox();
  const box15 = await cell15.boundingBox();
  const box16 = await cell16.boundingBox();
  const box17 = await cell17.boundingBox();
  assert.ok(box14 && box15 && box16 && box17, "expected days 14-17 to be visible in the grid");

  const center = (box) => ({ x: box.x + box.width / 2, y: box.y + box.height / 2 });
  const c14 = center(box14);
  const c15 = center(box15);
  const c16 = center(box16);
  const c17 = center(box17);

  // Perform one continuous drag gesture from day 14 through days 15, 16, 17.
  await page.mouse.move(c14.x, c14.y);
  await page.mouse.down();
  // Small jitter-sized move first (kept under PAINT_DRAG_THRESHOLD=8px)
  // then a real move past the threshold, matching how the app tells a tap
  // apart from a drag.
  await page.mouse.move(c14.x + 2, c14.y + 1);
  await page.mouse.move(c15.x, c15.y, { steps: 5 });
  await page.mouse.move(c16.x, c16.y, { steps: 5 });
  await page.mouse.move(c17.x, c17.y, { steps: 5 });
  await page.mouse.up();

  // Only the two actual conflicts (14, 16) become "both"; the empty days
  // (15, 17) are simply painted with the active brush.
  const owners = await page.evaluate((keys) => {
    const cells = document.querySelectorAll("#dayGrid .day-cell");
    const byDate = {};
    for (const cell of cells) byDate[cell.dataset.date] = cell;
    const ownerOf = (cell) =>
      cell.classList.contains("both") ? "both" : cell.classList.contains("p1") ? "p1" : cell.classList.contains("p2") ? "p2" : "none";
    return {
      d14: ownerOf(byDate[keys.d14]),
      d15: ownerOf(byDate[keys.d15]),
      d16: ownerOf(byDate[keys.d16]),
      d17: ownerOf(byDate[keys.d17]),
    };
  }, dateKeys);
  assert.deepStrictEqual(owners, { d14: "both", d15: "p2", d16: "both", d17: "p2" },
    `expected only the conflicting days (14, 16) to become "both" and the empty days (15, 17) to be painted plain "p2", got ${JSON.stringify(owners)}`);

  // The actual bug this file originally covered: every "both" cell produced
  // by the *same* drag gesture must render with the same diagonal split
  // orientation (--cell-first/--cell-second), regardless of what each
  // cell's own prior owner was.
  const splits = await page.evaluate((keys) => {
    const cells = document.querySelectorAll("#dayGrid .day-cell");
    const byDate = {};
    for (const cell of cells) byDate[cell.dataset.date] = cell;
    const splitOf = (key) => ({
      first: byDate[key].style.getPropertyValue("--cell-first"),
      second: byDate[key].style.getPropertyValue("--cell-second"),
    });
    return { d14: splitOf(keys.d14), d16: splitOf(keys.d16) };
  }, dateKeys);

  console.log("splits of the two 'both' days after one drag gesture:", splits);

  assert.deepStrictEqual(
    splits.d16,
    splits.d14,
    `day 16 split orientation ${JSON.stringify(splits.d16)} differs from day 14 ${JSON.stringify(splits.d14)} within the same drag gesture`
  );
});
