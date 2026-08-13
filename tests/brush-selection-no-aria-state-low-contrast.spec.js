// Repro for review finding: "Which brush is active is invisible to
// assistive tech and has 1.11:1 visual contrast" (app.js:~444,
// updateBrushActiveStyles).
//
// The Papa/Mama footer buttons (#p1Brush/#p2Brush) form a mutually
// exclusive selector that decides what every calendar tap does, but
// updateBrushActiveStyles() only ever sets inline style.borderColor /
// style.background on the two <button class="brush-btn"> elements - it
// never touches any ARIA attribute (no aria-pressed, no aria-checked, no
// role="radio"/"radiogroup"). A screen reader therefore announces
// "Papa, button" and "Mama, button" identically regardless of which one is
// actually selected.
//
// On top of that, the *only* visual cue for "selected" is a 2px border in
// the person's own color against the button's effective background - e.g.
// Mama's default color #f7dd86 against the page background computes to
// well under the 3:1 WCAG 1.4.11 minimum for a state indicator (the finding
// measured ~1.11:1 against --chip-bg; this test measures it against the
// button's real effective background and gets a similarly-failing ratio).
//
// This test FAILS on the current, unfixed app.js because:
//  - neither #p1Brush nor #p2Brush exposes aria-pressed/aria-checked (or
//    role="radio") reflecting selection at all, so there is nothing for
//    assistive tech to read; and
//  - the computed contrast ratio between the selected button's border color
//    and its effective background is below 3:1.
// It should PASS once updateBrushActiveStyles() also sets an ARIA state
// attribute (e.g. aria-pressed) alongside the colors, and the selected
// style is made contrast-independent (e.g. a var(--ink) outline) so the
// ratio clears 3:1 regardless of the user-chosen person color.
const { test } = require("@playwright/test");
const assert = require("node:assert/strict");

test.use({ serviceWorkers: "block" });

