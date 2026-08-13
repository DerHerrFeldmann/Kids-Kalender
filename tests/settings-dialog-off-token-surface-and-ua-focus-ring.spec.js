// Repro for review finding: "Dialog surfaces and form fields opt out of the
// token palette and show UA blue focus rings" (styles.css:427-432
// .settings-dialog, styles.css:472-486 settings-form inputs,
// styles.css:161-168 the :focus-visible allow-list).
//
// .settings-dialog only declares border/radius/padding, so its
// background/color fall back to the UA Canvas/CanvasText instead of the
// app's --card-bg/--ink tokens, and .settings-form input[type="text"] never
// sets a background at all, so it keeps the UA field color. In dark mode
// this is measurable: the dialog paints rgb(18,18,18)/rgb(255,255,255)
// instead of the app's --card-bg/--ink of rgb(28,28,30)/rgb(242,242,247),
// and the name input keeps the UA field grey instead of blending with the
// dialog surface - three greys that belong to no token. On top of that,
// the :focus-visible rule at styles.css:165-172 only covers five selectors
// (.icon-btn, .brush-btn, .day-cell, .primary-btn, .secondary-btn) and
// misses the settings text inputs, so focusing #p1NameInput draws
// Chromium's native auto ring (measured outlineColor rgb(153,200,255),
// outlineStyle "auto") - the only saturated blue in an otherwise
// greyscale + pastel UI - instead of the app's 2px ink ring.
//
// This test forces dark color-scheme (where the mismatch is starkest),
// opens the settings dialog, and asserts:
//  1) the dialog's computed background/color equal the --card-bg/--ink
//     tokens (they don't, on the unfixed CSS - it inherits UA Canvas
//     colors instead);
//  2) the name input's computed background differs from a bare, unstyled
//     <input type="text"> (it doesn't, on the unfixed CSS - both resolve
//     to the identical UA field grey, proving no override is applied);
//  3) focusing the name input produces the app's ink-colored, solid
//     focus-visible outline instead of the browser's native "auto" ring.
//
// It FAILS against the current styles.css on all three counts and should
// PASS once .settings-dialog gets `background: var(--card-bg); color:
// var(--ink);`, .settings-form input[type="text"] gets a background that
// is no longer the bare UA default, and the :focus-visible group is
// extended to cover the settings inputs (as well as .text-btn,
// .notes-hint-dismiss and #monthTitle).
const { test, expect } = require("@playwright/test");
const assert = require("node:assert/strict");

test.use({ serviceWorkers: "block", colorScheme: "dark" });

test("settings dialog surface uses the app's --card-bg/--ink tokens, not UA Canvas colors", async ({
  page,
}) => {
  await page.goto("/index.html");
  await page.waitForTimeout(200);
  await page.click("#settingsBtn");
  await page.waitForSelector("#settingsDialog[open]");

  const dialogStyle = await page.evaluate(() => {
    const d = document.getElementById("settingsDialog");
    const cs = getComputedStyle(d);
    return { bg: cs.backgroundColor, color: cs.color };
  });

  const tokenStyle = await page.evaluate(() => {
    const probe = document.createElement("div");
    probe.style.background = "var(--card-bg)";
    probe.style.color = "var(--ink)";
    document.body.appendChild(probe);
    const cs = getComputedStyle(probe);
    const result = { bg: cs.backgroundColor, color: cs.color };
    probe.remove();
    return result;
  });

  console.log("dialog computed style:", dialogStyle, "token computed style:", tokenStyle);

  assert.equal(
    dialogStyle.bg,
    tokenStyle.bg,
    `BUG: #settingsDialog background is ${dialogStyle.bg}, which does not match the ` +
      `--card-bg token (${tokenStyle.bg}) - the dialog fell back to the UA Canvas color ` +
      "instead of using the app's own surface token."
  );
  assert.equal(
    dialogStyle.color,
    tokenStyle.color,
    `BUG: #settingsDialog text color is ${dialogStyle.color}, which does not match the ` +
      `--ink token (${tokenStyle.color}) - the dialog fell back to the UA CanvasText color ` +
      "instead of using the app's own ink token."
  );
});

test("settings name input background is styled, not left at the UA field default", async ({
  page,
}) => {
  await page.goto("/index.html");
  await page.waitForTimeout(200);
  await page.click("#settingsBtn");
  await page.waitForSelector("#settingsDialog[open]");

  const inputBg = await page.evaluate(
    () => getComputedStyle(document.getElementById("p1NameInput")).backgroundColor
  );
  const uaDefaultBg = await page.evaluate(() => {
    const bare = document.createElement("input");
    bare.type = "text";
    document.body.appendChild(bare);
    const bg = getComputedStyle(bare).backgroundColor;
    bare.remove();
    return bg;
  });

  console.log("#p1NameInput background:", inputBg, "bare <input> UA default background:", uaDefaultBg);

  assert.notEqual(
    inputBg,
    uaDefaultBg,
    `BUG: #p1NameInput background (${inputBg}) is identical to an unstyled, bare ` +
      `<input type="text">'s UA default background (${uaDefaultBg}) - the settings form ` +
      "never overrides the field background, so it does not blend with the dialog card " +
      "and instead shows a third, off-palette grey."
  );
});

test("focusing a settings input draws the app's ink focus ring, not Chromium's default blue ring", async ({
  page,
}) => {
  await page.goto("/index.html");
  await page.waitForTimeout(200);
  await page.click("#settingsBtn");
  await page.waitForSelector("#settingsDialog[open]");

  await page.click("#p1NameInput");
  const focusStyle = await page.evaluate(() => {
    const cs = getComputedStyle(document.getElementById("p1NameInput"));
    return {
      outlineStyle: cs.outlineStyle,
      outlineColor: cs.outlineColor,
      outlineWidth: cs.outlineWidth,
    };
  });

  const inkColor = await page.evaluate(() => {
    const probe = document.createElement("div");
    probe.style.color = "var(--ink)";
    document.body.appendChild(probe);
    const color = getComputedStyle(probe).color;
    probe.remove();
    return color;
  });

  console.log("#p1NameInput focus-visible outline:", focusStyle, "--ink token color:", inkColor);

  assert.equal(
    focusStyle.outlineStyle,
    "solid",
    `BUG: #p1NameInput's focus-visible outlineStyle is "${focusStyle.outlineStyle}" ` +
      '(Chromium\'s native "auto" ring), not "solid" - the app\'s :focus-visible rule at ' +
      "styles.css:165-172 does not cover settings text inputs."
  );
  assert.equal(
    focusStyle.outlineColor,
    inkColor,
    `BUG: #p1NameInput's focus-visible outlineColor is ${focusStyle.outlineColor}, the ` +
      `browser's default blue ring, not the app's --ink token color (${inkColor}).`
  );
});
