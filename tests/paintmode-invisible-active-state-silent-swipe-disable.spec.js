// Reproduces: "Mehrfachauswahl-Modus: kaum sichtbarer Aktiv-Zustand und still
// abgeschaltete Wischgeste" (styles.css ~line 90/109 for `.icon-btn.active`,
// and app.js ~line 1272/1285 where the swipe pointerdown handler returns
// early whenever `paintModeActive` is true).
//
// Root cause #1 (invisible "on" state): `.icon-btn.active` only sets
// `background: var(--chip-bg)` (#e9e9ec), which sits on the page background
// `--bg` (#f4f4f6). Those two colors are nearly identical, so the contrast
// ratio between an "armed" #paintModeBtn and its surrounding background is
// far below the 3:1 WCAG 1.4.11 non-text-contrast guideline for UI-component
// state — a user cannot tell paint mode is on by looking at the button.
//
// Root cause #2 (silently disabled gesture): once paint mode is on,
// `initSwipeNavigation`'s pointerdown handler bails out immediately
// (`if (isViewportSliding() || paintModeActive || ...) return;`), so
// horizontal swipe-to-change-month stops working with zero on-screen
// explanation — nothing new becomes visible on the page when the mode is
// toggled on (no hint bar, no banner, nothing beyond the near-invisible
// button background change).
//
// This test FAILS against the current, unfixed code because:
//  - the resolved contrast ratio between the active #paintModeBtn and its
//    background ancestor is well under 3:1;
//  - toggling paint mode on adds no new *visible* text anywhere on the page
//    (confirmed by diffing visible text nodes before/after the toggle),
//    even though swipe-to-change-month is confirmed disabled while it's on.
//
// It should PASS once .icon-btn.active gets a real, higher-contrast
// affordance (e.g. an accent-colored fill/border) AND/OR a persistent,
// visible inline hint explains that swipe is disabled while the mode is on
// (or swipe is kept working instead) — per the finding's recommendation.
const { test, expect } = require("@playwright/test");
const assert = require("node:assert/strict");

test.use({ serviceWorkers: "block" });

test("paint-mode toggle has a visible active state and explains the disabled swipe gesture", async ({ page }) => {
  await page.goto("/index.html");
  await page.evaluate(() => localStorage.clear());
  await page.reload();
  await page.waitForSelector("#paintModeBtn", { state: "visible" });
  await page.waitForSelector("#calendarViewport");

  const paintModeBtn = page.locator("#paintModeBtn");

  // Sanity: starts off.
  await expect(paintModeBtn).toHaveAttribute("aria-pressed", "false");

  // --- Snapshot of visible text BEFORE turning paint mode on --------------
  const visibleTextBefore = await page.evaluate(collectVisibleText);

  // --- Turn Mehrfachauswahl (paint mode) on --------------------------------
  await paintModeBtn.click();
  await expect(paintModeBtn).toHaveAttribute("aria-pressed", "true");
  await expect(paintModeBtn).toHaveClass(/active/);

  // --- Part 1: confirm the gesture really is silently disabled -------------
  const monthTitle = page.locator("#monthTitle");
  const titleBefore = await monthTitle.textContent();

  const viewportBox = await page.locator("#calendarViewport").boundingBox();
  assert.ok(viewportBox, "#calendarViewport must be laid out to drive a swipe");
  const startX = viewportBox.x + viewportBox.width * 0.7;
  const y = viewportBox.y + viewportBox.height / 2;

  await page.mouse.move(startX, y);
  await page.mouse.down();
  await page.mouse.move(startX - 120, y, { steps: 10 });
  await page.mouse.up();
  await page.waitForTimeout(400);

  const titleAfterSwipeAttempt = await monthTitle.textContent();
  assert.equal(
    titleAfterSwipeAttempt,
    titleBefore,
    "sanity check failed: month swipe should be disabled while paint mode is " +
      "active (if it changed, this test isn't exercising the disabled-swipe bug)"
  );

  // --- Part 2: is the "on" state actually visible? -------------------------
  const contrast = await paintModeBtn.evaluate((el) => {
    function parseRgb(str) {
      const m = str.match(/rgba?\(([^)]+)\)/);
      if (!m) return null;
      const [r, g, b, a] = m[1].split(",").map((v) => parseFloat(v));
      if (a === 0) return null;
      return [r, g, b];
    }
    function relLuminance([r, g, b]) {
      const c = [r, g, b].map((v) => v / 255).map((v) => (v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4)));
      return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
    }
    function contrastRatio(rgb1, rgb2) {
      const l1 = relLuminance(rgb1);
      const l2 = relLuminance(rgb2);
      const [a, b] = [Math.max(l1, l2), Math.min(l1, l2)];
      return (a + 0.05) / (b + 0.05);
    }

    const buttonBg = parseRgb(window.getComputedStyle(el).backgroundColor);

    // Walk up to find the nearest ancestor with an actually-opaque
    // background — that's the surface the button visually sits on.
    let node = el.parentElement;
    let ancestorBg = null;
    while (node) {
      const rgb = parseRgb(window.getComputedStyle(node).backgroundColor);
      if (rgb) {
        ancestorBg = rgb;
        break;
      }
      node = node.parentElement;
    }
    if (!ancestorBg) ancestorBg = [244, 244, 246]; // fall back to the known --bg default

    if (!buttonBg) return null; // fully transparent -> definitely no visible affordance
    return contrastRatio(buttonBg, ancestorBg);
  });

  // --- Part 3: did any new, visible hint text appear on screen? -----------
  const visibleTextAfter = await page.evaluate(collectVisibleText);
  const newVisibleText = visibleTextAfter.filter((t) => !visibleTextBefore.includes(t)).join(" | ");

  console.log("active #paintModeBtn contrast vs. background ancestor:", contrast);
  console.log("newly-visible text after enabling paint mode:", JSON.stringify(newVisibleText));

  const hasVisibleActiveAffordance = contrast !== null && contrast >= 3;
  const hasVisibleHint = newVisibleText.trim().length > 0;

  assert.ok(
    hasVisibleActiveAffordance || hasVisibleHint,
    "BUG: turning on Mehrfachauswahl (paint mode) gives the user neither a " +
      `clearly visible "on" state on the toggle button (contrast ratio vs. its ` +
      `background is only ${contrast}, below the 3:1 non-text-contrast ` +
      "guideline) nor any newly-visible hint text on screen explaining that " +
      "month swipe is now disabled — even though swipe was just confirmed to " +
      "silently do nothing while the mode is active."
  );
});

// Collects trimmed text of visible leaf-ish nodes across the whole page:
// elements whose own direct text is non-empty, and that are actually
// rendered (laid out, not display:none/visibility:hidden, non-zero size,
// not clipped to a point the way a purely visual-hidden-for-screen-readers
// utility class would be).
function collectVisibleText() {
  const out = [];
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_ELEMENT);
  let el = walker.currentNode;
  while (el) {
    const ownText = Array.from(el.childNodes)
      .filter((n) => n.nodeType === Node.TEXT_NODE)
      .map((n) => n.textContent.trim())
      .join(" ")
      .trim();
    if (ownText) {
      const cs = window.getComputedStyle(el);
      const rect = el.getBoundingClientRect();
      const visible =
        cs.display !== "none" &&
        cs.visibility !== "hidden" &&
        parseFloat(cs.opacity) > 0 &&
        rect.width > 1 &&
        rect.height > 1;
      if (visible) out.push(ownText);
    }
    el = walker.nextNode();
  }
  return out;
}
