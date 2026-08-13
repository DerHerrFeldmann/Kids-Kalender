// Repro for review finding: "'Today' is exposed visually only - no
// aria-current and no textual cue in the cell label" (app.js:478-493,
// buildDayCell() / applyOwnerVisual()).
//
// buildDayCell() marks the current date solely by adding the "today" CSS
// class, which is rendered as a ring around the day number (see
// ".day-cell.today .num" in styles.css). applyOwnerVisual() builds the
// cell's aria-label from the date, the owner and note/month state, but never
// looks at whether the cell is today - so today's accessible name has
// exactly the same shape as every other day's ("<Wochentag>, <Datum>,
// <Owner>"), and the cell carries no aria-current attribute either.
//
// A screen-reader user walking the 42-cell grid therefore has no
// programmatic way to find "today", even though it is the anchor the whole
// app is built around (handover chip, back-to-today control, stats are all
// relative to it). This violates WCAG 1.3.1 (info conveyed by presentation
// only, no programmatic equivalent).
//
// This test seeds an empty calendar (no owners assigned, so nothing else
// changes the label) and asserts that today's cell (a) has
// aria-current="date" and (b) has an aria-label distinguishable from an
// ordinary day's aria-label beyond just the date itself (e.g. an appended
// ", heute"). Both currently FAIL. They should PASS once buildDayCell() sets
// aria-current on the today cell and applyOwnerVisual()/buildDayCell()
// append a "heute" cue to the label.
const { test, expect } = require("@playwright/test");
const assert = require("node:assert/strict");

test.use({ serviceWorkers: "block" });

test("today's day-cell exposes aria-current and a textual 'heute' cue, not just a visual ring", async ({
  page,
}) => {
  await page.goto("/index.html");

  // Start from a fully empty calendar so no owner assignment changes the
  // aria-label shape and masks/confuses the assertion under test.
  await page.evaluate(() => {
    localStorage.setItem("kk.entries", "{}");
    localStorage.setItem("kk.splitOrder", "{}");
    localStorage.setItem("kk.notes", "{}");
  });
  await page.reload();
  await page.waitForSelector("#dayGrid .day-cell");

  // Compute, inside the page's own JS runtime, the date key for today and
  // for some other unowned day in the currently displayed month. Both are
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
    let otherKey = null;
    for (let d = 1; d <= daysInMonth; d++) {
      if (d !== now.getDate()) {
        otherKey = keyFor(d);
        break;
      }
    }
    return { todayKey, otherKey };
  });

  const todayCell = page.locator(`.day-cell[data-date="${dateInfo.todayKey}"]`);
  const otherCell = page.locator(`.day-cell[data-date="${dateInfo.otherKey}"]`);

  await expect(todayCell).toBeVisible();
  await expect(otherCell).toBeVisible();

  // Sanity check: neither cell carries an owner class, so any label/attribute
  // difference found below is due to the today-marker, not custody paint.
  await expect(todayCell).not.toHaveClass(/\b(p1|p2|both)\b/);
  await expect(otherCell).not.toHaveClass(/\b(p1|p2|both)\b/);
  await expect(todayCell).toHaveClass(/\btoday\b/);

  const todayAriaCurrent = await todayCell.getAttribute("aria-current");
  console.log("today cell aria-current:", todayAriaCurrent);

  assert.strictEqual(
    todayAriaCurrent,
    "date",
    `BUG: today's day-cell has aria-current="${todayAriaCurrent}" instead of "date" - the current ` +
      "date is marked only by a visual CSS ring (.day-cell.today .num), so assistive tech has no " +
      "programmatic way to identify it."
  );

  const todayLabel = await todayCell.getAttribute("aria-label");
  const otherLabel = await otherCell.getAttribute("aria-label");

  console.log("today cell aria-label:", todayLabel);
  console.log("other day cell aria-label:", otherLabel);

  assert.match(
    todayLabel,
    /heute/i,
    `BUG: today's day-cell aria-label ("${todayLabel}") contains no "heute" cue - it has the exact ` +
      "same shape as an ordinary day's label, so a screen-reader user reading the grid cannot tell " +
      "which of the 42 buttons is today."
  );
});
