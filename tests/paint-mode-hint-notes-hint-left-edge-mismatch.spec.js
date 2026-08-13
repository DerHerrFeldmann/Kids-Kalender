// Repro for review finding: "Two identically-styled hint banners align to
// different left edges" (styles.css:127-145, .paint-mode-hint / .notes-hint).
//
// #paintModeHint (markup: index.html:70) sits as a direct sibling of <main>,
// so it only inherits its own `margin: 0 var(--space-4) var(--space-2)`
// (16px) from .paint-mode-hint.
//
// #notesHint (markup: index.html:81-84) sits *inside* <main>, and <main> has
// its own `padding: 0 var(--space-4)` (styles.css:183-188). Since .notes-hint
// carries the exact same 16px margin rule, that margin stacks on top of
// main's 16px padding, pushing #notesHint's left edge in by 32px total
// instead of 16px.
//
// Both hints can be visible at the same time (paint mode toggled on before
// the one-time notes hint has been dismissed), and then two banners that are
// byte-for-byte identical in every declared style (background, padding,
// font-size, border-radius) sit at two different left edges / widths, which
// reads as a layout bug rather than a deliberate choice.
//
// - Current (buggy) styles.css + index.html: #notesHint's left edge sits
//   16px further right (and is 16px narrower) than #paintModeHint's, so this
//   test FAILS.
// - Fixed markup/CSS (e.g. moving #paintModeHint inside <main>, or sharing a
//   single `.hint` class with no built-in horizontal margin): both hints
//   align to the same left edge and this test PASSES.
const { test } = require("@playwright/test");
const assert = require("node:assert/strict");

test.use({ viewport: { width: 500, height: 900 }, serviceWorkers: "block" });

test("paint-mode hint and notes hint share the same left edge when both are visible", async ({ page }) => {
  await page.goto("/index.html");

  // Make sure the one-time notes hint hasn't been dismissed in a previous run.
  await page.evaluate(() => localStorage.removeItem("kk.notesHintDismissed"));
  await page.reload();
  await page.waitForSelector("#dayGrid .day-cell");

  const notesHint = page.locator("#notesHint");
  await notesHint.waitFor({ state: "visible" });

  // Turn paint mode on so #paintModeHint becomes visible alongside it.
  await page.locator("#paintModeBtn").click();
  const paintModeHint = page.locator("#paintModeHint");
  await paintModeHint.waitFor({ state: "visible" });

  const paintModeBox = await paintModeHint.boundingBox();
  const notesBox = await notesHint.boundingBox();

  assert.ok(paintModeBox && notesBox, "expected both hint banners to have a bounding box");

  console.log("paint-mode hint box:", paintModeBox, "notes hint box:", notesBox);

  assert.equal(
    paintModeBox.x,
    notesBox.x,
    `BUG: #paintModeHint and #notesHint use identical CSS declarations but align to different left ` +
      `edges (paintModeHint.x=${paintModeBox.x}, notesHint.x=${notesBox.x}) because #notesHint sits inside ` +
      "<main>'s horizontal padding while #paintModeHint's own margin is the only inset it gets."
  );
});
