// Repro for review finding: "Today ring is left-anchored and elliptical, so
// it nudges the date out of column alignment" (styles.css, .day-cell.today
// .num vs .day-cell .num).
//
// `.day-cell .num` is absolutely positioned with a fixed `top`/`left`
// origin and is sized purely by its text content. `.day-cell.today .num`
// keeps that exact same top-left origin but on top of it adds
// `min-width: 20px; height: 20px; padding: 0 2px; border-radius: 50%`, i.e.
// it grows the box away from the fixed origin instead of growing it
// *around* the glyph's own centre, and only reaches its 20px min-width
// floor for narrow (single-digit) content.
//
// Two consequences are checked, both of which FAIL against the current
// styles.css and should PASS once `.num` is given a fixed, constant-size,
// centered box (e.g. `left` + fixed `width`/`height` + centered flex
// content) so that only the background/color change on `.today`:
//
//   1. Toggling the `.today` class off and back on for the very same live
//      cell/digit shifts the digit's horizontal center within its own
//      cell - the ring grows from the fixed top-left origin instead of
//      around the glyph's own center, so this can only be caused by the
//      ring styling itself, not by two different dates' natural digit
//      widths.
//   2. The ring's own box (width x height) is a different shape for a
//      wide two-digit date than for a single-digit date, because the box
//      is sized from text content (padded, floored at a min-width)
//      instead of being a constant size - so the marker's shape changes
//      depending on which date it falls on, exactly as the finding
//      describes.
//
// The page's clock is faked (via Playwright's clock API) to specific,
// known dates so both the "today" cell and its digit-count are fully
// deterministic, regardless of which real-world day this test runs on.
const { test, expect } = require("@playwright/test");
const assert = require("node:assert/strict");

test.use({ serviceWorkers: "block" });

async function loadCalendarAsOf(page, isoTime) {
  await page.clock.setFixedTime(new Date(isoTime));
  await page.reload();
  await page.waitForSelector("#dayGrid .day-cell");
}

function measureTodayNum(cell) {
  return cell.evaluate((cellEl) => {
    const num = cellEl.querySelector(".num");
    const cellRect = cellEl.getBoundingClientRect();

    const centerFromCellLeft = () => {
      const r = num.getBoundingClientRect();
      return r.left + r.width / 2 - cellRect.left;
    };

    const withRing = {
      width: num.getBoundingClientRect().width,
      height: num.getBoundingClientRect().height,
      center: centerFromCellLeft(),
    };

    // Same live element, same digit text - strip the .today class to see
    // exactly where/how big this same digit renders as a plain day-number.
    cellEl.classList.remove("today");
    const withoutRing = {
      width: num.getBoundingClientRect().width,
      height: num.getBoundingClientRect().height,
      center: centerFromCellLeft(),
    };
    cellEl.classList.add("today"); // restore, for cleanliness

    return { text: num.textContent, withRing, withoutRing };
  });
}

test("today's ring keeps the day-number centered where it sits without the ring, and has a shape that doesn't depend on the date", async ({
  page,
}) => {
  // 2024-03-30: a two-digit date whose natural glyph width, per the app's
  // own font metrics, is wide enough that the ring's `padding: 0 2px`
  // pushes it past its 20px min-width - i.e. its box is sized by content,
  // not by a constant.
  await page.clock.install({ time: new Date("2024-03-30T10:00:00") });
  await page.goto("/index.html");

  // Start from a fully empty calendar so no owner-color fill (which swaps
  // in its own --p1-ink/--p2-ink colors) masks or interferes with the
  // plain `.today` ring styling under test.
  await page.evaluate(() => {
    localStorage.setItem("kk.entries", "{}");
    localStorage.setItem("kk.splitOrder", "{}");
    localStorage.setItem("kk.notes", "{}");
  });
  await page.reload();
  await page.waitForSelector("#dayGrid .day-cell");

  const wideDigitCell = page.locator('.day-cell[data-date="2024-03-30"]');
  await expect(wideDigitCell).toBeVisible();
  await expect(wideDigitCell).toHaveClass(/\btoday\b/);
  // Doesn't carry an owner class - any effect measured below must come
  // from the `.today` ring alone, not custody paint.
  await expect(wideDigitCell).not.toHaveClass(/\b(p1|p2|both)\b/);

  const wideDigitMeasurement = await measureTodayNum(wideDigitCell);
  console.log("today (2024-03-30) .num measurement:", JSON.stringify(wideDigitMeasurement));
  assert.equal(wideDigitMeasurement.text, "30");

  const centerShift = Math.abs(wideDigitMeasurement.withRing.center - wideDigitMeasurement.withoutRing.center);
  console.log("horizontal center shift caused by the ring (px):", centerShift);

  assert.ok(
    centerShift < 1.5,
    `BUG: adding the .today ring shifts this exact digit's horizontal center by ${centerShift.toFixed(1)}px ` +
      "within its own cell (comparing the same live element with/without the .today class) - the " +
      "ring grows from the number's fixed top-left origin instead of around the glyph's center, " +
      "knocking today's date out of the grid's vertical column alignment."
  );

  // Now move "today" to a single-digit date (the 5th) and measure the
  // ring's own box again. If the ring were a constant-size marker (as the
  // fix intends), its width/height would be identical to the wide,
  // two-digit date measured above - only the glyph inside would differ.
  await loadCalendarAsOf(page, "2024-03-05T10:00:00");
  const narrowDigitCell = page.locator('.day-cell[data-date="2024-03-05"]');
  await expect(narrowDigitCell).toBeVisible();
  await expect(narrowDigitCell).toHaveClass(/\btoday\b/);
  await expect(narrowDigitCell).not.toHaveClass(/\b(p1|p2|both)\b/);

  const narrowDigitMeasurement = await measureTodayNum(narrowDigitCell);
  console.log("today (2024-03-05) .num measurement:", JSON.stringify(narrowDigitMeasurement));
  assert.equal(narrowDigitMeasurement.text, "5");

  const widthDelta = Math.abs(wideDigitMeasurement.withRing.width - narrowDigitMeasurement.withRing.width);
  const heightDelta = Math.abs(wideDigitMeasurement.withRing.height - narrowDigitMeasurement.withRing.height);
  console.log("ring width delta between dates (px):", widthDelta, "height delta:", heightDelta);

  assert.ok(
    widthDelta < 1 && heightDelta < 1,
    `BUG: the .today ring measures ${wideDigitMeasurement.withRing.width.toFixed(1)}x` +
      `${wideDigitMeasurement.withRing.height.toFixed(1)}px for a two-digit date but ` +
      `${narrowDigitMeasurement.withRing.width.toFixed(1)}x${narrowDigitMeasurement.withRing.height.toFixed(1)}px ` +
      "for a single-digit date - the ring's box is sized from its text content (padded, floored at a " +
      "min-width) instead of being a constant size, so the marker's shape changes depending on which " +
      "date it falls on."
  );
});
