// Repro for review finding: "The charcoal weekday band is an unpalette-d
// outlier that inverts meaning in dark mode" (styles.css:~6, --header-dark;
// styles.css:145, .weekday-row).
//
// Root cause: `--header-dark: #3a3a3f` is a single fixed value that is never
// redefined inside the `@media (prefers-color-scheme: dark)` block (unlike
// --bg, --card-bg, --ink, --muted, --line, --chip-bg, which all get
// dark-mode overrides). So `.weekday-row` keeps the exact same charcoal
// background in both schemes:
//   - In LIGHT mode, --card-bg is #ffffff, so the weekday band (#3a3a3f) is
//     far DARKER than the card it sits on -> a heavy near-black bar.
//   - In DARK mode, --card-bg becomes #1c1c1e, which is darker than the
//     unchanged #3a3a3f band -> the same band is now LIGHTER than the card
//     it sits on, i.e. it visually inverts from "the darkest element" to
//     "a lighter-than-card gray strip".
//
// A palette element flipping which side of the card's luminance it sits on,
// purely because dark mode wasn't considered, is exactly the kind of
// unintentional inversion this test pins down: the sign of
// (weekday-row luminance - card luminance) must stay the same across color
// schemes.
//
// This test FAILS on current styles.css because that sign flips between
// light and dark mode. It should PASS once dark mode defines its own
// scheme-aware weekday-band background that stays darker than --card-bg
// (e.g. a --weekday-bg token overridden inside the dark media query, such as
// the ~#101012 suggested in the review), so the band consistently recedes
// relative to the card in both schemes.
const { test, expect } = require("@playwright/test");
const assert = require("node:assert");

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

async function readWeekdayAndCardBg(page, scheme) {
  await page.emulateMedia({ colorScheme: scheme });
  await page.goto("/index.html");
  await page.waitForSelector(".weekday-row");
  await page.waitForSelector(".calendar-card");

  return page.evaluate(() => {
    const weekdayRow = document.querySelector(".weekday-row");
    const card = document.querySelector(".calendar-card");
    return {
      weekdayBg: window.getComputedStyle(weekdayRow).backgroundColor,
      cardBg: window.getComputedStyle(card).backgroundColor,
    };
  });
}

test("weekday band keeps the same darker-than-card relationship in light and dark mode", async ({ page }) => {
  const light = await readWeekdayAndCardBg(page, "light");
  const dark = await readWeekdayAndCardBg(page, "dark");

  const lightWeekdayLum = relativeLuminance(parseRgb(light.weekdayBg));
  const lightCardLum = relativeLuminance(parseRgb(light.cardBg));
  const darkWeekdayLum = relativeLuminance(parseRgb(dark.weekdayBg));
  const darkCardLum = relativeLuminance(parseRgb(dark.cardBg));

  console.log("light mode:", light, "weekdayLum:", lightWeekdayLum, "cardLum:", lightCardLum);
  console.log("dark mode:", dark, "weekdayLum:", darkWeekdayLum, "cardLum:", darkCardLum);

  // Sanity check on the light-mode baseline: the band is (and should stay)
  // darker than the card it sits on.
  assert.ok(
    lightWeekdayLum < lightCardLum,
    `expected weekday band to be darker than the card in light mode ` +
      `(weekdayBg=${light.weekdayBg}, cardBg=${light.cardBg})`
  );

  // The actual bug: in dark mode the exact same fixed background is now
  // LIGHTER than --card-bg, flipping which side of the card's luminance the
  // band sits on compared to light mode.
  assert.ok(
    darkWeekdayLum < darkCardLum,
    `BUG: weekday band is lighter than the card in dark mode ` +
      `(weekdayBg=${dark.weekdayBg}, cardBg=${dark.cardBg}), the opposite of its ` +
      `light-mode relationship (weekdayBg=${light.weekdayBg} darker than cardBg=${light.cardBg}). ` +
      "--header-dark is a fixed value never redefined for dark mode, so it inverts " +
      "from the darkest element on the card to a lighter-than-card strip."
  );
});
