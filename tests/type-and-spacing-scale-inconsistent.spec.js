// Repro for review finding: "No type or spacing scale - four font sizes
// within a 3px band, ad-hoc gaps" (styles.css, around line 350).
//
// Font sizes run 12/13/14/15/16/20/26, with 13, 14, 15 and 16 each doing a
// separate, unrelated job (.stat-chip, .day-cell .num, .brush-btn,
// .settings-form input[type="text"]/.primary-btn) even though the
// differences are too small to read as a hierarchy. The clearest, most
// mechanical symptom of "no rhythm exists" is .settings-hint's
// `margin: -6px 0 0`, which only exists to claw back part of
// .settings-form's `gap: 14px` flex gap - a negative-margin hack you only
// need when spacing isn't snapped to a shared scale.
//
// This test asserts two things that must both hold once the CSS defines a
// real type/spacing scale (per the recommendation: collapse the 13/14/15/16
// cluster onto ~2 steps, and snap gaps/paddings to a 4px scale so the hint
// no longer needs a negative margin to fight the gap):
//
//   1. Across the four "does its own separate job" elements (.stat-chip,
//      .day-cell .num, .brush-btn, .settings-form input[type="text"]), the
//      number of *distinct* font-sizes in the 12-16px band collapses to at
//      most 2 (currently 4: 13/14/15/16).
//   2. .settings-hint no longer needs a negative top margin to fight the
//      flex gap of its container (.settings-form).
//
// - Current (buggy) styles.css: font-sizes are {13,14,15,16} (4 distinct
//   values) and .settings-hint has `margin-top: -6px`, so this test FAILS.
// - Fixed styles.css: the cluster collapses onto <=2 shared type-scale
//   steps and .settings-hint's margin-top is >= 0 (the hint sits in the
//   same rhythm as its heading instead of fighting the gap), so this test
//   PASSES.
const { test, expect } = require("@playwright/test");
const assert = require("node:assert/strict");

test.use({ viewport: { width: 500, height: 900 }, serviceWorkers: "block" });

test("font-size cluster and settings-hint spacing follow a shared scale instead of ad-hoc values", async ({ page }) => {
  await page.goto("/index.html");
  await page.waitForSelector("#dayGrid .day-cell");

  // --- Part 1: the 13/14/15/16 font-size cluster should collapse ---------
  const fontSize = (selector) =>
    page.locator(selector).first().evaluate((el) => parseFloat(window.getComputedStyle(el).fontSize));

  const statChipSize = await fontSize(".stats-row .stat-chip");
  const dayNumberSize = await fontSize(".day-cell .num");
  const brushBtnSize = await fontSize(".brush-btn");

  await page.evaluate(() => document.getElementById("settingsDialog").showModal());
  const dialogInputSize = await fontSize('.settings-form input[type="text"]');

  const clusterSizes = [statChipSize, dayNumberSize, brushBtnSize, dialogInputSize];
  const distinctInBand = new Set(clusterSizes.filter((s) => s >= 12 && s <= 16));

  console.log("font-size cluster (stat-chip/day-number/brush-btn/dialog-input):", clusterSizes);

  assert.ok(
    distinctInBand.size <= 2,
    `BUG: found ${distinctInBand.size} distinct font-sizes (${[...distinctInBand].sort((a, b) => a - b).join(
      ", "
    )}px) crammed into the 12-16px band across .stat-chip (${statChipSize}px), .day-cell .num (${dayNumberSize}px), ` +
      `.brush-btn (${brushBtnSize}px) and the dialog text input (${dialogInputSize}px) - differences too small to ` +
      "read as hierarchy but large enough to read as inconsistency. A real type scale should collapse these onto " +
      "at most 2 shared steps."
  );

  // --- Part 2: .settings-hint should not need a negative margin to fight -
  // --- its container's flex gap -------------------------------------------
  const hintMarginTop = await page
    .locator(".settings-hint")
    .first()
    .evaluate((el) => parseFloat(window.getComputedStyle(el).marginTop));

  console.log(".settings-hint margin-top:", hintMarginTop);

  assert.ok(
    hintMarginTop >= 0,
    `BUG: .settings-hint has a negative margin-top (${hintMarginTop}px) that exists purely to claw back part of ` +
      ".settings-form's flex `gap` - the tell that spacing isn't snapped to a shared rhythm/scale. Once gaps and " +
      "paddings are snapped to a spacing scale, the hint should sit naturally below its heading without a " +
      "negative-margin hack."
  );

  await expect(page.locator("#settingsDialog")).toBeVisible();
});
