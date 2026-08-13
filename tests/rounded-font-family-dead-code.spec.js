// Repro for review finding: "The intended rounded typeface never loads; the
// UI falls back to plain system default" (styles.css:~49, `html, body`).
//
// Root cause: the declared stack is
//   -apple-system, BlinkMacSystemFont, "SF Pro Rounded", sans-serif
// `-apple-system` is a *generic* CSS keyword that the browser always
// resolves to the platform's default UI font on every Apple platform - it
// never fails to match, so the engine never falls through to the third
// entry. `"SF Pro Rounded"` is therefore dead code: it can only ever be
// picked if a browser doesn't understand `-apple-system` at all, which
// defeats the point of listing it as a deliberate typographic choice. The
// same dead ordering (rounded face listed after -apple-system) is mirrored
// in the canvas export font strings in app.js.
//
// This test FAILS on the current styles.css: the computed `font-family`
// list has `-apple-system` before any rounded-capable family ("ui-rounded"
// or "SF Pro Rounded"), so the rounded family can never win. It should PASS
// once the stack is reordered so a rounded-capable generic/face (e.g.
// `ui-rounded, "SF Pro Rounded", -apple-system, BlinkMacSystemFont,
// sans-serif`) comes first.
const { test, expect } = require("@playwright/test");
const assert = require("node:assert");

test.use({ serviceWorkers: "block" });

// getComputedStyle().fontFamily returns the author-specified family list
// as CSS text (browsers do not resolve it down to "the one font that would
// actually be used"), e.g.:
//   -apple-system, BlinkMacSystemFont, "SF Pro Rounded", sans-serif
// so we can inspect the *order* of entries directly - which is exactly
// where this bug lives.
function parseFontFamilyList(fontFamily) {
  return fontFamily
    .split(",")
    .map((s) => s.trim().replace(/^["']|["']$/g, "").toLowerCase());
}

test("rounded typeface is not shadowed by -apple-system in the font stack", async ({ page }) => {
  await page.goto("/index.html");

  const fontFamily = await page.evaluate(
    () => window.getComputedStyle(document.body).fontFamily
  );

  const families = parseFontFamilyList(fontFamily);
  console.log("computed body font-family list:", families);

  const roundedIndex = families.findIndex(
    (f) => f === "ui-rounded" || f === "sf pro rounded"
  );
  const appleSystemIndex = families.indexOf("-apple-system");
  const blinkIndex = families.indexOf("blinkmacsystemfont");

  assert.ok(
    roundedIndex !== -1,
    `no rounded-capable family ("ui-rounded" or "SF Pro Rounded") found in font-family stack: ${fontFamily}`
  );

  if (appleSystemIndex !== -1) {
    assert.ok(
      roundedIndex < appleSystemIndex,
      `BUG: "-apple-system" (index ${appleSystemIndex}) appears before the rounded-capable family ` +
        `(index ${roundedIndex}) in "${fontFamily}". -apple-system always resolves on Apple ` +
        "platforms, so it shadows the rounded face and the app silently renders in stock SF " +
        "instead of the intended rounded, soft look."
    );
  }
  if (blinkIndex !== -1) {
    assert.ok(
      roundedIndex < blinkIndex,
      `BUG: "BlinkMacSystemFont" (index ${blinkIndex}) appears before the rounded-capable family ` +
        `(index ${roundedIndex}) in "${fontFamily}", so the rounded face can never be selected.`
    );
  }
});
