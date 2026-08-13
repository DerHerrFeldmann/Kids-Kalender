// Repro for review finding: "'Notiz löschen' red text fails AA contrast in
// light mode" (styles.css:552-554, .danger-btn { color: #ff3b30 },
// applied to #noteDeleteBtn / index.html:161).
//
// .danger-btn is styled as bare text (.text-btn: no background, no
// border), so its red color is the *only* visual cue that "Notiz löschen"
// is a button at all, and the only destructive control in the app. In
// light mode it renders as rgb(255,59,48) on the dialog's white
// background (rgb(255,255,255)) at font-size var(--font-sm) = 14px, which
// measures ~3.55:1 - below the WCAG 1.4.3 AA minimum of 4.5:1 for
// normal-size text. Dark mode is fine (the same red on the UA dark canvas
// measures ~5.28:1), so this is specifically a light-mode regression.
//
// This test FAILS on current styles.css: contrast of #noteDeleteBtn's
// text color against the note dialog's background is below 4.5:1 in
// light mode. It should PASS once the light-mode danger color is darkened
// (e.g. to a --danger token like #d70015, ~5.3:1 on white) without
// breaking the existing dark-mode contrast.
const { test } = require("@playwright/test");
const assert = require("node:assert/strict");

test.use({ colorScheme: "light", serviceWorkers: "block" });

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

test("'Notiz löschen' button text stays readable against the note dialog background in light mode", async ({
  page,
}) => {
  await page.goto("/index.html");
  await page.waitForSelector("#noteDialog", { state: "attached" });

  await page.evaluate(() => document.getElementById("noteDialog").showModal());
  await page.waitForSelector("#noteDialog[open]");

  const { deleteBtnColor, dialogBg, fontSize } = await page.evaluate(() => {
    const btn = document.getElementById("noteDeleteBtn");
    const dialog = document.getElementById("noteDialog");
    const style = window.getComputedStyle(btn);
    return {
      deleteBtnColor: style.color,
      dialogBg: window.getComputedStyle(dialog).backgroundColor,
      fontSize: style.fontSize,
    };
  });

  const contrast = contrastRatio(deleteBtnColor, dialogBg);
  console.log("#noteDeleteBtn contrast:", contrast, { deleteBtnColor, dialogBg, fontSize });

  assert.ok(
    contrast >= WCAG_AA_NORMAL_TEXT,
    `BUG: #noteDeleteBtn ("Notiz löschen") renders in ${deleteBtnColor} at ${fontSize} on a ` +
      `${dialogBg} dialog background, contrast ${contrast.toFixed(2)}:1 - below the WCAG AA ` +
      `minimum of ${WCAG_AA_NORMAL_TEXT}:1 for normal-size text. Since this button has no ` +
      "background/border (.text-btn), its color is the only affordance that it is a button " +
      "at all, and it is the only destructive control in the app."
  );
});
