// Repro for review finding: "Day cells expose only the date number - owner,
// note and month are color-only" (app.js:~477, buildDayCell).
//
// buildDayCell() sets the button's aria-label to either just the bare day
// number (`String(date.getDate())`) or, if a note exists, the day number
// plus the note text - it never mentions who has the child that day. Who
// owns a day is conveyed purely by a background color/diagonal split
// (.p1 / .p2 / .both classes, painted in applyOwnerVisual), and
// adjacent-month days are marked only by 45% opacity (.outside class) with
// no textual equivalent. A screen-reader user hears "2, button", "3,
// button", "4, button" for three days with three different custody states
// and cannot tell them apart; a sighted user with a color-vision deficiency
// is in the same position since the two pastel fills are the only cue.
//
// This test seeds a known set of days (one assigned to each parent, one
// shared/"both", one with a note, and relies on the grid's built-in
// adjacent-month spillover cells) and asserts that each cell's accessible
// name (aria-label) reflects that state. It FAILS against the current
// app.js, where every aria-label collapses to the bare day number (plus
// note text, for the note day) regardless of ownership or month
// membership. It should PASS once buildDayCell (and applyOwnerVisual, for
// live repaints) set a full aria-label along the lines the review
// recommends, e.g. "13. August 2026, Papa" / "..., Mama" / "..., Papa und
// Mama" / "..., nicht zugeteilt", plus ", anderer Monat" for spillover
// cells.
const { test, expect } = require("@playwright/test");
const assert = require("node:assert/strict");

test.use({ serviceWorkers: "block" });

test("day-cell aria-label conveys owner, note and month membership, not just the day number", async ({
  page,
}) => {
  await page.goto("/index.html");
  await page.waitForSelector("#dayGrid .day-cell");

  // Compute date keys for day 2 (-> p1), day 3 (-> p2), day 4 (-> both) and
  // day 5 (-> has a note, no owner) of the month currently displayed by the
  // app, plus read out the configured parent names so the assertions don't
  // hardcode "Papa"/"Mama" beyond the app's own defaults.
  const setup = await page.evaluate(() => {
    const now = new Date();
    const year = now.getFullYear();
    const month = now.getMonth();
    const pad = (n) => String(n).padStart(2, "0");
    const keyFor = (d) => `${year}-${pad(month + 1)}-${pad(d)}`;
    return {
      p1Key: keyFor(2),
      p2Key: keyFor(3),
      bothKey: keyFor(4),
      noteKey: keyFor(5),
      p1Name: state.settings.p1Name,
      p2Name: state.settings.p2Name,
    };
  });

  await page.evaluate(
    ({ p1Key, p2Key, bothKey, noteKey }) => {
      localStorage.setItem(
        "kk.entries",
        JSON.stringify({ [p1Key]: "p1", [p2Key]: "p2", [bothKey]: "both" })
      );
      localStorage.setItem("kk.splitOrder", "{}");
      localStorage.setItem("kk.notes", JSON.stringify({ [noteKey]: "Testnotiz" }));
    },
    setup
  );
  await page.reload();
  await page.waitForSelector("#dayGrid .day-cell");

  const ariaLabelOf = (key) =>
    page.locator(`.day-cell[data-date="${key}"]`).first().getAttribute("aria-label");

  const p1Label = await ariaLabelOf(setup.p1Key);
  const p2Label = await ariaLabelOf(setup.p2Key);
  const bothLabel = await ariaLabelOf(setup.bothKey);
  const noteLabel = await ariaLabelOf(setup.noteKey);

  console.log("p1 day aria-label:", p1Label);
  console.log("p2 day aria-label:", p2Label);
  console.log("both day aria-label:", bothLabel);
  console.log("note day aria-label:", noteLabel);

  assert.match(
    p1Label,
    new RegExp(setup.p1Name),
    `BUG: aria-label for a day owned by ${setup.p1Name} ("${p1Label}") does not mention ${setup.p1Name} - ` +
      "ownership is conveyed purely by background color, so a screen-reader user cannot tell who has the child."
  );

  assert.match(
    p2Label,
    new RegExp(setup.p2Name),
    `BUG: aria-label for a day owned by ${setup.p2Name} ("${p2Label}") does not mention ${setup.p2Name} - ` +
      "ownership is conveyed purely by background color, so a screen-reader user cannot tell who has the child."
  );

  // A shared/"both" day must mention both parents so it is distinguishable
  // from a single-owner day, not just from an unowned one.
  assert.match(
    bothLabel,
    new RegExp(setup.p1Name),
    `BUG: aria-label for a shared ("both") day ("${bothLabel}") does not mention ${setup.p1Name}.`
  );
  assert.match(
    bothLabel,
    new RegExp(setup.p2Name),
    `BUG: aria-label for a shared ("both") day ("${bothLabel}") does not mention ${setup.p2Name}.`
  );

  // p1Label/p2Label/bothLabel must actually differ from each other in more
  // than the day number - i.e. the owner distinction must be textual, not
  // just conveyed by three different background fills.
  assert.notStrictEqual(
    p1Label,
    p2Label,
    "BUG: the aria-labels for a p1-owned day and a p2-owned day are identical " +
      "(both collapse to just the day number) - ownership is color-only."
  );

  // The note day currently has no owner assigned, so its aria-label should
  // additionally, independent of the note text, indicate that nobody is
  // assigned - it should not read exactly like an owned day's label with
  // the note text appended, i.e. it must not equal the bare "<day>, Notiz: ..."
  // form the current implementation produces.
  assert.doesNotMatch(
    noteLabel,
    /^\d+, Notiz:/,
    `BUG: aria-label for an unassigned day with a note ("${noteLabel}") is just the bare day number ` +
      "plus the note text, with no indication of who (if anyone) has the child that day."
  );

  // Adjacent-month ("outside") cells are visually marked only by 45%
  // opacity (see the .outside CSS rule) - there should be a textual
  // equivalent on the cell's accessible name too.
  const outsideKey = await page.evaluate(() => {
    const cell = document.querySelector("#dayGrid .day-cell.outside");
    return cell ? cell.dataset.date : null;
  });

  if (outsideKey) {
    const outsideLabel = await ariaLabelOf(outsideKey);
    console.log("outside-of-month day aria-label:", outsideLabel);
    assert.match(
      outsideLabel,
      /anderer Monat|anderen Monat|nächster Monat|vorheriger Monat/i,
      `BUG: aria-label for an adjacent-month spillover day ("${outsideLabel}") gives no textual indication ` +
        "that the day belongs to a different month than the one being viewed - it's conveyed only by 45% opacity."
    );
  }
});
