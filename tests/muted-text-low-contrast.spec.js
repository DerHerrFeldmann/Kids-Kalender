// Repro for review finding: "Stats, handover and settings labels fail
// minimum text contrast" (styles.css:~5, --muted: #8e8e93).
//
// --muted (#8e8e93 in light mode) is used for several small/normal-size
// text runs that carry the app's key summary data:
//   - .stat-chip (13px/600) -> the per-person night counts in .stats-row,
//     rendered directly on the page background (--bg: #f4f4f6).
//   - .settings-form label, .group-label, .settings-hint (12px) -> the
//     settings dialog's field labels and data-safety hint, rendered on the
//     white dialog card (--card-bg: #ffffff).
//
// #8e8e93 measures ~2.97:1 against #f4f4f6 and ~3.26:1 against #ffffff -
// both well below the WCAG 1.4.3 AA minimum of 4.5:1 for normal-size text,
// so low-vision users cannot read exactly the information (custody counts,
// field labels, backup hint) they opened the app/settings for.
//
// This test FAILS on current styles.css: contrast of --muted text against
// its actual backgrounds is below 4.5:1 in light mode. It should PASS once
// the light-mode --muted is darkened to at least ~#6b6b70 (per the review's
// recommendation), without needing to touch the dark-mode override.
const { test, expect } = require("@playwright/test");
const assert = require("node:assert/strict");

test.use({ colorScheme: "light", serviceWorkers: "block" });

// Relative luminance + contrast ratio per WCAG 2.x, operating on
// "rgb(r, g, b)" / "rgba(r, g, b, a)" strings as returned by
// getComputedStyle(...).color / backgroundColor.
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

test("muted stat-chip totals stay readable against the page background", async ({ page }) => {
  await page.goto("/index.html");
  await page.waitForSelector(".stats-row .stat-chip");

  const { chipColor, pageBg } = await page.evaluate(() => {
    const chip = document.querySelector(".stats-row .stat-chip");
    return {
      chipColor: window.getComputedStyle(chip).color,
      pageBg: window.getComputedStyle(document.body).backgroundColor,
    };
  });

  const contrast = contrastRatio(chipColor, pageBg);
  console.log("stats-row .stat-chip contrast:", contrast, { chipColor, pageBg });

  assert.ok(
    contrast >= WCAG_AA_NORMAL_TEXT,
    `BUG: .stats-row .stat-chip (per-person night counts) renders in ${chipColor} on a ${pageBg} ` +
      `page background, contrast ${contrast.toFixed(2)}:1 - below the WCAG AA minimum of ` +
      `${WCAG_AA_NORMAL_TEXT}:1 for normal-size text (--muted is too light in light mode).`
  );
});

test("settings dialog group labels and data hint stay readable against the card background", async ({ page }) => {
  await page.goto("/index.html");
  await page.waitForSelector("#settingsBtn");

  await page.evaluate(() => document.getElementById("settingsDialog").showModal());
  await page.waitForSelector(".settings-dialog[open]");

  const { groupLabelColor, hintColor, cardBg } = await page.evaluate(() => {
    const groupLabel = document.querySelector(".settings-dialog .group-label");
    const hint = document.querySelector(".settings-dialog .settings-hint");
    const dialog = document.getElementById("settingsDialog");
    return {
      groupLabelColor: window.getComputedStyle(groupLabel).color,
      hintColor: window.getComputedStyle(hint).color,
      cardBg: window.getComputedStyle(dialog).backgroundColor,
    };
  });

  const groupLabelContrast = contrastRatio(groupLabelColor, cardBg);
  const hintContrast = contrastRatio(hintColor, cardBg);
  console.log("settings .group-label contrast:", groupLabelContrast, { groupLabelColor, cardBg });
  console.log("settings .settings-hint contrast:", hintContrast, { hintColor, cardBg });

  assert.ok(
    groupLabelContrast >= WCAG_AA_NORMAL_TEXT,
    `BUG: .group-label ("Person 1"/"Person 2") renders in ${groupLabelColor} on a ${cardBg} dialog ` +
      `card, contrast ${groupLabelContrast.toFixed(2)}:1 - below the WCAG AA minimum of ` +
      `${WCAG_AA_NORMAL_TEXT}:1 for normal-size text.`
  );
  assert.ok(
    hintContrast >= WCAG_AA_NORMAL_TEXT,
    `BUG: .settings-hint (the backup/data-safety warning) renders in ${hintColor} on a ${cardBg} ` +
      `dialog card, contrast ${hintContrast.toFixed(2)}:1 - below the WCAG AA minimum of ` +
      `${WCAG_AA_NORMAL_TEXT}:1 for normal-size text.`
  );
});

test("note dialog field label stays readable against the card background", async ({ page }) => {
  await page.goto("/index.html");
  await page.waitForSelector("#noteDialog", { state: "attached" });

  await page.evaluate(() => document.getElementById("noteDialog").showModal());
  await page.waitForSelector("#noteDialog[open]");

  const { labelColor, cardBg } = await page.evaluate(() => {
    const label = document.querySelector("#noteDialog .settings-form label");
    const dialog = document.getElementById("noteDialog");
    return {
      labelColor: window.getComputedStyle(label).color,
      cardBg: window.getComputedStyle(dialog).backgroundColor,
    };
  });

  const contrast = contrastRatio(labelColor, cardBg);
  console.log("#noteDialog .settings-form label contrast:", contrast, { labelColor, cardBg });

  assert.ok(
    contrast >= WCAG_AA_NORMAL_TEXT,
    `BUG: .settings-form label ("Notiz") renders in ${labelColor} on a ${cardBg} dialog card, ` +
      `contrast ${contrast.toFixed(2)}:1 - below the WCAG AA minimum of ${WCAG_AA_NORMAL_TEXT}:1 ` +
      "for normal-size text."
  );
});
