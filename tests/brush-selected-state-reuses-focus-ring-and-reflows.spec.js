// Repro for review finding: "Selected brush stacks four redundant cues and
// reuses the focus-ring treatment" (styles.css:410-418 `.brush-btn[aria-checked="true"]`
// + its `::after` checkmark, styles.css:400 `border: 2px solid transparent`
// on .brush-btn, styles.css:161-168 the shared `:focus-visible` rule, and
// app.js:452/510 the inline `${color}33` background injection).
//
// One binary state (selected brush) is signalled four times at once: an
// outline, an inline-injected background tint, a font-weight bump
// (600 -> 700), and a literal "✓" appended via ::after. This has two
// concrete, testable consequences on the *unfixed* code:
//
//  (a) `.brush-btn[aria-checked="true"] { outline: 2px solid var(--ink); }`
//      is computed-style-identical (same `outline` shorthand: width, style,
//      color) to the app's own shared `:focus-visible` rule
//      (`outline: 2px solid var(--ink);`). So a *selected-but-unfocused*
//      brush and a *focused-but-unselected* brush render the exact same
//      outline - "selected" and "keyboard-focused" are visually
//      indistinguishable by that cue alone.
//  (b) The font-weight bump (600 -> 700) and the "✓" glyph appended via
//      `::after` both change the button's rendered width, so toggling
//      selection reflows the brush bar (the button grows and can crowd its
//      neighbour) purely from a state that carries no layout information.
//
// Both should disappear once the fix lands: drop the outline (reserve
// `outline` exclusively for `:focus-visible`), drop the ::after checkmark,
// and keep font-weight constant - leaving only the already-reserved
// `border-color`/background tint as the single "selected" cue, per the
// suggested fix (`.brush-btn[aria-checked="true"] { border-color: var(--ink);
// background: <tint>; }`).
const { test } = require("@playwright/test");
const assert = require("node:assert/strict");

test.use({ serviceWorkers: "block" });

test("selected brush must not reuse the focus-visible outline, and toggling selection must not reflow the button", async ({ page }) => {
  await page.goto("/index.html");
  await page.waitForSelector("#dayGrid .day-cell");

  const p1Brush = page.locator("#p1Brush");
  const p2Brush = page.locator("#p2Brush");

  // Sanity: state.activeBrush starts as "p1", so p1Brush is selected and
  // p2Brush is not, and neither has keyboard focus yet.
  assert.equal(await p1Brush.getAttribute("aria-checked"), "true");
  assert.equal(await p2Brush.getAttribute("aria-checked"), "false");

  // --- (a) selected-but-unfocused vs. focused-but-unselected outline -----
  const selectedUnfocusedOutline = await p1Brush.evaluate((el) => window.getComputedStyle(el).outline);

  await p2Brush.focus();
  const focusedMatches = await p2Brush.evaluate((el) => el.matches(":focus-visible"));
  assert.ok(
    focusedMatches,
    "sanity check failed: focusing #p2Brush should put it in :focus-visible " +
      "(otherwise this test isn't exercising the focus-ring rule at all)"
  );
  const focusedUnselectedOutline = await p2Brush.evaluate((el) => window.getComputedStyle(el).outline);

  assert.notEqual(
    selectedUnfocusedOutline,
    focusedUnselectedOutline,
    `BUG: the selected-but-unfocused #p1Brush has outline "${selectedUnfocusedOutline}", which is identical to ` +
      `the focused-but-unselected #p2Brush's outline "${focusedUnselectedOutline}". "Selected" reuses the exact ` +
      "same outline the app already uses to mean 'keyboard-focused' (styles.css .brush-btn[aria-checked=\"true\"] " +
      "vs. the shared :focus-visible rule), so the two states are visually indistinguishable."
  );

  // --- (b) toggling selection must not change the button's rendered size -
  const boxBefore = await p2Brush.evaluate((el) => el.getBoundingClientRect().width);
  await p2Brush.click(); // selects p2, deselects p1
  assert.equal(await p2Brush.getAttribute("aria-checked"), "true");
  const boxAfter = await p2Brush.evaluate((el) => el.getBoundingClientRect().width);

  assert.equal(
    boxBefore,
    boxAfter,
    `BUG: #p2Brush changed width from ${boxBefore}px to ${boxAfter}px purely by becoming selected - the ` +
      "font-weight bump (600 -> 700) and/or the ::after \"✓\" checkmark reflow the label, so a state that " +
      "carries no layout information visibly resizes the button and crowds its neighbour in the brush bar."
  );
});
