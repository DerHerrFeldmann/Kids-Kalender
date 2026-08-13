// Reproduces: "Both people can be given the identical colour, making the
// calendar unreadable, with no warning or reset" (app.js sanitizeSettings()
// lines 287-297, commitSettingField()/wireSettingsInputs() lines 846-879;
// color inputs at index.html lines 128 and 133).
//
// Colour is the *entire* data model of this app: the day-grid cells, the two
// stat-chip dots, the two brush-bar dots and the diagonal "both" split all
// distinguish "Person 1" from "Person 2" purely by which of --p1-color /
// --p2-color they render with. There is no name/initial/pattern fallback.
// Nothing in commitSettingField() (the function every color-picker "input"/
// "change" event runs through) compares the newly picked value against the
// *other* person's currently committed color, so a user can drag Person 2's
// color well to the exact same value as Person 1's (or, just as easily,
// picking two very similar pastels independently) and the app happily
// commits and persists it -- with zero inline hint and no "reset to
// defaults" escape hatch once it happens.
//
// This test opens Einstellungen, sets Person 2's color input to the exact
// value already committed for Person 1, and closes the dialog the same way
// "Fertig" would (dispatching the <dialog> "close" event that closeSettings()
// listens for). It asserts the two committed owner colors are NOT left
// identical. It FAILS on current app.js (the picked duplicate is committed
// verbatim, so p1Color === p2Color) and will PASS once the commit path
// rejects/adjusts a pick that collides with the other person's color (or
// otherwise guarantees the two stay distinguishable).
const { test, expect } = require("@playwright/test");
const assert = require("node:assert");

// The app registers a service worker whose controllerchange handler can
// trigger a page reload; irrelevant here but can race with the dialog
// interaction below in a fresh/incognito context, so keep it out of the way.
test.use({ serviceWorkers: "block" });

test("Person 2's color cannot be committed identical to Person 1's", async ({ page }) => {
  await page.goto("/index.html");

  // Open the settings dialog the same way a user would. Retried once for the
  // same startup-timing jitter noted in the other settings-dialog tests
  // (a static file server + service-worker registration can occasionally
  // land the click before the page's own listener is attached).
  await page.click("#settingsBtn");
  try {
    await page.waitForSelector("#settingsDialog[open]", { timeout: 5000 });
  } catch {
    await page.click("#settingsBtn");
    await page.waitForSelector("#settingsDialog[open]", { timeout: 5000 });
  }

  // Read Person 1's currently committed color (the default, unless changed).
  const p1ColorBefore = await page.evaluate(() => state.settings.p1Color);

  // Drag Person 2's color well to that exact same value, mirroring exactly
  // what wireSettingsInputs()'s "input"/"change" listeners react to.
  await page.evaluate((color) => {
    const input = document.getElementById("p2ColorInput");
    input.value = color;
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.dispatchEvent(new Event("change", { bubbles: true }));
  }, p1ColorBefore);

  // Close the dialog via the real submit button ("Fertig"), which fires the
  // <dialog> "close" event that closeSettings() listens for and that also
  // runs every field through commitSettingField() one more time.
  await page.click('#settingsDialog button[type="submit"]');
  await page.waitForSelector("#settingsDialog[open]", { state: "detached" }).catch(() => {});
  await expect(page.locator("#settingsDialog")).not.toHaveAttribute("open", "");

  const { p1Color, p2Color, p1CssVar, p2CssVar, p1DotBg, p2DotBg } = await page.evaluate(() => ({
    p1Color: state.settings.p1Color,
    p2Color: state.settings.p2Color,
    p1CssVar: document.documentElement.style.getPropertyValue("--p1-color").trim(),
    p2CssVar: document.documentElement.style.getPropertyValue("--p2-color").trim(),
    p1DotBg: window.getComputedStyle(document.getElementById("p1Dot")).backgroundColor,
    p2DotBg: window.getComputedStyle(document.getElementById("p2Dot")).backgroundColor,
  }));

  console.log("Committed colors after collision attempt:", {
    p1Color,
    p2Color,
    p1CssVar,
    p2CssVar,
    p1DotBg,
    p2DotBg,
  });

  assert.notStrictEqual(
    p2Color.toLowerCase(),
    p1Color.toLowerCase(),
    `BUG: Person 2's color was committed identical to Person 1's (${p2Color}). ` +
      "Every owner-identifying element in the UI (day-grid cells, stat-chip dots, " +
      "brush-bar dots, the diagonal 'both' split) encodes ownership purely by " +
      "--p1-color vs --p2-color, so identical colors make the calendar " +
      "completely undecodable, and nothing in commitSettingField()/" +
      "wireSettingsInputs() warns about or rejects the collision."
  );

  // The two brush-bar dots are the most direct, always-visible proof that a
  // parent can actually tell the two people apart; they must not render as
  // the exact same color either.
  assert.notStrictEqual(
    p2DotBg,
    p1DotBg,
    `BUG: the Person 1 and Person 2 brush dots rendered with the identical ` +
      `background color (${p1DotBg}), so the two brush buttons are only ` +
      "distinguishable by their text label, not by color as the rest of the UI assumes."
  );
});
