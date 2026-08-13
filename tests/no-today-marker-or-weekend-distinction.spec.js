// Repro for review finding: "The grid has no temporal landmarks - no today
// marker, no weekend distinction" (app.js:~477, buildDayCell).
//
// buildDayCell() only ever adds the "outside" class (for cells that spill
// into the neighbouring month) and an owner class (p1/p2/both) from
// applyOwnerVisual(). Nothing marks which cell is *today*, and nothing
// distinguishes Saturday/Sunday columns from weekday ones. For a day that
// has no owner assigned yet, every one of the 42 cells in the grid renders
// with byte-identical styling regardless of whether it's today or a random
// Tuesday, and regardless of whether it's a weekday or a weekend day - the
// grid is 42 undifferentiated boxes.
//
// This test seeds an empty calendar (no owners assigned, so nothing paints
// over the missing landmarks) and checks two things that should each be
// visually distinguishable but currently aren't:
//   1. Today's day-number (`.num`) should render differently than an
//      ordinary unpainted day's `.num` (a ring/filled counter, per the
//      review's recommendation) - it currently doesn't.
//   2. An unpainted Saturday/Sunday cell's background should read
//      differently than an unpainted weekday cell's background (a weekend
//      tint, per the review's recommendation of styling
//      `.day-grid > :nth-child(7n-1), .day-grid > :nth-child(7n)`) - it
//      currently doesn't.
//
// Both assertions FAIL against the current app.js/styles.css (styles are
// pixel-for-pixel identical in both cases) and should PASS once a "today"
// indicator and a weekend tint are added as the review recommends.
const { test, expect } = require("@playwright/test");
const assert = require("node:assert/strict");

test.use({ serviceWorkers: "block" });

test("today and weekend cells are visually distinguished from ordinary unpainted days", async ({ page }) => {
  await page.goto("/index.html");

  // Start from a fully empty calendar so no owner-color fill masks (or is
  // confused with) whatever landmark styling is under test.
  await page.evaluate(() => {
    localStorage.setItem("kk.entries", "{}");
    localStorage.setItem("kk.splitOrder", "{}");
    localStorage.setItem("kk.notes", "{}");
  });
  await page.reload();
  await page.waitForSelector("#dayGrid .day-cell");

  // Compute, inside the page's own JS runtime, the date keys for: today,
  // some other unowned weekday in the currently displayed month, and an
  // unowned weekend day in the currently displayed month. All three are
  // guaranteed to exist and be "current" (not spillover from another
  // month), since the app always opens on the current month.
  const dateInfo = await page.evaluate(() => {
    const now = new Date();
    const year = now.getFullYear();
    const month = now.getMonth();
    const daysInMonth = new Date(year, month + 1, 0).getDate();
    const pad = (n) => String(n).padStart(2, "0");
    const keyFor = (d) => `${year}-${pad(month + 1)}-${pad(d)}`;
    const todayKey = keyFor(now.getDate());
    let weekendKey = null;
    let weekdayKey = null;
    for (let d = 1; d <= daysInMonth; d++) {
      const dow = new Date(year, month, d).getDay(); // 0=Sun ... 6=Sat
      if (weekendKey === null && (dow === 0 || dow === 6)) weekendKey = keyFor(d);
      if (weekdayKey === null && dow >= 1 && dow <= 5 && d !== now.getDate()) weekdayKey = keyFor(d);
    }
    return { todayKey, weekendKey, weekdayKey };
  });

  const todayCell = page.locator(`.day-cell[data-date="${dateInfo.todayKey}"]`);
  const weekdayCell = page.locator(`.day-cell[data-date="${dateInfo.weekdayKey}"]`);
  const weekendCell = page.locator(`.day-cell[data-date="${dateInfo.weekendKey}"]`);

  await expect(todayCell).toBeVisible();
  await expect(weekdayCell).toBeVisible();
  await expect(weekendCell).toBeVisible();

  // None of the three should carry an owner class - any styling difference
  // found below must come from a today/weekend landmark, not custody paint.
  for (const cell of [todayCell, weekdayCell, weekendCell]) {
    await expect(cell).not.toHaveClass(/\b(p1|p2|both)\b/);
  }

  const readNumStyle = (cellLocator) =>
    cellLocator.evaluate((cell) => {
      const num = cell.querySelector(".num");
      const s = window.getComputedStyle(num);
      return {
        color: s.color,
        backgroundColor: s.backgroundColor,
        boxShadow: s.boxShadow,
        border: s.border,
        outline: s.outline,
        fontWeight: s.fontWeight,
      };
    });

  const todayNumStyle = await readNumStyle(todayCell);
  const weekdayNumStyle = await readNumStyle(weekdayCell);

  console.log("today .num style:", todayNumStyle);
  console.log("ordinary weekday .num style:", weekdayNumStyle);

  assert.notDeepStrictEqual(
    todayNumStyle,
    weekdayNumStyle,
    "BUG: today's day-number renders with the exact same style (color/background/box-shadow/" +
      "border/outline/font-weight) as an ordinary unpainted weekday - there is no visual marker " +
      "for the current date, so a user has to count cells to find today."
  );

  const readCellBackground = (cellLocator) =>
    cellLocator.evaluate((cell) => window.getComputedStyle(cell).backgroundColor);

  const weekdayBg = await readCellBackground(weekdayCell);
  const weekendBg = await readCellBackground(weekendCell);

  console.log("unpainted weekday background:", weekdayBg, "unpainted weekend background:", weekendBg);

  assert.notStrictEqual(
    weekendBg,
    weekdayBg,
    "BUG: an unpainted Saturday/Sunday cell has the exact same background color as an unpainted " +
      "weekday cell - the weekend rhythm that drives most custody arrangements is invisible in the grid."
  );
});
