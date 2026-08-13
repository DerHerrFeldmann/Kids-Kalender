// Repro for review finding: "Grid ink is hardcoded dark while the color well
// accepts any hex, so day numbers vanish on user-chosen colors" (styles.css:13
// --grid-ink; styles.css:284-290 `.day-cell:is(.p1,.p2,.both) .num` /
// `.note-dot`; styles.css:305-320 the today ring; fed by app.js:554-555 and
// app.js:868-869 which write whatever hex the user picked in the native
// `<input type="color">` wells straight into --p1-color/--p2-color).
//
// The whole grid's legibility contract assumes the two owner fills stay
// light pastels (the defaults, #a3cf8f / #f7dd86), because `--grid-ink` is a
// hardcoded dark constant (#1c1c1e) used for the day number, the note dot,
// and the today-ring's text color on any painted cell. Einstellungen
// (index.html:128, 133) exposes raw, unconstrained color wells for both
// owners, and every keystroke/pick is written verbatim into
// --p1-color/--p2-color (app.js commitSettingField -> wireSettingsInputs).
// Nothing recomputes the ink to match. So the moment a user picks a dark or
// saturated color for either person (e.g. a deep navy blue for "Papa"), the
// day number rendered on top of that fill goes from #1c1c1e text on
// #1c1c1e-ish text (near-black-on-near-black) - unreadable - with zero
// warning anywhere in the UI.
//
// This test picks a plausible, realistic dark custom color for p1, seeds it
// as this user's committed setting (the same effect as dragging the native
// color wheel, which is what app.js's "input"/"change" handlers persist),
// reloads, assigns a day to p1, and asserts the day number stays readable
// (WCAG AA, >= 4.5:1) against its own painted cell. It FAILS on current
// styles.css/app.js because --grid-ink never adapts, and it will PASS once
// the ink is derived per-owner from the chosen fill's luminance (or the free
// color wells are replaced by a curated set of colors that are all
// guaranteed light enough for the hardcoded dark ink).
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

// A plausible pick from the native color well: a dark navy blue, nowhere
// near as exotic as pure black, well within what any parent could pick.
const CUSTOM_DARK_P1_COLOR = "#2f4f8f";

test("day number stays readable after picking a dark custom owner color in Einstellungen", async ({ page }) => {
  await page.goto("/index.html");

  // Seed a deterministic assignment plus the exact settings state that
  // results from a user dragging the "Papa" color well to a dark navy blue
  // and the dialog's "input"/"change" handlers committing it (app.js
  // commitSettingField -> saveSettings -> setProperty("--p1-color", ...)).
  const dateKey = await page.evaluate(() => {
    const now = new Date();
    const y = now.getFullYear();
    const m = String(now.getMonth() + 1).padStart(2, "0");
    const pad = (d) => String(d).padStart(2, "0");
    return `${y}-${m}-${pad(5)}`;
  });

  await page.evaluate(
    ({ key, color }) => {
      localStorage.setItem("kk.entries", JSON.stringify({ [key]: "p1" }));
      localStorage.setItem("kk.notes", "{}");
      localStorage.setItem("kk.splitOrder", "{}");
      const existing = JSON.parse(localStorage.getItem("kk.settings") || "{}");
      localStorage.setItem(
        "kk.settings",
        JSON.stringify({ ...existing, p1Color: color })
      );
    },
    { key: dateKey, color: CUSTOM_DARK_P1_COLOR }
  );

  await page.reload();
  await page.waitForSelector("#dayGrid .day-cell");

  const p1Cell = page.locator(`.day-cell[data-date="${dateKey}"]`);
  await expect(p1Cell).toHaveClass(/\bp1\b/);

  const { numColor, cellBg } = await p1Cell.evaluate((cell) => {
    const num = cell.querySelector(".num");
    return {
      numColor: window.getComputedStyle(num).color,
      cellBg: window.getComputedStyle(cell).backgroundColor,
    };
  });

  const contrast = contrastRatio(numColor, cellBg);
  console.log(
    "day number vs custom dark p1 fill contrast:",
    contrast,
    { numColor, cellBg, pickedColor: CUSTOM_DARK_P1_COLOR }
  );

  assert.ok(
    contrast >= WCAG_AA_NORMAL_TEXT,
    `BUG: after picking ${CUSTOM_DARK_P1_COLOR} as Papa's color in Einstellungen, the day number ` +
      `on that painted cell has color ${numColor} on background ${cellBg}, contrast ${contrast.toFixed(2)}:1 - ` +
      `below the WCAG AA minimum of ${WCAG_AA_NORMAL_TEXT}:1. The day number's ink comes from the ` +
      "hardcoded --grid-ink constant (styles.css:13), which never adapts to the actually-picked " +
      "fill color, so a dark custom color makes the number nearly invisible."
  );
});
