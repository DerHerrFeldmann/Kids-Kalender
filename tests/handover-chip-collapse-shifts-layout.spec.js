// Repro for review finding: "Übergabe-Chip und Monatsstatistik sehen gleich
// aus, beziehen sich aber auf verschiedene Zeiträume" (app.js:~631,
// refreshChrome).
//
// refreshChrome() toggles #handoverRow's visibility with
// `handoverRow.style.display = "none"` whenever findNextHandover() finds no
// upcoming switch. Because that collapses the row to zero height (rather
// than reserving its space via visibility/opacity, as the review
// recommends), everything below it - the .stats-row totals and the brush
// bar in the footer - physically shifts up or down depending on whether a
// handover happens to exist right now. Combined with the handover chip and
// the stats chips being unlabelled, identically-styled ".stat-chip" spans,
// this makes the UI feel like it's jumping around between months/days for
// no visible reason.
//
// This test seeds two data sets - one where a handover exists tomorrow (so
// #handoverRow is shown) and one where the owner map is completely empty (so
// findNextHandover() returns null and #handoverRow is display:none) - and
// compares the on-screen top position of .stats-row in both cases.
//
// - Current (buggy) app.js/styles.css: the stats row moves up by the full
//   height of the collapsed handover row, so this test FAILS.
// - Fixed app.js/styles.css: the handover row's height is reserved
//   (visibility/opacity toggle or a neutral placeholder) so the stats row
//   stays put, and this test PASSES.
const { test } = require("@playwright/test");
const assert = require("node:assert/strict");

test.use({ viewport: { width: 500, height: 900 }, serviceWorkers: "block" });

async function seedAndMeasure(page, entries) {
  await page.evaluate((entriesToStore) => {
    localStorage.setItem("kk.entries", JSON.stringify(entriesToStore));
    localStorage.setItem("kk.notes", JSON.stringify({}));
    localStorage.setItem("kk.splitOrder", JSON.stringify({}));
  }, entries);

  await page.reload();
  await page.waitForSelector("#dayGrid .day-cell");

  const statsRow = page.locator(".stats-row");
  const box = await statsRow.boundingBox();
  assert.ok(box, "expected .stats-row to be present and rendered");

  const handoverDisplay = await page
    .locator("#handoverRow")
    .evaluate((el) => window.getComputedStyle(el).display);

  return { top: box.y, handoverDisplay };
}

test("stats row does not shift when the handover chip has nothing to show", async ({ page }) => {
  await page.goto("/index.html");

  // Case 1: seed a guaranteed handover starting tomorrow (today -> p1,
  // tomorrow -> p2), so #handoverRow is visible.
  const dateKeys = await page.evaluate(() => {
    const pad = (d) => String(d).padStart(2, "0");
    const keyFor = (date) => `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
    const today = new Date();
    const tomorrow = new Date(today);
    tomorrow.setDate(today.getDate() + 1);
    return { today: keyFor(today), tomorrow: keyFor(tomorrow) };
  });

  const withHandover = await seedAndMeasure(page, {
    [dateKeys.today]: "p1",
    [dateKeys.tomorrow]: "p2",
  });
  assert.equal(
    withHandover.handoverDisplay,
    "flex",
    "sanity check: expected the seeded handover to make #handoverRow visible"
  );

  // Case 2: an empty owner map has no assigned owners anywhere, so
  // findNextHandover() finds nothing and #handoverRow collapses.
  const withoutHandover = await seedAndMeasure(page, {});
  assert.equal(
    withoutHandover.handoverDisplay,
    "none",
    "sanity check: expected an empty calendar to have no upcoming handover, hiding #handoverRow"
  );

  console.log(
    "stats-row top with handover:", withHandover.top,
    "stats-row top without handover:", withoutHandover.top
  );

  assert.ok(
    Math.abs(withHandover.top - withoutHandover.top) < 1,
    `BUG: .stats-row's top position moved from ${withHandover.top}px (handover shown) to ` +
      `${withoutHandover.top}px (handover hidden) - collapsing #handoverRow with display:none instead of ` +
      "reserving its height shifts the whole layout below the calendar depending on whether a handover " +
      "currently exists, rather than which month is displayed."
  );
});
