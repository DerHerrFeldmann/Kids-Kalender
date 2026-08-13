// Repro for review finding: "Sichern / Wiederherstellen / Teilen geben keine
// Erfolgs- oder Fehlermeldung" (webapp/app.js, handleRestoreFile, around
// line 969-980).
//
// Scenario:
//   1. User opens "Einstellungen" and clicks "Wiederherstellen", picking a
//      well-formed backup file that differs from the currently loaded data.
//   2. The file parses fine, passes the validation checks, and the user
//      confirms the "replace current data?" confirm() prompt.
//   3. handleRestoreFile() replaces state.entries/notes/splitOrder/settings,
//      persists them, calls populateSettingsForm(), and finally render()
//      (app.js:~979-980) -- but it never closes the still-open
//      #settingsDialog, and there is no success/error toast anywhere in the
//      app. Since the settings <dialog> is a native modal that renders on
//      top of everything (its ::backdrop covers the whole viewport, see
//      styles.css .settings-dialog::backdrop), the freshly re-rendered
//      calendar behind it is completely invisible, and the user is given no
//      other indication that the restore actually happened.
//
// This test FAILS on current code: after confirming the restore, the
// #settingsDialog is still open (still has the `open` attribute) and no
// success message of any kind is shown, even though the restore succeeded
// and the in-memory calendar was in fact updated behind it.
// It should PASS once handleRestoreFile() closes the settings dialog after
// a successful restore (and/or surfaces an explicit success message), so
// the refreshed calendar becomes visible to the user.
const { test } = require("@playwright/test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

test.use({ serviceWorkers: "block" });

test("a successful restore closes the settings dialog / gives visible feedback", async ({ page }) => {
  const dialogs = [];
  page.on("dialog", async (dialog) => {
    dialogs.push({ type: dialog.type(), message: dialog.message() });
    await dialog.accept();
  });

  const pageErrors = [];
  page.on("pageerror", (err) => pageErrors.push(err));

  await page.goto("/", { waitUntil: "load" });
  await page.evaluate(() => localStorage.clear());
  await page.reload({ waitUntil: "load" });
  await page.waitForFunction(() => document.getElementById("dayGrid").children.length > 0);

  // A normal, well-formed backup with data clearly different from the
  // freshly-cleared state above, so the restore is a real, visible change.
  const backup = {
    version: 2,
    entries: { "2026-08-15": "p2" },
    notes: {},
    splitOrder: {},
    settings: { p1Name: "Papa", p2Name: "Mama", p1Color: "#a3cf8f", p2Color: "#f7dd86" },
  };
  const backupPath = path.join(os.tmpdir(), `kk-backup-dialog-${Date.now()}.json`);
  fs.writeFileSync(backupPath, JSON.stringify(backup));

  await page.locator("#settingsBtn").click();
  await page.waitForSelector("#settingsDialog[open]");
  await page.locator("#restoreBtn").click();
  await page.locator("#restoreInput").setInputFiles(backupPath);

  // Give the confirm() dialog (auto-accepted above) and the subsequent
  // FileReader onload/persistence/render work a moment to run.
  await page.waitForFunction(
    () => localStorage.getItem("kk.entries") && localStorage.getItem("kk.entries").includes("2026-08-15"),
    { timeout: 5000 }
  );

  fs.unlinkSync(backupPath);

  // The user must have seen (and, via the auto-handler above, confirmed) the
  // "replace data?" confirm - sanity check that our restore flow actually
  // engaged the handler under test, and that nothing crashed along the way.
  assert.ok(
    dialogs.some((d) => d.type === "confirm"),
    "precondition failed: the restore confirmation dialog never appeared"
  );
  assert.strictEqual(
    pageErrors.length,
    0,
    `precondition failed: restore threw unexpectedly: ${pageErrors.map((e) => e.message).join("; ")}`
  );

  // Precondition: the restore actually succeeded and updated the in-memory
  // calendar -- otherwise the missing feedback below would just be a
  // trivial (and uninteresting) side effect of the restore having failed.
  const restoredEntry = await page.evaluate(() => state.entries["2026-08-15"]);
  assert.strictEqual(
    restoredEntry,
    "p2",
    "precondition failed: the restore did not actually apply the new backup data"
  );

  // Core assertion #1: the settings dialog -- a native modal whose
  // ::backdrop covers the entire viewport -- must not still be sitting on
  // top of the now-updated calendar after a successful restore.
  const dialogStillOpen = await page.evaluate(() => document.getElementById("settingsDialog").hasAttribute("open"));
  assert.strictEqual(
    dialogStillOpen,
    false,
    "BUG: after a successful restore, #settingsDialog is still open and its backdrop keeps covering the " +
      "refreshed calendar, so the user cannot see that anything changed"
  );

  // Core assertion #2: some explicit, visible success feedback (a toast,
  // status message, etc. distinct from the confirm() the user themselves
  // triggered) must be shown so the user knows the restore worked.
  const sawSuccessFeedback = dialogs.some((d) => d.type !== "confirm");
  assert.ok(
    sawSuccessFeedback,
    "BUG: no success message of any kind was shown after the restore completed -- the user has no way to " +
      "tell that the backup was applied"
  );
});
