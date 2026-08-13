// Reproduces: "Every color-picker input event triggers a full 42-cell grid
// rebuild behind the modal" (app.js, wireSettingsInputs()/commit()).
//
// Dragging inside a native <input type="color"> fires many "input" events in
// quick succession, each with a different value. commit() currently calls
// render(), which does `grid.innerHTML = ""` and rebuilds all ~42 day cells
// from scratch on every single one of those events, even though the settings
// dialog is modal and the grid is fully hidden behind it.
//
// This test marks the day grid's first cell node, then dispatches a burst of
// "input" events (each with a distinct color, like a real drag) on the p1
// color picker while the settings dialog is open. If render()'s grid rebuild
// runs, the marked node gets thrown away and replaced by a fresh element, so
// the identity check fails. Once the fix (updating the two CSS custom
// properties + refreshChrome() instead of render()) lands, the grid is never
// touched and the original node survives untouched.
const { test } = require("@playwright/test");
const assert = require("node:assert");

// The app registers a service worker whose controllerchange handler
// triggers a page reload; that's irrelevant to this test but can race with
// the click below in a fresh/incognito context, so keep it out of the
// picture entirely.
test.use({ serviceWorkers: "block" });

test("color-picker input events did not rebuild the day grid", async ({ page }) => {
  await page.goto("/");

  // Open the settings dialog the same way a user would. Retried once: the
  // click has occasionally been observed to land before the page's own
  // "click" listener is attached (a static file server + service-worker
  // registration adds a bit of jitter to when init() finishes), which is
  // unrelated to the bug under test.
  await page.click("#settingsBtn");
  try {
    await page.waitForSelector("#settingsDialog[open]", { timeout: 5000 });
  } catch {
    await page.click("#settingsBtn");
    await page.waitForSelector("#settingsDialog[open]", { timeout: 5000 });
  }

  // Tag the grid's current first cell so we can recognize it (by identity,
  // not just by content) after the color-picker events fire.
  await page.evaluate(() => {
    const cell = document.querySelector("#dayGrid > *");
    if (!cell) throw new Error("expected #dayGrid to have at least one child cell");
    cell.dataset.rebuildProbe = "original-cell";
    window.__probeCell = cell;
  });

  // Simulate a real color-wheel drag: a burst of "input" events, each with
  // a different value, fired directly on the underlying <input> (this is
  // exactly what commit()/wireSettingsInputs() listens for).
  await page.evaluate(() => {
    const input = document.getElementById("p1ColorInput");
    const colors = ["#111111", "#222222", "#333333", "#444444", "#555555", "#666666"];
    for (const color of colors) {
      input.value = color;
      input.dispatchEvent(new Event("input", { bubbles: true }));
    }
  });

  const stillSameNode = await page.evaluate(() => {
    const probe = window.__probeCell;
    const currentFirstCell = document.querySelector("#dayGrid > *");
    // Both: the exact original node must still be the grid's first child,
    // AND it must still be connected to the document (render()'s
    // `grid.innerHTML = ""` would detach it even if a stray reference
    // survives on window).
    return probe.isConnected && probe === currentFirstCell;
  });

  assert.strictEqual(
    stillSameNode,
    true,
    "Expected the day grid to NOT be rebuilt while dragging the settings " +
      "color picker (the original cell DOM node should survive untouched), " +
      "but it was replaced -- render() (which does grid.innerHTML = \"\") " +
      "ran on a color-picker 'input' event."
  );
});
