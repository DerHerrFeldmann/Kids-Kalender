// Reproduces the review finding: "All top-bar controls are 38x38 px with
// 8 px gaps - below the 44 px touch minimum" (styles.css: .icon-btn ~lines
// 95-107 combined with .icon-btn svg ~lines 170-174 -> 8px padding + 22px
// icon = 38x38 total; .topbar-end ~lines 90-93 has `gap: var(--space-2)`;
// .notes-hint-dismiss ~lines 140-153 has `padding: 0` and inherits the tiny
// `--font-xs` line box).
//
// Root cause: none of the top-bar icon buttons (#settingsBtn, #prevMonth,
// #nextMonth, #paintModeBtn, #undoBtn, #shareBtn) declare a min-width /
// min-height, so their rendered hit target is exactly padding (8px * 2) +
// icon (22px) = 38x38 px in every direction - well under the 44x44 pt Apple
// HIG / WCAG 2.5.5 "Target Size (Minimum)" guideline for a touch-first PWA.
// The right-hand cluster (#paintModeBtn, #undoBtn, #shareBtn) additionally
// sits only 8px apart (`.topbar-end { gap: var(--space-2) }`), so a thumb
// aiming for one control can easily clip a neighbour. The first-run notes
// hint's "Verstanden" dismiss button is worse still: `padding: 0` plus the
// `--font-xs` line box gives it a tiny (~15px tall) hit target for the one
// control a first-time user must hit to clear the banner.
//
// This test FAILS against the current, unfixed code because at least one of
// #settingsBtn / #prevMonth / #nextMonth / #paintModeBtn / #undoBtn /
// #shareBtn / #notesHintDismiss measures under 44px in width or height (in
// practice, all of them do - the icon buttons at 38x38 and the dismiss
// button at roughly 68x15).
//
// It should PASS once .icon-btn gets a min-width/min-height of 44px (and
// .notes-hint-dismiss is given equivalent padding/min-height, or the whole
// hint banner is made tappable), giving every top-bar control a real
// 44x44 px touch target.
const { test, expect } = require("@playwright/test");
const assert = require("node:assert/strict");

const MIN_TOUCH_TARGET = 44;

test.use({
  viewport: { width: 390, height: 844 },
  serviceWorkers: "block",
});

test("top-bar icon buttons and the notes-hint dismiss button meet the 44px touch-target minimum", async ({ page }) => {
  await page.goto("/index.html");
  await page.evaluate(() => localStorage.clear());
  await page.reload();
  await page.waitForSelector("#dayGrid .day-cell");

  // Sanity: the first-run notes hint (and its dismiss button) must actually
  // be visible for this run, otherwise we're not exercising the finding.
  const notesHint = page.locator("#notesHint");
  await expect(notesHint).toBeVisible();
  const notesHintDismiss = page.locator("#notesHintDismiss");
  await expect(notesHintDismiss).toBeVisible();

  const controls = [
    ["#settingsBtn", "Einstellungen (settings) button"],
    ["#prevMonth", "Vorheriger Monat (previous month) button"],
    ["#nextMonth", "Nächster Monat (next month) button"],
    ["#paintModeBtn", "Mehrfachauswahl (paint mode) button"],
    ["#undoBtn", "Rückgängig (undo) button"],
    ["#shareBtn", "Teilen (share) button"],
    ["#notesHintDismiss", "\"Verstanden\" notes-hint dismiss button"],
  ];

  const undersized = [];
  for (const [selector, label] of controls) {
    const box = await page.locator(selector).boundingBox();
    assert.ok(box, `expected ${selector} to be laid out with a bounding box`);
    if (box.width < MIN_TOUCH_TARGET || box.height < MIN_TOUCH_TARGET) {
      undersized.push(`${label} (${selector}): ${box.width.toFixed(1)}x${box.height.toFixed(1)}px`);
    }
  }

  console.log("undersized top-bar controls:", undersized.length ? undersized.join("; ") : "none");

  assert.equal(
    undersized.length,
    0,
    "BUG: the following top-bar controls are smaller than the 44x44px touch-target " +
      `minimum (WCAG 2.5.5 / Apple HIG) in at least one dimension:\n${undersized.join("\n")}`
  );
});
