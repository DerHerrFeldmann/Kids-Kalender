// Repro for review finding: "Custody ownership is conveyed by fill hue alone,
// and custom colors are never checked for distinguishability" (app.js
// applyOwnerVisual()/describeCell(), app.js:465-482; fills in styles.css:
// 322-340; buildDayCell() at app.js:597-624).
//
// Whether a given day belongs to Person 1, Person 2, or both is rendered
// exclusively as a background fill color (a diagonal split for "both").
// applyOwnerVisual() only ever toggles the "p1"/"p2"/"both" classes and
// writes an aria-label — it never adds any visible letter, initial, glyph,
// icon or pattern to the cell itself. That aria-label helps screen-reader
// users, but does nothing for a *sighted* user who cannot reliably read hue
// (color-vision deficiency, a washed-out/grayscale panel, printed in
// black-and-white, etc.) — a violation of WCAG 1.4.1 "Use of Color", which
// requires that color not be the *only* visual means of conveying
// information.
//
// This test paints one day for Person 1 and a different day for Person 2
// (using two colors deliberately chosen to have the same perceived
// brightness/luminance under a grayscale/color-vision-deficiency simulation,
// so that hue is the *only* thing separating them) and inspects each cell's
// rendered DOM. Aside from the CSS class that drives the background color
// (and the day-of-month digit, which necessarily differs by date), the two
// cells are byte-for-byte identical: same tag structure, no extra text node,
// no icon, no pattern. It FAILS on current app.js because
// buildDayCell()/applyOwnerVisual() render nothing but a bare ".num" digit
// regardless of owner, and it will PASS once ownership is additionally
// conveyed by some non-color cue (e.g. an owner initial or glyph rendered
// inside the cell, as suggested in the review).
const { test, expect } = require("@playwright/test");
const assert = require("node:assert");

test.use({ serviceWorkers: "block" });

// Two colors picked so that R*0.2126 + G*0.7152 + B*0.0722 (the coefficients
// the CSS/Canvas "grayscale" filter and WCAG relative-luminance formula both
// use to collapse RGB to a single perceived-brightness value) come out
// almost identical, even though the hues themselves — a warm gold-brown vs.
// a cool lavender-blue — are obviously different to someone with typical
// color vision. Under any form of hue-blind viewing (grayscale, most color
// vision deficiencies), these two are effectively the same shade of gray.
const P1_COLOR = "#B4963E"; // gold/brown, luma ~150.0
const P2_COLOR = "#7896EE"; // lavender/blue, luma ~150.0

function relativeLuma({ r, g, b }) {
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function hexToRgb(hex) {
  const n = parseInt(hex.slice(1), 16);
  return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
}

test("ownership carries a non-color cue, not just background hue", async ({ page }) => {
  // Sanity-check the fixture colors actually have near-identical luma before
  // relying on them to isolate "hue alone" as the only signal.
  const lumaP1 = relativeLuma(hexToRgb(P1_COLOR));
  const lumaP2 = relativeLuma(hexToRgb(P2_COLOR));
  assert.ok(
    Math.abs(lumaP1 - lumaP2) < 1,
    `fixture colors must be near-equal luma to isolate hue; got ${lumaP1} vs ${lumaP2}`
  );

  await page.goto("/index.html");

  const dateInfo = await page.evaluate(() => {
    const now = new Date();
    const year = now.getFullYear();
    const month = now.getMonth();
    const pad = (n) => String(n).padStart(2, "0");
    const keyFor = (d) => `${year}-${pad(month + 1)}-${pad(d)}`;
    // Two ordinary, non-today days in the currently displayed month.
    const today = now.getDate();
    const dayA = today === 3 ? 4 : 3;
    const dayB = today === 17 ? 18 : 17;
    return { p1Key: keyFor(dayA), p2Key: keyFor(dayB) };
  });

  await page.evaluate(
    ({ p1Key, p2Key, p1Color, p2Color }) => {
      localStorage.setItem("kk.entries", JSON.stringify({ [p1Key]: "p1", [p2Key]: "p2" }));
      localStorage.setItem("kk.notes", "{}");
      localStorage.setItem("kk.splitOrder", "{}");
      const existing = JSON.parse(localStorage.getItem("kk.settings") || "{}");
      localStorage.setItem(
        "kk.settings",
        JSON.stringify({ ...existing, p1Color, p2Color })
      );
    },
    { ...dateInfo, p1Color: P1_COLOR, p2Color: P2_COLOR }
  );

  await page.reload();
  await page.waitForSelector("#dayGrid .day-cell");

  const p1Cell = page.locator(`.day-cell[data-date="${dateInfo.p1Key}"]`);
  const p2Cell = page.locator(`.day-cell[data-date="${dateInfo.p2Key}"]`);
  await expect(p1Cell).toHaveClass(/\bp1\b/);
  await expect(p2Cell).toHaveClass(/\bp2\b/);

  // Describe a cell's rendered content in a way that is deliberately blind to
  // *how* it is colored (class list, inline style, background) and to the
  // day-of-month digit itself (which naturally differs between the two
  // dates), but sensitive to any additional visible cue — extra text nodes,
  // extra child elements (icons, badges), or generated ::before/::after
  // pseudo-element content — that a fix might add to signal ownership.
  const describeVisualCue = (cellHandle) =>
    cellHandle.evaluate((cell) => {
      const num = cell.querySelector(".num");
      const extraChildren = Array.from(cell.children)
        .filter((child) => child !== num)
        .map((child) => ({
          tag: child.tagName,
          className: child.className,
          text: child.textContent.trim(),
        }));
      const before = window.getComputedStyle(cell, "::before").content;
      const after = window.getComputedStyle(cell, "::after").content;
      const numBefore = num ? window.getComputedStyle(num, "::before").content : "none";
      const numAfter = num ? window.getComputedStyle(num, "::after").content : "none";
      return { extraChildren, before, after, numBefore, numAfter };
    });

  const p1Cue = await describeVisualCue(p1Cell);
  const p2Cue = await describeVisualCue(p2Cell);

  console.log("p1 cell visual cue (excluding background color/day digit):", p1Cue);
  console.log("p2 cell visual cue (excluding background color/day digit):", p2Cue);

  assert.notDeepStrictEqual(
    p1Cue,
    p2Cue,
    "BUG: aside from the background-color-driven owner class, the Person 1 and Person 2 " +
      "day cells are visually identical (no extra text node, icon, badge, or pseudo-element " +
      "content differs between them). With two colors of near-identical luminance, a user " +
      "with a color-vision deficiency, or viewing on a grayscale/washed-out display, has no " +
      "way to tell who owns either day — ownership is conveyed by hue alone (WCAG 1.4.1)."
  );
});
