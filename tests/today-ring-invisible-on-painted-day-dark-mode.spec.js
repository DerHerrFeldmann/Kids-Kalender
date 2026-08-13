// Repro for review finding: "Today's date is invisible in dark mode on any
// painted day" (styles.css:317-320, `.day-cell:is(.p1, .p2, .both).today .num`).
//
// That rule paints the today-ring with `background: var(--grid-ink)`
// (#1c1c1e, a constant that is never redefined in the dark-mode media
// query) and `color: var(--card-bg)`. --card-bg flips to #1c1c1e in dark
// mode (styles.css:35), so once today falls on an owned (.p1/.p2/.both)
// day, the ring's background and the digit's color resolve to the exact
// same #1c1c1e - the ring renders as a solid black blob with no visible
// digit inside it, sitting in the middle of a light green/yellow/split
// cell. This destroys the single most important landmark in the grid
// (where "today" is) exactly when the cell is painted, which is the normal
// case for a filled-in custody calendar.
//
// The existing dark-mode-day-number-contrast.spec.js only seeds ordinary
// (non-today) painted days, so it does not cover this `.today` variant.
//
// This test FAILS on current styles.css: the today-ring's digit color and
// its own ring background resolve to the same RGB value (contrast ~1:1) in
// dark mode when today is assigned to p1/p2/both. It should PASS once the
// ring uses a color pairing that does not depend on a variable (--card-bg)
// that flips with the color scheme (e.g. a constant white/--grid-paper).
const { test, expect } = require("@playwright/test");
const assert = require("node:assert");

test.use({ serviceWorkers: "block" });

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

test("today's ring digit stays visible against its own ring on a painted (p1) day in dark mode", async ({ page }) => {
  await page.emulateMedia({ colorScheme: "dark" });
  await page.goto("/index.html");

  // Assign TODAY to p1 (green fill) so the .today + .p1 rule at
  // styles.css:317-320 is what paints the ring, exactly the "normal" case
  // of a filled-in custody calendar landing on today.
  const todayKey = await page.evaluate(() => {
    const now = new Date();
    const y = now.getFullYear();
    const m = String(now.getMonth() + 1).padStart(2, "0");
    const d = String(now.getDate()).padStart(2, "0");
    return `${y}-${m}-${d}`;
  });

  await page.evaluate((key) => {
    localStorage.setItem("kk.entries", JSON.stringify({ [key]: "p1" }));
    localStorage.setItem("kk.notes", "{}");
    localStorage.setItem("kk.splitOrder", "{}");
  }, todayKey);

  await page.reload();
  await page.waitForSelector("#dayGrid .day-cell");

  const todayCell = page.locator(`.day-cell[data-date="${todayKey}"]`);
  await expect(todayCell).toHaveClass(/\bp1\b/);
  await expect(todayCell).toHaveClass(/\btoday\b/);

  const { numColor, numBg } = await todayCell.evaluate((cell) => {
    const num = cell.querySelector(".num");
    const s = window.getComputedStyle(num);
    return { numColor: s.color, numBg: s.backgroundColor };
  });

  const ringContrast = contrastRatio(numColor, numBg);
  console.log("today+p1 ring digit vs ring background (dark mode):", ringContrast, { numColor, numBg });

  assert.ok(
    ringContrast >= WCAG_AA_NORMAL_TEXT,
    `BUG: today's ring on a .p1 (painted) day in dark mode has digit color ${numColor} on its own ` +
      `ring background ${numBg}, contrast ${ringContrast.toFixed(2)}:1 - below the WCAG AA minimum of ` +
      `${WCAG_AA_NORMAL_TEXT}:1. The ring renders as a solid blob with an invisible digit because ` +
      "--grid-ink (ring background) and --card-bg (digit color) resolve to the same value in dark mode."
  );
});
