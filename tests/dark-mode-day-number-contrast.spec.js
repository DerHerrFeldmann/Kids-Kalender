// Repro for review finding: "Painted day numbers become invisible in dark
// mode" (styles.css:~201, .day-cell .num; and styles.css:190, .note-dot).
//
// Root cause: `.day-cell .num` is colored with `var(--ink)`, which flips
// from #1c1c1e (light) to #f2f2f7 (near-white) under
// `@media (prefers-color-scheme: dark)`. But the day-cell fills for
// assigned days (.p1 -> --p1-color #a3cf8f, .p2 -> --p2-color #f7dd86,
// .both -> a mix of both) stay the same light pastel colors in BOTH
// schemes - they never darken. So in dark mode, a near-white number sits on
// a light-green/light-yellow background, landing at roughly 1.4:1 (green)
// and 1.2:1 (yellow) contrast - far below WCAG's 4.5:1 minimum for normal
// text - making the date unreadable on every day that actually has custody
// assigned, which is the app's primary/most important information.
// Similarly `.note-dot` is hardcoded to #1c1c1e, which is exactly the
// dark-mode `--card-bg` used by every *unpainted* `.day-cell` - so a note
// dot on an unassigned day disappears into its own cell background in dark
// mode and reads as a bare white ring (its box-shadow) instead of a dot.
//
// This test FAILS on current styles.css: contrast of the painted-day number
// against its cell background is far below 4.5:1 in dark mode. It should
// PASS once painted cells stop inheriting the flipped global --ink (e.g. by
// introducing a constant --grid-ink used for `.day-cell.p1 .num`,
// `.day-cell.p2 .num`, `.day-cell.both .num`, and `.note-dot`).
const { test, expect } = require("@playwright/test");
const assert = require("node:assert");

test.use({ serviceWorkers: "block" });

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

test("painted day numbers stay readable against their cell fill in dark mode", async ({ page }) => {
  await page.emulateMedia({ colorScheme: "dark" });
  await page.goto("/index.html");

  // Seed deterministic custody assignments for the currently displayed
  // month: day 5 -> p1 (green fill), day 6 -> p2 (yellow fill), day 7 ->
  // both (split fill), day 6 also gets a note so we can check .note-dot.
  const dateKeys = await page.evaluate(() => {
    const now = new Date();
    const y = now.getFullYear();
    const m = String(now.getMonth() + 1).padStart(2, "0");
    const pad = (d) => String(d).padStart(2, "0");
    return {
      p1: `${y}-${m}-${pad(5)}`,
      p2: `${y}-${m}-${pad(6)}`,
      both: `${y}-${m}-${pad(7)}`,
      // Left unassigned ("none") on purpose: this is where the note-dot bug
      // shows, since an unpainted cell's background is --card-bg (#1c1c1e
      // in dark mode) - the same hardcoded color as the dot itself.
      none: `${y}-${m}-${pad(8)}`,
    };
  });

  await page.evaluate((keys) => {
    localStorage.setItem(
      "kk.entries",
      JSON.stringify({ [keys.p1]: "p1", [keys.p2]: "p2", [keys.both]: "both" })
    );
    localStorage.setItem("kk.notes", JSON.stringify({ [keys.none]: "Zahnarzt" }));
    localStorage.setItem("kk.splitOrder", JSON.stringify({}));
  }, dateKeys);

  await page.reload();
  await page.waitForSelector("#dayGrid .day-cell");

  const p1Cell = page.locator(`.day-cell[data-date="${dateKeys.p1}"]`);
  const p2Cell = page.locator(`.day-cell[data-date="${dateKeys.p2}"]`);
  const bothCell = page.locator(`.day-cell[data-date="${dateKeys.both}"]`);

  await expect(p1Cell).toHaveClass(/\bp1\b/);
  await expect(p2Cell).toHaveClass(/\bp2\b/);
  await expect(bothCell).toHaveClass(/\bboth\b/);

  const readContrast = async (cellLocator) =>
    cellLocator.evaluate((cell) => {
      const num = cell.querySelector(".num");
      const numColor = window.getComputedStyle(num).color;
      const cellBg = window.getComputedStyle(cell).backgroundColor;
      return { numColor, cellBg };
    });

  const p1Colors = await readContrast(p1Cell);
  const p2Colors = await readContrast(p2Cell);
  const bothColors = await readContrast(bothCell);

  const p1Contrast = contrastRatio(p1Colors.numColor, p1Colors.cellBg);
  const p2Contrast = contrastRatio(p2Colors.numColor, p2Colors.cellBg);
  const bothContrast = contrastRatio(bothColors.numColor, bothColors.cellBg);

  console.log("dark mode contrast - p1:", p1Contrast, p1Colors, "p2:", p2Contrast, p2Colors, "both:", bothContrast, bothColors);

  assert.ok(
    p1Contrast >= WCAG_AA_NORMAL_TEXT,
    `BUG: day number on a .p1 (green) cell in dark mode has contrast ${p1Contrast.toFixed(2)}:1 ` +
      `(color=${p1Colors.numColor} on bg=${p1Colors.cellBg}), below the WCAG AA minimum of ${WCAG_AA_NORMAL_TEXT}:1 ` +
      "(day number follows the flipped global --ink while the cell fill stays the same light pastel)"
  );
  assert.ok(
    p2Contrast >= WCAG_AA_NORMAL_TEXT,
    `BUG: day number on a .p2 (yellow) cell in dark mode has contrast ${p2Contrast.toFixed(2)}:1 ` +
      `(color=${p2Colors.numColor} on bg=${p2Colors.cellBg}), below the WCAG AA minimum of ${WCAG_AA_NORMAL_TEXT}:1`
  );
  assert.ok(
    bothContrast >= WCAG_AA_NORMAL_TEXT,
    `BUG: day number on a .both (split) cell in dark mode has contrast ${bothContrast.toFixed(2)}:1, ` +
      `below the WCAG AA minimum of ${WCAG_AA_NORMAL_TEXT}:1`
  );

  // The note dot on an unpainted cell must also stay visible in dark mode.
  // It's hardcoded to #1c1c1e, which is exactly the dark-mode --card-bg
  // (the background of any unpainted .day-cell), so it disappears into its
  // own cell and reads as a bare white ring (from its box-shadow) instead
  // of a filled dot.
  const noneCell = page.locator(`.day-cell[data-date="${dateKeys.none}"]`);
  await expect(noneCell).not.toHaveClass(/\b(p1|p2|both)\b/);

  const dotColors = await noneCell.evaluate((cell) => {
    const dot = cell.querySelector(".note-dot");
    return {
      dotColor: window.getComputedStyle(dot).backgroundColor,
      cellBg: window.getComputedStyle(cell).backgroundColor,
    };
  });
  const dotContrast = contrastRatio(dotColors.dotColor, dotColors.cellBg);
  console.log("dark mode note-dot contrast on unpainted cell:", dotContrast, dotColors);
  assert.ok(
    dotContrast >= 1.5,
    `BUG: .note-dot on an unpainted cell in dark mode has contrast ${dotContrast.toFixed(2)}:1 ` +
      `(dot=${dotColors.dotColor} on bg=${dotColors.cellBg}) against its own cell, essentially invisible`
  );
});
