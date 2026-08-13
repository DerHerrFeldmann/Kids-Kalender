// Repro for review finding: "Notizen (Long-Press) sind nirgends auffindbar"
// (app.js:~577, cell pointerdown handler that arms a 500ms longPressTimer).
//
// Adding/reading a note requires holding a day cell for 500ms. Nothing in
// the UI — no icon, no visible hint text, no context-menu affordance, no
// first-run tip, and (per the recommendation) no aria-label — tells the
// user this gesture exists. The app already has a working precedent for
// this kind of discoverability hint (see #paintModeHint, a <p> that appears
// under the calendar while Mehrfachauswahl is active), but nothing
// equivalent exists for notes: the dialog's own "Notiz" label only becomes
// visible *after* the user has already discovered and performed the
// gesture, which is exactly the chicken-and-egg problem the finding
// describes. On top of that, a day that already has a note only renders an
// unlabelled ".note-dot" <span> — a bare visual dot with no text and no
// aria-label — so even a user who stumbles onto an existing note's dot has
// no way to know what it means without long-pressing to open the dialog.
//
// This test checks the two concrete, independently verifiable symptoms of
// the finding:
//   1. Nowhere in the currently *visible* UI (any visible text, aria-label,
//      or title attribute) is there any hint that explains "long-press a
//      day to add/read a note" — checked on a fresh first launch, before
//      any note has ever been created.
//   2. A day cell that DOES have a note carries no aria-label mentioning
//      the note's content, so screen-reader users get no indication of the
//      note's existence or content from the grid itself.
//
// Expected (once fixed): some visible, discoverable UI (a dismissible
// first-run hint, a help/settings entry, etc.) explains the long-press
// gesture, and a day cell with a note exposes an aria-label that includes
// the note text.
// Actual (current code): neither exists, so both checks below fail.
const { test } = require("@playwright/test");
const assert = require("node:assert");

// The app registers a service worker whose controllerchange handler
// triggers a page reload on a fresh/incognito context; that's irrelevant to
// this test but can race with the interactions below, so block it entirely.
test.use({ serviceWorkers: "block" });

test("long-press note gesture is discoverable, and a day with a note exposes it via aria-label", async ({
  page,
}) => {
  const pageErrors = [];
  page.on("pageerror", (err) => pageErrors.push(err.message));

  await page.goto("/index.html");
  await page.evaluate(() => localStorage.clear());
  await page.reload();
  await page.waitForSelector("#dayGrid .day-cell");

  // --- Symptom 1: no visible hint anywhere explains the long-press gesture.
  //
  // Collect the accessible/visible surface of the page as a real user (or
  // screen reader) would encounter it on first launch: aria-label/title of
  // every element that is actually rendered (not display:none/hidden, which
  // is exactly how the closed <dialog>s and the inactive #paintModeHint are
  // suppressed), plus the rendered body text.
  const visibleSurfaceText = await page.evaluate(() => {
    const parts = [];
    document.querySelectorAll("body *").forEach((el) => {
      const style = window.getComputedStyle(el);
      if (style.display === "none" || style.visibility === "hidden") return;
      const label = el.getAttribute("aria-label");
      if (label) parts.push(label);
      const title = el.getAttribute("title");
      if (title) parts.push(title);
    });
    parts.push(document.body.innerText || "");
    return parts.join("\n");
  });

  // A real hint would have to mention notes AND the long-press mechanic
  // (e.g. "lange drücken = Notiz", per the review's own suggested copy).
  // Just the bare word "Notiz" appearing somewhere wouldn't be enough (the
  // closed note dialog itself contains that word once opened), but on a
  // pristine first launch nothing is open, so this also independently
  // proves the word isn't leaking from a hidden dialog.
  const mentionsNotes = /notiz/i.test(visibleSurfaceText);
  const explainsLongPress = /(lang(e)?\s*(dr[uü]cken|halten)|halte|gedr[uü]ckt|long[\s-]?press)/i.test(
    visibleSurfaceText
  );

  assert.ok(
    mentionsNotes && explainsLongPress,
    "BUG: nothing visible in the UI on first launch explains that a 500ms long-press on a day " +
      "cell adds/opens a note. Collected visible text/aria-label/title surface was:\n" +
      JSON.stringify(visibleSurfaceText)
  );

  // --- Symptom 2: an existing note's day cell has no accessible label
  // conveying the note, only an unlabelled decorative ".note-dot".
  const firstCell = page.locator(".day-cell[data-date]").first();
  const dateKey = await firstCell.getAttribute("data-date");
  const noteText = "Kinderarzt 15 Uhr";

  await page.evaluate(
    ({ key, text }) => {
      localStorage.setItem("kk.notes", JSON.stringify({ [key]: text }));
    },
    { key: dateKey, text: noteText }
  );
  await page.reload();
  await page.waitForSelector("#dayGrid .day-cell");

  const notedCell = page.locator(`.day-cell[data-date="${dateKey}"]`);
  // Sanity check on the precondition: the note-dot marker for this day is
  // actually rendered, so we know a real note exists on this cell.
  await notedCell.locator(".note-dot").waitFor({ state: "attached" });

  const cellAriaLabel = (await notedCell.getAttribute("aria-label")) || "";
  assert.ok(
    cellAriaLabel.includes(noteText),
    "BUG: a day cell with an existing note has no aria-label mentioning the note's content " +
      `(aria-label was ${JSON.stringify(cellAriaLabel)}); the note-dot is a bare, unlabelled ` +
      "visual marker, so its meaning is inaccessible without already knowing to long-press."
  );

  assert.deepStrictEqual(pageErrors, [], `Unexpected page errors: ${pageErrors.join(", ")}`);
});
