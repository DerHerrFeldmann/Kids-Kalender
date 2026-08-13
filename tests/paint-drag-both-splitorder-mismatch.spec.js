// Repro for review finding: "Drag-painting 'both' produces mirrored
// diagonals within the same drag" (webapp/app.js:324, setOwner()).
//
// Scenario (from the review): activeBrush = p2 ("Mama"); day 14 already
// owned by p1 ("Papa"); days 15-17 are empty ("none"). In Mehrfachauswahl
// mode the user presses on day 14 and drags through 15, 16, 17.
// commitPaintDrag() locks drag.owner = "both" from the first cell and
// paintCell() applies that same owner to every cell touched by the drag.
//
// setOwner() only records state.splitOrder[key] when *that cell's own*
// previous value was p1/p2:
//   if (owner === "both" && (current === "p1" || current === "p2")) {
//     state.splitOrder[key] = current;
//   } else if (owner !== "both") {
//     delete state.splitOrder[key];
//   }
// For day 14 current === "p1" -> splitOrder="p1" -> first(base) color = Papa.
// For days 15-17 current === "none" -> neither branch runs -> splitOrder
// stays unset -> splitColorsFor() falls back to its hardcoded default
// firstBrush = "p2" -> first(base) color = Mama.
//
// Result: four days painted "both" in a single drag gesture render with two
// different diagonal orientations (--cell-first/--cell-second CSS custom
// properties differ), both in the live DOM grid and in the exported PNG
// (drawCellBackground reads the same split via describeCell/splitColorsFor).
//
// This test FAILS on current app.js (orientations differ) and should PASS
// once the fix makes every cell touched by one drag gesture share the same
// split orientation.
const { test } = require("@playwright/test");
const assert = require("node:assert");

// A mobile-sized viewport so the whole month grid (including the row
// holding days 15-17) fits on screen without scrolling — otherwise
// elementFromPoint() during the drag returns null for off-screen cells.
// The app registers a service worker whose controllerchange handler
// triggers a page reload on a fresh/incognito context; that's irrelevant to
// this test but can race with the drag below, so block it entirely.
test.use({ viewport: { width: 480, height: 1000 }, serviceWorkers: "block" });

test('all dragged "both" cells share one consistent split orientation', async ({ page }) => {
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

  // Seed state: day 14 = p1 ("Papa"), 15-17 absent (="none"), active brush
  // = p2 ("Mama"), and make sure there's no leftover splitOrder bookkeeping.
  await page.evaluate((keys) => {
    localStorage.setItem("kk.entries", JSON.stringify({ [keys.d14]: "p1" }));
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

  // All four days should now be owner "both".
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
  assert.deepStrictEqual(owners, { d14: "both", d15: "both", d16: "both", d17: "both" },
    `expected all four dragged days to become "both", got ${JSON.stringify(owners)}`);

  // The actual bug check: every cell touched by the *same* drag gesture must
  // render with the same diagonal split orientation (--cell-first/--cell-second).
  const splits = await page.evaluate((keys) => {
    const cells = document.querySelectorAll("#dayGrid .day-cell");
    const byDate = {};
    for (const cell of cells) byDate[cell.dataset.date] = cell;
    const splitOf = (cell) => ({
      first: cell.style.getPropertyValue("--cell-first"),
      second: cell.style.getPropertyValue("--cell-second"),
    });
    return {
      d14: splitOf(byDate[keys.d14]),
      d15: splitOf(byDate[keys.d15]),
      d16: splitOf(byDate[keys.d16]),
      d17: splitOf(byDate[keys.d17]),
    };
  }, dateKeys);

  console.log("splits after one drag gesture:", splits);

  assert.deepStrictEqual(
    splits.d15,
    splits.d14,
    `day 15 split orientation ${JSON.stringify(splits.d15)} differs from day 14 ${JSON.stringify(splits.d14)} within the same drag gesture`
  );
  assert.deepStrictEqual(
    splits.d16,
    splits.d14,
    `day 16 split orientation ${JSON.stringify(splits.d16)} differs from day 14 ${JSON.stringify(splits.d14)} within the same drag gesture`
  );
  assert.deepStrictEqual(
    splits.d17,
    splits.d14,
    `day 17 split orientation ${JSON.stringify(splits.d17)} differs from day 14 ${JSON.stringify(splits.d14)} within the same drag gesture`
  );
});
