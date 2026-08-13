// Repro for review finding: "The handover headline and both stat chips wrap
// into ragged centred multi-line text" (app.js:~755 `Nächste Übergabe:
// Wechsel zu ${name} am ...` and app.js:~766-767
// `${monthName}: ${name} ${n} Nächte`, rendered by .handover-row /
// .stats-row / .stat-chip in styles.css).
//
// #handoverLabel is set to a full sentence and each stat chip repeats the
// month name verbatim. None of .handover-row, .stats-row or .stat-chip set
// `white-space: nowrap`, and the rows use `justify-content: center`, so on a
// narrow phone viewport these strings wrap mid-chip onto a second line that
// is *also* centred - producing ragged, hanging text instead of a
// single-line summary (and the color dot ends up vertically centred against
// the whole two-line block instead of sitting on the first line).
//
// Because a `.stat-chip` label is a flex item (blockified per the flexbox
// spec), Element.getClientRects() on the label always reports a single
// "fragment" even when the text wraps internally - so line-wrapping is
// detected here via a Range over the label's text node, whose
// getClientRects() correctly returns one rect per rendered line.
//
// This test loads the app at a narrow phone width (360x740, iPhone
// SE/12-mini class) with a seeded tomorrow-handover and a full month of
// entries (13 nights to p1, 18 to p2, matching the finding's own
// "August: Papa 13 / Nächte" example), then asserts the handover label and
// both stat labels each render as exactly one line.
//
// - Current (buggy) app.js/styles.css: the handover label and both stat
//   labels wrap onto 2 lines at this width, so this test FAILS.
// - Fixed app.js/styles.css (shorter copy, hoisted shared "month" scope out
//   of the chips, `white-space: nowrap` on .stat-chip): every label fits on
//   a single line, so this test PASSES.
const { test } = require("@playwright/test");
const assert = require("node:assert/strict");

test.use({ viewport: { width: 360, height: 740 }, serviceWorkers: "block" });

test("handover headline and stat chips do not wrap onto multiple centred lines on a narrow phone", async ({ page }) => {
  await page.goto("/index.html");

  // Seed a full month (13 nights p1, 18 nights p2 - long enough two-digit
  // counts to match the finding's own repro numbers) plus a guaranteed
  // handover tomorrow, using the currently displayed year/month so the
  // seeded data lines up with whatever "today" the suite runs on.
  const seed = await page.evaluate(() => {
    const pad = (d) => String(d).padStart(2, "0");
    const keyFor = (date) => `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
    const today = new Date();
    const year = today.getFullYear();
    const month = today.getMonth();
    const daysInMonth = new Date(year, month + 1, 0).getDate();
    const entries = {};
    for (let d = 1; d <= daysInMonth; d++) {
      entries[keyFor(new Date(year, month, d))] = d <= Math.min(13, daysInMonth) ? "p1" : "p2";
    }
    // Guarantee a real handover tomorrow regardless of the p1/p2 split above.
    const tomorrow = new Date(today);
    tomorrow.setDate(today.getDate() + 1);
    entries[keyFor(today)] = "p1";
    entries[keyFor(tomorrow)] = "p2";
    return entries;
  });

  await page.evaluate((entries) => {
    localStorage.removeItem("kk.settings");
    localStorage.setItem("kk.entries", JSON.stringify(entries));
    localStorage.setItem("kk.notes", JSON.stringify({}));
    localStorage.setItem("kk.splitOrder", JSON.stringify({}));
  }, seed);

  await page.reload();
  await page.waitForSelector("#dayGrid .day-cell");

  const handoverRow = page.locator("#handoverRow");
  await handoverRow.waitFor({ state: "visible" });

  const handoverLabelText = await page.locator("#handoverLabel").textContent();
  assert.ok(
    /mama/i.test(handoverLabelText || ""),
    `expected the seeded handover (switch to "Mama" tomorrow) to be announced, got handoverLabel="${handoverLabelText}"`
  );

  // A `.stat-chip` label is blockified by its flex-item context, so the
  // element's own getClientRects() always collapses to one fragment even
  // when its text wraps internally. Measure the *text node* instead, whose
  // client rects report one rect per rendered line.
  const countTextLines = (selector) =>
    page.locator(selector).evaluate((el) => {
      const textNode = Array.from(el.childNodes).find((n) => n.nodeType === Node.TEXT_NODE);
      if (!textNode) return 0;
      const range = document.createRange();
      range.selectNodeContents(textNode);
      return range.getClientRects().length;
    });

  const handoverLines = await countTextLines("#handoverLabel");
  const p1Lines = await countTextLines("#p1StatLabel");
  const p2Lines = await countTextLines("#p2StatLabel");
  const p1Text = await page.locator("#p1StatLabel").textContent();
  const p2Text = await page.locator("#p2StatLabel").textContent();

  console.log(
    `handoverLabel="${handoverLabelText}" lines=${handoverLines};`,
    `p1StatLabel="${p1Text}" lines=${p1Lines};`,
    `p2StatLabel="${p2Text}" lines=${p2Lines}`
  );

  assert.equal(
    handoverLines,
    1,
    `BUG: #handoverLabel ("${handoverLabelText}") wraps onto ${handoverLines} lines at a 360px-wide ` +
      "viewport instead of staying on a single line - the app's headline answer wraps into ragged, " +
      "centred multi-line text."
  );

  assert.equal(
    p1Lines,
    1,
    `BUG: #p1StatLabel ("${p1Text}") wraps onto ${p1Lines} lines at a 360px-wide viewport instead of ` +
      "staying on a single line - the stat chip wraps into ragged, centred multi-line text and no " +
      "longer aligns with the chip next to it."
  );

  assert.equal(
    p2Lines,
    1,
    `BUG: #p2StatLabel ("${p2Text}") wraps onto ${p2Lines} lines at a 360px-wide viewport instead of ` +
      "staying on a single line - the stat chip wraps into ragged, centred multi-line text and no " +
      "longer aligns with the chip next to it."
  );
});
