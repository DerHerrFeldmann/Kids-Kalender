// Repro for review finding: "Keyboard focus is dropped to <body> whenever
// render() rebuilds the grid" (app.js, render(), around line 872 /
// grid.innerHTML = "").
//
// render() always does `grid.innerHTML = ""` and rebuilds all 42 day-cell
// <button> elements from scratch. Whichever cell currently has keyboard
// focus is destroyed in the process and never re-focused afterwards, so
// focus silently falls back to <body>. closeNoteDialog() (opened via the
// Space-key path on a focused day cell) ends with a call to render(), so
// the most common keyboard flow -- focus a day, open its note with Space,
// close the dialog -- is guaranteed to strand focus at the top of the
// document (WCAG 2.4.3, Focus Order). A keyboard user then has to tab all
// the way back through the header and grid to find their place again.
//
// This test focuses a day cell exactly the way a keyboard user would (no
// pointer events), opens the note dialog for it with Space, and closes the
// dialog with Escape (a plain, no-op dismissal). It FAILS against the
// current app.js because document.activeElement ends up being <body>
// instead of the day cell that was focused before the dialog opened. It
// should PASS once render() restores focus to the previously focused
// cell's data-date after rebuilding the grid.
const { test, expect } = require("@playwright/test");

test.use({ serviceWorkers: "block" });

test("focus on a day cell survives the render() triggered by closing the note dialog", async ({ page }) => {
  const pageErrors = [];
  page.on("pageerror", (err) => pageErrors.push(err.message));

  await page.goto("/index.html");
  await page.evaluate(() => localStorage.clear());
  await page.reload();

  const dayCells = page.locator(".day-cell:not(.outside)");
  const targetCell = dayCells.nth(10);
  const focusedDate = await targetCell.evaluate((el) => el.dataset.date);

  // Focus the cell the way a keyboard user would, then open its note
  // dialog with Space (the documented keyboard-only path to openNoteDialog).
  await targetCell.focus();
  await expect(targetCell).toBeFocused();
  await page.keyboard.press("Space");

  const dialog = page.locator("#noteDialog");
  await expect(dialog).toBeVisible();

  // Dismiss the dialog with Escape -- a plain cancel, no note content
  // changed -- which triggers the dialog's "close" listener, which calls
  // closeNoteDialog() -> render().
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();

  // The grid has just been fully rebuilt by render(). The cell the user
  // was on before opening the dialog should still be the focused element.
  const activeInfo = await page.evaluate(() => {
    const el = document.activeElement;
    return {
      tag: el ? el.tagName : null,
      isDayCell: !!(el && el.classList && el.classList.contains("day-cell")),
      date: el && el.dataset ? el.dataset.date : null,
    };
  });

  expect(pageErrors).toEqual([]);
  expect(activeInfo.isDayCell, `expected focus to stay on the day cell, but activeElement was <${activeInfo.tag}>`).toBe(true);
  expect(activeInfo.date).toBe(focusedDate);
});
