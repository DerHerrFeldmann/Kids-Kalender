// Repro for review finding: "Day cells - the app's primary control - have
// no pressed state, so the 500 ms long-press gives zero feedback"
// (styles.css: the global `* { -webkit-tap-highlight-color: transparent; }`
// reset at ~line 47, plus the only `:active` rule in the file,
// `.icon-btn:active, .brush-btn:active` at ~lines 164-168, which does not
// list `.day-cell`; the 500 ms note-dialog timer is scheduled in app.js's
// per-cell `pointerdown` handler inside render(), ~lines 663-675).
//
// A day cell is a <button class="day-cell"> and is by far the most-touched
// control in the app: a plain tap paints it, and holding it down for
// 500 ms opens the note dialog. Because `.icon-btn`/`.brush-btn` got a
// pressed `:active` rule in an earlier pass but `.day-cell` never did (and
// the platform's own tap-highlight was globally switched off), a day cell
// looks 100% identical whether or not it is currently being pressed - both
// for a quick tap and for the entire 500 ms leading up to the long-press
// note dialog. There is no growing/pressed cue anywhere in that half a
// second, which is exactly the window where an unsure user gives up and
// lifts their finger early.
//
// This test FAILS on the current, unfixed styles.css: a real, held
// mouse-down on an untouched day-cell (confirmed via `el.matches(':active')`)
// produces zero change in background-color, transform, box-shadow or
// filter versus the unpressed cell - even though the very same held press
// on `#settingsBtn` (an `.icon-btn`) visibly darkens/scales it. It should
// PASS once a `.day-cell:active` rule (or equivalent long-press progress
// cue) gives the day cell a real, visible pressed state distinct from its
// resting state.
const { test } = require("@playwright/test");
const assert = require("node:assert/strict");

test.use({ serviceWorkers: "block" });

test("holding down a day-cell gives visible pressed feedback, matching other controls", async ({ page }) => {
  await page.goto("/index.html");
  await page.waitForSelector("#dayGrid .day-cell");

  const dayCell = page.locator("#dayGrid .day-cell").first();
  const cellBox = await dayCell.boundingBox();
  assert.ok(cellBox, "a .day-cell must be visible/laid out to test its pressed state");
  const cellCx = cellBox.x + cellBox.width / 2;
  const cellCy = cellBox.y + cellBox.height / 2;

  const readVisualState = (locator) =>
    locator.evaluate((el) => {
      const cs = window.getComputedStyle(el);
      return {
        bg: cs.backgroundColor,
        transform: cs.transform,
        boxShadow: cs.boxShadow,
        filter: cs.filter,
      };
    });

  const before = await readVisualState(dayCell);

  // Hold well under the 500 ms long-press threshold, so the note dialog
  // never opens and we're purely observing the "pressed but not yet a
  // long-press" state - the exact window a user sits in before deciding
  // whether to keep holding.
  await page.mouse.move(cellCx, cellCy);
  await page.mouse.down();
  await page.waitForTimeout(150);

  const during = await dayCell.evaluate((el) => {
    const cs = window.getComputedStyle(el);
    return {
      bg: cs.backgroundColor,
      transform: cs.transform,
      boxShadow: cs.boxShadow,
      filter: cs.filter,
      isActive: el.matches(":active"),
    };
  });
  await page.mouse.up();

  assert.ok(
    during.isActive,
    "sanity check failed: a real, held mouse-down on the day-cell should put it in the :active state " +
      "(otherwise this test isn't exercising the pressed state at all)"
  );

  const changed =
    during.bg !== before.bg ||
    during.transform !== before.transform ||
    during.boxShadow !== before.boxShadow ||
    during.filter !== before.filter;

  assert.ok(
    changed,
    "BUG: holding down a .day-cell produces zero visual feedback - background-color stayed " +
      `"${before.bg}", transform stayed "${before.transform}", box-shadow stayed "${before.boxShadow}" and ` +
      `filter stayed "${before.filter}" both before and during a real, held mouse-down, throughout the whole ` +
      "500 ms window leading up to the long-press note dialog. There is no `:active` rule for `.day-cell` in " +
      "styles.css, so a user gets no cue that their press has registered at all."
  );

  // Cross-check against a control that *does* get pressed feedback, to show
  // the day-cell isn't just "subtle" but is genuinely inconsistent with the
  // rest of the app's own controls.
  const settingsBtn = page.locator("#settingsBtn");
  const settingsBox = await settingsBtn.boundingBox();
  assert.ok(settingsBox, "#settingsBtn must be visible/laid out for the cross-check");
  const beforeSettings = await readVisualState(settingsBtn);

  await page.mouse.move(settingsBox.x + settingsBox.width / 2, settingsBox.y + settingsBox.height / 2);
  await page.mouse.down();
  const duringSettings = await readVisualState(settingsBtn);
  await page.mouse.up();

  const settingsChanged =
    duringSettings.bg !== beforeSettings.bg ||
    duringSettings.transform !== beforeSettings.transform ||
    duringSettings.boxShadow !== beforeSettings.boxShadow ||
    duringSettings.filter !== beforeSettings.filter;

  assert.ok(
    settingsChanged,
    "expected #settingsBtn (.icon-btn) to visibly change when pressed - if this fails too, the app's " +
      "pressed-state styling has regressed generally, not just for day cells"
  );
});
