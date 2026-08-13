// Reproduces review finding: closeSettings() unconditionally commits all
// SETTINGS_FIELDS, each commit doing its own saveSettings() + full render().
// Closing the settings dialog WITHOUT changing anything should still only
// cost at most one render() and one saveSettings() call, but the current
// implementation fires one of each per field (4 of each).
const { test } = require("@playwright/test");
const assert = require("node:assert");

test("closeSettings() does not redundantly render/save per field", async ({ page }) => {
  // app.js registers sw.js, and the worker calls skipWaiting()+clients.claim(),
  // which fires "controllerchange" and makes app.js reload the page -- even on
  // a first load. That reload would silently wipe our instrumentation mid-test
  // (page.route() can't intercept the service-worker's own script fetch, so
  // blocking the network request doesn't help); stub register() out instead.
  await page.addInitScript(() => {
    if (navigator.serviceWorker) {
      navigator.serviceWorker.register = () => Promise.reject(new Error("disabled for test"));
    }
  });
  await page.goto("/index.html");

  // Wait for the app to finish its initial render.
  await page.waitForFunction(() => document.getElementById("dayGrid").children.length > 0);

  // Instrument the global render()/saveSettings() functions. app.js is a
  // classic (non-module) script, so its top-level `function` declarations
  // are plain globals aliased to window.* -- reassigning window.render here
  // means every unqualified render() call elsewhere in app.js resolves to
  // our counting wrapper too.
  await page.evaluate(() => {
    window.__renderCount = 0;
    window.__saveSettingsCount = 0;
    const origRender = window.render;
    window.render = function (...args) {
      window.__renderCount++;
      return origRender.apply(this, args);
    };
    const origSaveSettings = window.saveSettings;
    window.saveSettings = function (...args) {
      window.__saveSettingsCount++;
      return origSaveSettings.apply(this, args);
    };
  });

  // Open the settings dialog (populateSettingsForm() only assigns input
  // values; it must not itself call render()/saveSettings()).
  await page.click("#settingsBtn");
  await page.waitForSelector("#settingsDialog[open]");

  const countsAfterOpen = await page.evaluate(() => ({
    render: window.__renderCount,
    save: window.__saveSettingsCount,
  }));
  assert.strictEqual(countsAfterOpen.render, 0, "opening the dialog must not render()");
  assert.strictEqual(countsAfterOpen.save, 0, "opening the dialog must not saveSettings()");

  // Per the HTML spec, dialog.close() removes the `open` attribute
  // synchronously but the "close" event (which closeSettings() is bound to)
  // is only queued as a task, firing a tick later -- so waiting on the
  // `open` attribute alone races ahead of closeSettings() actually running.
  // Add a listener that's registered *after* app.js's own, so it's
  // guaranteed to run after closeSettings() has finished, and wait on that.
  await page.evaluate(() => {
    window.__closeSettingsDone = false;
    document.getElementById("settingsDialog").addEventListener("close", () => {
      window.__closeSettingsDone = true;
    });
  });

  // Close the dialog WITHOUT touching any field (submits the <form
  // method="dialog">, which fires the dialog's "close" event -> closeSettings()).
  await page.click("#settingsDialog button.primary-btn");
  await page.waitForFunction(() => window.__closeSettingsDone === true);

  const countsAfterClose = await page.evaluate(() => ({
    render: window.__renderCount,
    save: window.__saveSettingsCount,
  }));

  console.log("render() calls on close (no field changed):", countsAfterClose.render);
  console.log("saveSettings() calls on close (no field changed):", countsAfterClose.save);

  assert.ok(
    countsAfterClose.render <= 1,
    `expected at most 1 render() when closing settings with nothing changed, got ${countsAfterClose.render}`
  );
  assert.ok(
    countsAfterClose.save <= 1,
    `expected at most 1 saveSettings() when closing settings with nothing changed, got ${countsAfterClose.save}`
  );
});