test("selected brush button exposes an ARIA state and meets 3:1 non-text contrast", async ({ page }) => {
  await page.goto("/index.html");
  await page.waitForSelector("#dayGrid .day-cell");

  const p1Brush = page.locator("#p1Brush");
  const p2Brush = page.locator("#p2Brush");

  // --- Part 1: ARIA state must reflect which brush is selected ----------
  // state.activeBrush starts as "p1" (see app.js DEFAULT_STATE), so Papa is
  // selected on load and Mama is not.
  const readAriaState = async (locator) => {
    return locator.evaluate((el) => ({
      role: el.getAttribute("role"),
      ariaPressed: el.getAttribute("aria-pressed"),
      ariaChecked: el.getAttribute("aria-checked"),
    }));
  };

  const isAffirmativelySelected = (s) => s.ariaPressed === "true" || s.ariaChecked === "true";
  const isAffirmativelyUnselected = (s) => s.ariaPressed === "false" || s.ariaChecked === "false";

  const p1StateOnLoad = await readAriaState(p1Brush);
  const p2StateOnLoad = await readAriaState(p2Brush);

  assert.ok(
    isAffirmativelySelected(p1StateOnLoad),
    `BUG: #p1Brush is the active brush on load but exposes no ARIA selected-state ` +
      `(role=${p1StateOnLoad.role}, aria-pressed=${p1StateOnLoad.ariaPressed}, ` +
      `aria-checked=${p1StateOnLoad.ariaChecked}) - a screen reader has no way to tell it is selected.`
  );
  assert.ok(
    isAffirmativelyUnselected(p2StateOnLoad),
    `BUG: #p2Brush is not the active brush on load but exposes no ARIA not-selected-state ` +
      `(role=${p2StateOnLoad.role}, aria-pressed=${p2StateOnLoad.ariaPressed}, ` +
      `aria-checked=${p2StateOnLoad.ariaChecked}) - it reads identically to the selected button.`
  );

  // Switching brushes must flip the ARIA state too, not just the colors.
  await p2Brush.click();
  const p1StateAfter = await readAriaState(p1Brush);
  const p2StateAfter = await readAriaState(p2Brush);
  assert.ok(
    isAffirmativelySelected(p2StateAfter),
    `BUG: after clicking #p2Brush it should become the exposed-as-selected control, but got ` +
      `role=${p2StateAfter.role}, aria-pressed=${p2StateAfter.ariaPressed}, aria-checked=${p2StateAfter.ariaChecked}.`
  );
  assert.ok(
    isAffirmativelyUnselected(p1StateAfter),
    `BUG: after clicking #p2Brush, #p1Brush should become exposed-as-unselected, but got ` +
      `role=${p1StateAfter.role}, aria-pressed=${p1StateAfter.ariaPressed}, aria-checked=${p1StateAfter.ariaChecked}.`
  );

  // --- Part 2: the selected state's visual indicator must clear 3:1 -----
  // (WCAG 1.4.11 non-text contrast, since color/border is the state cue).
  // Re-select Papa so we test against a clean, freshly-applied selected style.
  await p1Brush.click();

  const contrastInfo = await p1Brush.evaluate((el) => {
    function effectiveBackground(node) {
      let cur = node;
      while (cur) {
        const bg = window.getComputedStyle(cur).backgroundColor;
        const m = bg.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)(?:,\s*([\d.]+))?\)/);
        if (m) {
          const alpha = m[4] === undefined ? 1 : parseFloat(m[4]);
          if (alpha > 0) {
            return [parseInt(m[1], 10), parseInt(m[2], 10), parseInt(m[3], 10)];
          }
        }
        cur = cur.parentElement;
      }
      return [255, 255, 255];
    }

    const cs = window.getComputedStyle(el);
    const borderMatch = cs.borderTopColor.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/);
    const borderColor = borderMatch
      ? [parseInt(borderMatch[1], 10), parseInt(borderMatch[2], 10), parseInt(borderMatch[3], 10)]
      : null;
    const outlineMatch = cs.outlineColor && cs.outlineColor.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/);
    const outlineWidth = parseFloat(cs.outlineWidth) || 0;
    // outline-width can report a non-zero used value even when outline-style
    // is "none" (in which case nothing is actually painted) - only count the
    // outline as a real, visible indicator when its style renders something.
    const outlineRenders = outlineWidth > 0 && cs.outlineStyle && cs.outlineStyle !== "none";
    const outlineColor =
      outlineRenders && outlineMatch
        ? [parseInt(outlineMatch[1], 10), parseInt(outlineMatch[2], 10), parseInt(outlineMatch[3], 10)]
        : null;

    return {
      borderTopWidth: cs.borderTopWidth,
      borderColor,
      outlineWidth: cs.outlineWidth,
      outlineColor,
      background: effectiveBackground(el.parentElement || el),
    };
  });

  function srgbToLinear(c) {
    const v = c / 255;
    return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
  }
  function relativeLuminance([r, g, b]) {
    return 0.2126 * srgbToLinear(r) + 0.7152 * srgbToLinear(g) + 0.0722 * srgbToLinear(b);
  }
  function contrastRatio(rgbA, rgbB) {
    const lA = relativeLuminance(rgbA);
    const lB = relativeLuminance(rgbB);
    const lighter = Math.max(lA, lB);
    const darker = Math.min(lA, lB);
    return (lighter + 0.05) / (darker + 0.05);
  }

  // Prefer the outline as the state indicator if one is set (the
  // recommended fix uses `outline: 2px solid var(--ink)`); otherwise fall
  // back to the border, which is what the current implementation uses.
  const indicatorColor = contrastInfo.outlineColor || contrastInfo.borderColor;
  assert.ok(
    indicatorColor,
    "expected the selected #p1Brush to have either a visible outline or a colored border acting as its selected-state indicator"
  );

  const ratio = contrastRatio(indicatorColor, contrastInfo.background);
  assert.ok(
    ratio >= 3,
    `BUG: the selected brush's state indicator color rgb(${indicatorColor.join(", ")}) against its ` +
      `effective background rgb(${contrastInfo.background.join(", ")}) computes to only ${ratio.toFixed(2)}:1, ` +
      "below the 3:1 WCAG 1.4.11 minimum for a non-text state indicator " +
      `(border: ${contrastInfo.borderTopWidth}, outline: ${contrastInfo.outlineWidth}).`
  );
});
