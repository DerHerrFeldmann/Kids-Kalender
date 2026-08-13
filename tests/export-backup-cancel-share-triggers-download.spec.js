// Repro for review finding: "'Sichern' triggers an unwanted second download
// after the user cancels the share sheet, and never confirms success"
// (webapp/app.js, exportBackup(), around lines 1005-1030).
//
// Scenario:
//   1. User opens "Einstellungen" and clicks "Sichern" on a device/browser
//      that supports the Web Share API with files (navigator.canShare
//      returns true).
//   2. navigator.share() opens the native share sheet; the user changes
//      their mind and cancels it. Per spec, navigator.share() rejects with
//      an AbortError in exactly this case (this is not a failure, it's a
//      deliberate cancel).
//   3. exportBackup()'s catch block has no `err.name === "AbortError"`
//      check, so *any* rejection -- including a deliberate cancel -- falls
//      through to the `<a download>` fallback and immediately fires a
//      second, unrequested file download the user never asked for.
//
// This test FAILS on current code: after the mocked navigator.share()
// rejects with an AbortError (simulating the user cancelling the share
// sheet), a "download" event still fires for kinder-kalender-backup.json.
// It should PASS once exportBackup() treats an AbortError as a deliberate
// cancel and returns without falling through to the download link.
const { test, expect } = require("@playwright/test");

test.use({ serviceWorkers: "block" });

test("cancelling the native share sheet must not also trigger a file download", async ({ page }) => {
  await page.goto("/", { waitUntil: "load" });
  await page.evaluate(() => localStorage.clear());
  await page.reload({ waitUntil: "load" });
  await page.waitForFunction(() => document.getElementById("dayGrid").children.length > 0);

  // Simulate a browser/device that supports navigator.share with files
  // (e.g. iOS Safari), where the user opens the share sheet and then
  // deliberately dismisses it -- the standard way to reject in that case
  // is an AbortError, not a generic failure.
  await page.evaluate(() => {
    navigator.canShare = () => true;
    navigator.share = () => Promise.reject(new DOMException("The user aborted a request.", "AbortError"));
  });

  await page.locator("#settingsBtn").click();
  await page.waitForSelector("#settingsDialog[open]");

  let downloadFired = false;
  page.on("download", () => {
    downloadFired = true;
  });

  await page.locator("#exportBtn").click();

  // Give exportBackup()'s share() call (and, on unfixed code, its download
  // fallback) time to run.
  await page.waitForTimeout(500);

  expect(
    downloadFired,
    "BUG: cancelling the native share sheet (navigator.share() rejecting with AbortError) still triggered a " +
      "second, unrequested file download -- cancel should mean cancel, not 'download anyway'"
  ).toBe(false);
});
