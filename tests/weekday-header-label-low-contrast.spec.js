// Repro for review finding: "Weekday column headers fail AA contrast in
// light mode (2.76:1)" (styles.css:6-8, --weekday-fg/--weekday-bg; applied
// by .weekday-row span at styles.css:261-263 or thereabouts).
//
// --weekday-fg (#8e8e93 in light mode) is rendered at 12px/700 on top of
// --weekday-bg (#ececf0) for the seven MO-SO column headers that label the
// whole calendar grid. #8e8e93 on #ececf0 measures ~2.76:1, far below the
// WCAG 1.4.3 AA minimum of 4.5:1 for normal text - 12px bold does not
// qualify as "large text" (that threshold only kicks in at 14pt/~18.66px
// bold or 18pt/24px regular), so 4.5:1 applies. Without the weekday labels
// being legible, the grid itself becomes hard to interpret for anyone with
// reduced contrast sensitivity. Dark mode already overrides --weekday-fg to
// #9a9aa0 (6.79:1) and is unaffected.
//
// This test FAILS on current styles.css: both a full axe-core scan flags a
// serious "color-contrast" violation on the .weekday-row spans, and the
// manual WCAG contrast computation on the actual computed colors measures
// below 4.5:1. It should PASS once the light-mode --weekday-fg token is
// darkened (e.g. to ~#5b5b60, per the review's suggestion) without touching
// the dark-mode override.
const { test, expect } = require("@playwright/test");
const AxeBuilder = require("@axe-core/playwright").default;
const assert = require("node:assert/strict");

test.use({ colorScheme: "light", serviceWorkers: "block" });

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

function contrastRatio(colorA, colorB) {
  const lumA = relativeLuminance(parseRgb(colorA));
  const lumB = relativeLuminance(parseRgb(colorB));
  const [lighter, darker] = lumA >= lumB ? [lumA, lumB] : [lumB, lumA];
  return (lighter + 0.05) / (darker + 0.05);
}

const WCAG_AA_NORMAL_TEXT = 4.5;

test("weekday column header labels meet AA text contrast against the weekday band", async ({ page }) => {
  await page.goto("/index.html");
  await page.waitForSelector(".weekday-row span");

  const { spanColor, rowBg, label } = await page.evaluate(() => {
    const row = document.querySelector(".weekday-row");
    const span = row.querySelector("span");
    return {
      spanColor: window.getComputedStyle(span).color,
      rowBg: window.getComputedStyle(row).backgroundColor,
      label: span.textContent,
    };
  });

  const contrast = contrastRatio(spanColor, rowBg);
  console.log("weekday-row span contrast:", contrast, { label, spanColor, rowBg });

  assert.ok(
    contrast >= WCAG_AA_NORMAL_TEXT,
    `BUG: .weekday-row span ("${label}") renders in ${spanColor} on a ${rowBg} weekday band, ` +
      `contrast ${contrast.toFixed(2)}:1 - below the WCAG AA minimum of ${WCAG_AA_NORMAL_TEXT}:1 ` +
      "for normal-size (12px bold is not \"large text\") text. --weekday-fg is too light against " +
      "--weekday-bg in light mode."
  );

  const results = await new AxeBuilder({ page })
    .include(".weekday-row")
    .withTags(["wcag2aa"])
    .analyze();

  const colorContrastViolation = results.violations.find((v) => v.id === "color-contrast");
  expect(
    colorContrastViolation,
    `BUG: axe-core reports a color-contrast violation on .weekday-row: ` +
      `${JSON.stringify(colorContrastViolation, null, 2)}`
  ).toBeUndefined();
});
