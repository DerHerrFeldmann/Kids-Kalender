// Repro for review finding: "Dark-mode surface stack puts weekend cells at
// pure black, inverting the light-mode order" (styles.css:34 --bg:#000000,
// styles.css:38 --weekday-bg:#101012, styles.css:316-319
// `.day-grid > :nth-child(7n-1), :nth-child(7n) { background: var(--bg) }`).
//
// Weekend columns (Sat/Sun) borrow the page background token (--bg) to
// "recede" slightly against the card. The weekday band (.weekday-row) uses a
// separate token (--weekday-bg) for the same "recede" purpose. Both tokens
// get redefined per color scheme, but not in a way that keeps their relative
// depth consistent:
//   - LIGHT mode: card #fff > weekend #f4f4f6 > band #ececf0 (band is the
//     DEEPEST recede step; weekend is barely tinted).
//   - DARK mode:  card #1c1c1e > band #101012 > weekend #000 (weekend is now
//     the DEEPEST recede step - a pure-black hole - while the band recedes
//     less than the weekend).
//
// So the ranking of "which recede step is stronger, band or weekend" flips
// between the two themes, even though both are meant to be the same subtle
// "recede when unpainted" treatment. This test pins that ranking down: the
// sign of (weekendLuminance - weekdayBandLuminance) must stay the same
// across color schemes. It currently does not (light: weekend lighter than
// band; dark: weekend darker than band), so this test FAILS against the
// current styles.css. It should PASS once weekends get their own token
// (e.g. --weekend-bg) placed one small step below --card-bg in both themes,
// instead of dark mode reusing pure-black --bg for weekends.
const { test, expect } = require("@playwright/test");
const assert = require("node:assert/strict");

test.use({ serviceWorkers: "block" });

function parseRgb(str) {
  const m = str.match(/rgba?\(([^)]+)\)/);
  assert.ok(m, `unexpected color format: ${str}`);
  const parts = m[1].split(",").map((s) => parseFloat(s.trim()));
  return { r: parts[0], g: parts[1], b: parts[2] };
}

function relativeLuminance({ r, g, b }) {
  const srgb = [r, g, b].map((c) => {
    const v = c / 255;
    return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
  });
  return 0.2126 * srgb[0] + 0.7152 * srgb[1] + 0.0722 * srgb[2];
}

async function readSurfaceColors(page, scheme) {
  await page.emulateMedia({ colorScheme: scheme });

  // Start from a fully empty calendar so no owner-color fill masks (or is
  // confused with) the weekend/weekday-band recede styling under test.
  await page.goto("/index.html");
  await page.evaluate(() => {
    localStorage.setItem("kk.entries", "{}");
    localStorage.setItem("kk.splitOrder", "{}");
    localStorage.setItem("kk.notes", "{}");
  });
  await page.reload();
  await page.waitForSelector("#dayGrid .day-cell");
  await page.waitForSelector(".weekday-row");

  // Find an unpainted Sat/Sun day in the currently displayed month that
  // isn't today, so today's-marker styling can't interfere.
  const dateInfo = await page.evaluate(() => {
    const now = new Date();
    const year = now.getFullYear();
    const month = now.getMonth();
    const daysInMonth = new Date(year, month + 1, 0).getDate();
    const pad = (n) => String(n).padStart(2, "0");
    const keyFor = (d) => `${year}-${pad(month + 1)}-${pad(d)}`;
    let weekendKey = null;
    for (let d = 1; d <= daysInMonth; d++) {
      const dow = new Date(year, month, d).getDay(); // 0=Sun ... 6=Sat
      if (weekendKey === null && (dow === 0 || dow === 6) && d !== now.getDate()) {
        weekendKey = keyFor(d);
      }
    }
    return { weekendKey };
  });
  assert.ok(dateInfo.weekendKey, "expected to find an unpainted weekend day in the displayed month");

  const weekendCell = page.locator(`.day-cell[data-date="${dateInfo.weekendKey}"]`);
  await expect(weekendCell).toBeVisible();
  await expect(weekendCell).not.toHaveClass(/\b(p1|p2|both)\b/);

  const weekendBg = await weekendCell.evaluate((cell) => window.getComputedStyle(cell).backgroundColor);
  const weekdayBandBg = await page
    .locator(".weekday-row")
    .evaluate((row) => window.getComputedStyle(row).backgroundColor);
  const cardBg = await page
    .locator(".calendar-card")
    .first()
    .evaluate((card) => window.getComputedStyle(card).backgroundColor);

  return { weekendBg, weekdayBandBg, cardBg };
}

test("weekend cells and the weekday band keep the same relative recede depth in light and dark mode", async ({
  page,
}) => {
  const light = await readSurfaceColors(page, "light");
  const dark = await readSurfaceColors(page, "dark");

  const lightWeekendLum = relativeLuminance(parseRgb(light.weekendBg));
  const lightBandLum = relativeLuminance(parseRgb(light.weekdayBandBg));
  const darkWeekendLum = relativeLuminance(parseRgb(dark.weekendBg));
  const darkBandLum = relativeLuminance(parseRgb(dark.weekdayBandBg));

  console.log("light mode:", light, "weekendLum:", lightWeekendLum, "bandLum:", lightBandLum);
  console.log("dark mode:", dark, "weekendLum:", darkWeekendLum, "bandLum:", darkBandLum);

  // Baseline sanity check on light mode: the weekday band is the deeper
  // (darker) recede step, weekend cells are the lighter/weaker one.
  assert.ok(
    lightBandLum < lightWeekendLum,
    `expected the weekday band to recede more than weekend cells in light mode ` +
      `(bandBg=${light.weekdayBandBg}, weekendBg=${light.weekendBg})`
  );

  // The actual bug: in dark mode weekend cells reuse pure-black --bg and
  // become the DEEPEST recede step, flipping the band/weekend ordering
  // established in light mode.
  assert.ok(
    darkBandLum < darkWeekendLum,
    `BUG: weekend cells recede MORE than the weekday band in dark mode ` +
      `(weekendBg=${dark.weekendBg}, bandBg=${dark.weekdayBandBg}), the opposite of the light-mode ` +
      `ordering (weekendBg=${light.weekendBg} lighter than bandBg=${light.weekdayBandBg}). ` +
      "Weekend cells reuse pure-black --bg instead of their own token, so they invert from the " +
      "weakest recede step in light mode to the strongest (pure black) in dark mode."
  );
});
