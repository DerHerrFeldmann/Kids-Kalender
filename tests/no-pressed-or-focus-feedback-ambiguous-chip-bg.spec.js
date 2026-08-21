// Repro for review finding: "No pressed or focus state anywhere, and
// `--chip-bg` means 'on' and 'off' simultaneously" (styles.css:~28 and
// surrounding rules for .icon-btn / .icon-btn.active / .brush-btn).
//
// Root cause #1 (no pressed feedback): `* { -webkit-tap-highlight-color:
// transparent; }` (styles.css line ~47) kills the mobile tap flash, and
// nothing puts anything back - there is no `:active` rule anywhere in
// styles.css for `.icon-btn` or `.brush-btn`. So a real, held-down press on
// settings/share/undo/a month arrow changes neither background-color nor
// transform: the button looks 100% identical pressed and unpressed.
//
// Root cause #2 (one token, two opposite meanings): `.icon-btn.active`
// (styles.css ~109) uses `background: var(--chip-bg)` to mean "toggled ON"
// (e.g. the paint-mode button once armed). Meanwhile an *inactive*
// `.brush-btn` (styles.css ~303-311) also resolves to `background:
// var(--chip-bg)` by default - app.js's updateBrushActiveStyles() only sets
// an inline background on the *selected* brush (via `${color}33`) and
// clears the inline style (falls back to the CSS var(--chip-bg) default)
// on the *unselected* one. So the exact same computed background-color
// reads as "armed/on" in the icon bar and "not selected/off" in the brush
// bar, right next to each other on screen.
//
// This test FAILS on the current, unfixed styles.css:
//  - a real mouse-down-and-hold on #shareBtn produces zero change in
//    background-color or transform, even though the browser does apply
//    `:active` (confirmed via `el.matches(':active')`);
//  - the resolved background-color of an *active* `.icon-btn` (paint mode,
//    armed) is bitwise identical to the resolved background-color of an
//    *inactive*, unselected `.brush-btn`.
// It should PASS once a `:active` rule gives buttons real pressed feedback
// (e.g. `background: var(--chip-bg); transform: scale(0.96);`) and the
// inactive brush stops resorting to the same `--chip-bg` token that
// `.icon-btn.active` uses for "on" (e.g. inactive brush becomes
// outlined/transparent instead).
const { test } = require("@playwright/test");
const assert = require("node:assert/strict");

test.use({ serviceWorkers: "block" });

test("pressing an icon button gives visible feedback, and active/inactive states don't share one ambiguous background", async ({ page }) => {
  await page.goto("/index.html");
  await page.waitForSelector("#dayGrid .day-cell");

  // --- Part 1: pressing a button should visibly change it -----------------
  const shareBtn = page.locator("#shareBtn");
  const box = await shareBtn.boundingBox();
  assert.ok(box, "#shareBtn must be visible/laid out to test its pressed state");
  const cx = box.x + box.width / 2;
  const cy = box.y + box.height / 2;

  const readVisualState = () =>
    shareBtn.evaluate((el) => {
      const cs = window.getComputedStyle(el);
      return { bg: cs.backgroundColor, transform: cs.transform };
    });

  const beforePress = await readVisualState();

  await page.mouse.move(cx, cy);
  await page.mouse.down();
  const duringPress = await shareBtn.evaluate((el) => {
    const cs = window.getComputedStyle(el);
    return {
      bg: cs.backgroundColor,
      transform: cs.transform,
      isActive: el.matches(":active"),
    };
  });
  await page.mouse.up();

  // The mousedown+mouseup above is a real click, which now opens #shareDialog
  // (choice between sharing as image vs. as a link) - close it via Escape
  // (leaves dialog.returnValue as "", so no share action fires) before part 2
  // interacts with the rest of the page.
  await page.keyboard.press("Escape");

  assert.ok(
    duringPress.isActive,
    "sanity check failed: a real, held mouse-down on #shareBtn should put it in the :active state " +
      "(otherwise this test isn't exercising the pressed state at all)"
  );

  const changed = duringPress.bg !== beforePress.bg || duringPress.transform !== beforePress.transform;
  assert.ok(
    changed,
    `BUG: pressing #shareBtn produces zero visual feedback - background-color stayed ` +
      `"${beforePress.bg}" and transform stayed "${beforePress.transform}" both before and during a real ` +
      "mouse-down, because there is no :active rule for .icon-btn (only the tap-highlight was removed, " +
      "nothing was put back)."
  );

  // --- Part 2: active .icon-btn vs. inactive .brush-btn must not share ----
  // --- the same background - one token can't mean both "on" and "off" ----
  const paintModeBtn = page.locator("#paintModeBtn");
  await expect_(paintModeBtn, "aria-pressed", "false");
  await paintModeBtn.click();
  await expect_(paintModeBtn, "aria-pressed", "true");
  await expect_class(paintModeBtn, "active");

  const activeIconBtnBg = await paintModeBtn.evaluate((el) => window.getComputedStyle(el).backgroundColor);

  // p2Brush is not the selected brush by default (state.activeBrush starts
  // as "p1"), so it is in its "inactive" visual state.
  const p2Brush = page.locator("#p2Brush");
  const p1Brush = page.locator("#p1Brush");
  const p1Selected = await p1Brush.evaluate((el) => window.getComputedStyle(el).borderColor);
  const p2Selected = await p2Brush.evaluate((el) => window.getComputedStyle(el).borderColor);
  console.log("p1Brush borderColor", p1Selected, "p2Brush borderColor", p2Selected);

  const inactiveBrushBg = await p2Brush.evaluate((el) => window.getComputedStyle(el).backgroundColor);

  console.log("active .icon-btn bg:", activeIconBtnBg, "inactive .brush-btn bg:", inactiveBrushBg);

  assert.notEqual(
    activeIconBtnBg,
    inactiveBrushBg,
    `BUG: an *active/armed* .icon-btn (#paintModeBtn, aria-pressed="true") resolves to the exact same ` +
      `background-color (${activeIconBtnBg}) as an *inactive, unselected* .brush-btn (#p2Brush: ${inactiveBrushBg}). ` +
      "Both come from the same --chip-bg token, so that single token is made to mean 'toggled on' in the " +
      "icon bar and 'not selected' in the brush bar at the same time."
  );
});

// Small local helpers kept inline (no extra expect import needed beyond
// what's used elsewhere in this repo's tests) so this file has no
// dependency surprises.
async function expect_(locator, attr, value) {
  const actual = await locator.getAttribute(attr);
  assert.equal(actual, value, `expected ${attr}="${value}" but got ${attr}="${actual}"`);
}

async function expect_class(locator, className) {
  const classAttr = (await locator.getAttribute("class")) || "";
  assert.ok(
    classAttr.split(/\s+/).includes(className),
    `expected element to have class "${className}", got class="${classAttr}"`
  );
}
