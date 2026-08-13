// Repro for review finding: "Unguarded localStorage writes during restore
// let an oversized backup half-apply, diverging in-memory state from
// persisted state with no error shown" (webapp/app.js, handleRestoreFile,
// persistence block around line 904-907).
//
// Scenario:
//   1. User opens "Einstellungen" -> "Wiederherstellen" and picks a backup
//      file. It parses fine and passes the type checks, so state.entries /
//      state.notes / state.splitOrder / state.settings are all replaced in
//      memory (app.js:~908-919).
//   2. The user confirms the "replace current data?" prompt.
//   3. handleRestoreFile then persists the new state with four unguarded
//      calls: saveJSON("entries"), saveJSON("notes"), saveJSON("splitOrder"),
//      saveSettings() (app.js:~925-928). None of these, nor saveJSON()/
//      saveSettings() themselves, are wrapped in a try/catch.
//   4. If the first write (saveJSON("entries")) throws — which is exactly
//      what a real ~6MB backup does on browsers with a small localStorage
//      quota (QuotaExceededError) — the exception propagates out of the
//      FileReader `onload` handler uncaught. The remaining saves,
//      populateSettingsForm(), and render() never run, and the user sees
//      no error message at all.
//
// To make this deterministic across environments (actual localStorage
// quotas vary a lot between browsers/CI and hitting the real limit would
// make the test slow/flaky), we simulate the effect of an oversized backup
// by patching Storage.prototype.setItem to throw a QuotaExceededError for
// the "kk.entries" key specifically — exactly what the browser itself would
// throw when a real oversized backup is restored.
//
// This test FAILS on current code: the setItem failure escapes as an
// uncaught page error, and the user is never shown any feedback (the only
// dialog seen is the initial confirm() the user themselves triggered).
// It should PASS once handleRestoreFile wraps the persistence block in a
// try/catch that handles the failure (e.g. surfaces an error message and/or
// rolls back the in-memory state) instead of letting the exception escape
// silently.
const { test } = require("@playwright/test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

test.use({ serviceWorkers: "block" });

test("a persistence failure during restore is surfaced to the user instead of escaping uncaught", async ({ page }) => {
  // Simulate a real browser's localStorage quota rejecting an oversized
  // backup: any write to the "kk.entries" key throws QuotaExceededError,
  // deterministically, regardless of the actual (small) file size we use
  // in this test.
  await page.addInitScript(() => {
    const originalSetItem = Storage.prototype.setItem;
    Storage.prototype.setItem = function (key, value) {
      if (key === "kk.entries") {
        const err = new DOMException("The quota has been exceeded.", "QuotaExceededError");
        throw err;
      }
      return originalSetItem.call(this, key, value);
    };
  });

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

  // A normal-sized, well-formed backup file. Its size is irrelevant here -
  // the patched setItem above is what reproduces the oversized-backup
  // failure deterministically.
  const backup = {
    version: 2,
    entries: { "2026-08-12": "p2" },
    notes: {},
    splitOrder: {},
    settings: { p1Name: "Papa", p2Name: "Mama", p1Color: "#a3cf8f", p2Color: "#f7dd86" },
  };
  const backupPath = path.join(os.tmpdir(), `kk-backup-quota-${Date.now()}.json`);
  fs.writeFileSync(backupPath, JSON.stringify(backup));

  await page.locator("#settingsBtn").click();
  await page.locator("#restoreBtn").click();
  await page.locator("#restoreInput").setInputFiles(backupPath);

  // Give the confirm() dialog (auto-accepted above) and the subsequent
  // FileReader onload/persistence work a moment to run.
  await page.waitForTimeout(1000);

  fs.unlinkSync(backupPath);

  // The user must have seen the "replace data?" confirm - sanity check that
  // our restore flow actually engaged the handler under test.
  assert.ok(
    dialogs.some((d) => d.type === "confirm"),
    "precondition failed: the restore confirmation dialog never appeared"
  );

  // Core assertion: a failed persistence write during restore must be
  // handled, not escape as an uncaught exception out of the FileReader
  // callback.
  assert.strictEqual(
    pageErrors.length,
    0,
    "BUG: saveJSON(\"entries\") throwing (simulated QuotaExceededError from an oversized backup) escaped " +
      `handleRestoreFile as an uncaught exception instead of being handled: ${pageErrors
        .map((e) => e.message)
        .join("; ")}`
  );

  // The user must be told something went wrong instead of the restore
  // silently half-applying with no feedback at all.
  assert.ok(
    dialogs.some((d) => d.type !== "confirm"),
    "BUG: no error was surfaced to the user after the restore's persistence step failed " +
      "(only the confirm() the user themselves triggered was shown)"
  );
});
