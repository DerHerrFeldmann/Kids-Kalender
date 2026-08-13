// Repro for review finding: "Opening Einstellungen auto-focuses the name
// field, so the mobile keyboard covers the data actions" (app.js,
// openSettings(), lines 836-839 in the finding / actually ~910-913 here;
// showModal() on #settingsDialog with #p1NameInput as the dialog's first
// focusable descendant).
//
// <dialog>.showModal() focuses the first focusable element inside the
// dialog by default. In #settingsDialog (index.html ~line 123-146) that
// first focusable element is #p1NameInput, a plain text input. On a touch
// device, focusing a text input immediately raises the software keyboard,
// which -- on a phone-sized viewport -- covers the lower half of the
// dialog, i.e. exactly where "Wiederherstellen", "Sichern" and "Fertig"
// live. Renaming people is a one-off action; backup/restore is the
// recurring reason to open this dialog, so the current default actively
// obstructs the common path.
//
// This test opens the settings dialog on a small/phone-sized viewport and
// asserts that the initially-focused element is NOT a text input (i.e. is
// not something that would pop the software keyboard unprompted). It also
// cross-checks against #noteDialog, where auto-focusing the text input is
// the *correct*, intentional behaviour (typing is the point there), to make
// sure the test is specifically about the settings dialog's default focus
// and not a blanket "never autofocus a text input" rule.
//
// - Current (buggy) code: document.activeElement after showModal() is
//   #p1NameInput (a text input) -> test fails.
// - Fixed code (e.g. tabindex="-1" + dialog.focus(), or autofocus on a
//   non-typing element like the "Fertig" button): document.activeElement
//   is not a text input -> test passes.
const { test, expect } = require("@playwright/test");

test.use({
  viewport: { width: 375, height: 667 }, // iPhone SE-ish phone viewport
  serviceWorkers: "block",
});

test("opening Einstellungen does not auto-focus the name text input (no unsolicited keyboard)", async ({
  page,
}) => {
  await page.goto("/index.html");
  await page.waitForSelector("#dayGrid .day-cell");

  await page.locator("#settingsBtn").click();
  await page.waitForSelector("#settingsDialog[open]");

  const active = await page.evaluate(() => {
    const el = document.activeElement;
    return {
      id: el && el.id,
      tagName: el && el.tagName,
      type: el && el.getAttribute && el.getAttribute("type"),
    };
  });

  // The bug: showModal()'s default focus behaviour lands on the first
  // focusable descendant, #p1NameInput, a type="text" input -- which is
  // exactly what triggers the mobile keyboard.
  expect(
    active.tagName === "INPUT" && active.type === "text",
    `BUG: opening Einstellungen focused a text input (#${active.id}), which pops the mobile keyboard and ` +
      `covers 'Wiederherstellen'/'Sichern'/'Fertig' on a phone-sized viewport, even though renaming is a ` +
      `one-off action and backup/restore is the recurring reason to open this dialog.`
  ).toBe(false);

  // Sanity/contrast check: the *same* default-focus mechanism is fine, and
  // should stay untouched, on #noteDialog -- there, typing a note really is
  // the point of opening the dialog, so the keyboard appearing immediately
  // is desired. This guards against a fix that indiscriminately strips
  // autofocus everywhere instead of just correcting the settings dialog.
  await page.locator("#settingsDialog .primary-btn").click(); // closes settingsDialog via "Fertig"
  await page.waitForFunction(() => !document.getElementById("settingsDialog").hasAttribute("open"));

  await page.locator("#dayGrid .day-cell:not(.outside)").first().dispatchEvent("pointerdown", { pointerType: "touch" });
  await page.waitForTimeout(700); // long-press threshold to open the note dialog
  await page.locator("#dayGrid .day-cell:not(.outside)").first().dispatchEvent("pointerup", { pointerType: "touch" });

  const noteDialogOpen = await page.evaluate(() => document.getElementById("noteDialog").hasAttribute("open"));
  if (noteDialogOpen) {
    const noteActive = await page.evaluate(() => ({
      id: document.activeElement && document.activeElement.id,
      tagName: document.activeElement && document.activeElement.tagName,
    }));
    expect(noteActive.id).toBe("noteInput");
  }
});
