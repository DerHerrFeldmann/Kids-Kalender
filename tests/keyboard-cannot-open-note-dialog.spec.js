// Repro for review finding: "Notes can only be created or edited via a
// 500 ms pointer long-press" (app.js:~577, render()'s per-cell
// pointerdown handler).
//
// openNoteDialog(date) is only ever called from the setTimeout armed
// inside the day cell's "pointerdown" listener once 500ms elapse without
// the pointer being released (pointerup/pointerleave/pointercancel all
// clear that timer first). A day cell is a plain <button>, and activating
// a focused <button> via the keyboard (Enter or Space) never dispatches
// "pointerdown" at all — it goes straight to a synthetic "click", which is
// exactly the event render() wires to applyBrush(). longPressFired also
// stays false in that case (it's only ever set true by the long-press
// timer's callback), so the click handler's "was this a long-press?" guard
// does nothing to help a keyboard user either.
//
// Net effect: a keyboard or switch-control user who tabs to a day cell and
// presses Enter/Space can only ever paint/cycle that day's owner
// (applyBrush) — there is no way for them to reach openNoteDialog, so they
// can never create, read or delete a note. This is a WCAG 2.1.1
// (Keyboard) failure: the note feature has no keyboard-operable path at
// all, pointer long-press being its *only* trigger.
//
// This test focuses a day cell exactly the way a keyboard user would (no
// pointer events at all) and activates it with Enter, then Space on a
// second cell. It FAILS against the current app.js because the note
// dialog never opens (applyBrush runs instead, silently changing the
// day's owner). It should PASS once a keyboard-reachable path to
// openNoteDialog exists (e.g. a keydown handler on the cell, or a visible
// "Notiz" button acting on the focused/selected day).
const { test, expect } = require("@playwright/test");
const assert = require("node:assert/strict");

test.use({ serviceWorkers: "block" });

test("keyboard activation of a day cell cannot open the note dialog", async ({ page }) => {
  const pageErrors = [];
  page.on("pageerror", (err) => pageErrors.push(err.message));

  await page.goto("/index.html");
  await page.evaluate(() => localStorage.clear());
  await page.reload();
  await page.waitForSelector("#dayGrid .day-cell");

  const firstCell = page.locator(".day-cell[data-date]").first();
  const dateKey = await firstCell.getAttribute("data-date");
  const ownerBefore = await page.evaluate(
    (key) => JSON.parse(localStorage.getItem("kk.entries") || "{}")[key] || null,
    dateKey
  );

  // A keyboard user reaches the cell purely via Tab and never fires any
  // pointer event on it.
  await firstCell.focus();
  await expect(firstCell).toBeFocused();
  await page.keyboard.press("Enter");

  const dialog = page.locator("#noteDialog");
  const openedAfterEnter = await dialog.evaluate((el) => el.hasAttribute("open"));

  // Try Space too (the other standard way to activate a focused <button>),
  // on a second cell, in case Enter alone were special-cased.
  if (!openedAfterEnter) {
    const secondCell = page.locator(".day-cell[data-date]").nth(1);
    await secondCell.focus();
    await page.keyboard.press("Space");
  }
  const openedAfterSpace = await dialog.evaluate((el) => el.hasAttribute("open"));

  assert.ok(
    openedAfterEnter || openedAfterSpace,
    "BUG: activating a focused day cell with Enter or Space never opens #noteDialog — " +
      "openNoteDialog is only reachable from the pointerdown long-press timer, so keyboard " +
      "and switch-control users have no way to create, read or delete a note (WCAG 2.1.1)."
  );

  assert.deepStrictEqual(pageErrors, [], `Unexpected page errors: ${pageErrors.join(", ")}`);
});
