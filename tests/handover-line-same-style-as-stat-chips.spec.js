// Repro for review finding: "The most important line on screen looks
// identical to the least important" (styles.css:~242, .handover-row /
// .stats-row / .stat-chip).
//
// The next-handover line ("Wechsel zu <Name> am ...") in #handoverRow and
// the two month-count totals in .stats-row are both just a bare
// `<span class="stat-chip">` with no other styling hook. Since .stat-chip is
// the *only* rule that touches their font-size/weight/color (13px, weight
// 600, var(--muted)), the single glanceable answer the app exists to give
// renders with the exact same visual weight as the least important
// footnote-y totals below it.
//
// This test seeds a real upcoming handover (so #handoverRow is visible),
// reads the computed font-size/color of the handover chip vs. a stats-row
// chip, and asserts the handover line is promoted (larger, and colored
// differently from the muted stats color - i.e. not identical to --muted).
//
// - Current (buggy) styles.css: both chips resolve to the same font-size and
//   the same `color: var(--muted)`, so this test FAILS.
// - Fixed styles.css: the handover chip gets its own, larger/darker rule
//   (e.g. ~16px, weight 600, color: var(--ink)) while the stats chips stay
//   small and muted, so this test PASSES.
const { test } = require("@playwright/test");
const assert = require("node:assert/strict");

test.use({ viewport: { width: 500, height: 900 }, serviceWorkers: "block" });

test("the next-handover line is visually promoted above the muted stat totals", async ({ page }) => {
  await page.goto("/index.html");

  // Seed a deterministic, guaranteed-to-fire handover starting tomorrow:
  // today -> p1, tomorrow -> p2. findNextHandover() will report a handover
  // "tomorrow", so #handoverRow is shown instead of being display:none.
  const dateKeys = await page.evaluate(() => {
    const pad = (d) => String(d).padStart(2, "0");
    const keyFor = (date) => `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
    const today = new Date();
    const tomorrow = new Date(today);
    tomorrow.setDate(today.getDate() + 1);
    return { today: keyFor(today), tomorrow: keyFor(tomorrow) };
  });

  await page.evaluate((keys) => {
    localStorage.setItem("kk.entries", JSON.stringify({ [keys.today]: "p1", [keys.tomorrow]: "p2" }));
    localStorage.setItem("kk.notes", JSON.stringify({}));
    localStorage.setItem("kk.splitOrder", JSON.stringify({}));
  }, dateKeys);

  await page.reload();
  await page.waitForSelector("#dayGrid .day-cell");

  const handoverRow = page.locator("#handoverRow");
  await handoverRow.waitFor({ state: "visible" });
  const handoverLabelText = await page.locator("#handoverLabel").textContent();
  assert.ok(
    /wechsel/i.test(handoverLabelText || ""),
    `expected a seeded handover to be announced, got handoverLabel="${handoverLabelText}"`
  );

  const readChipStyle = (selector) =>
    page.locator(selector).first().evaluate((el) => {
      const cs = window.getComputedStyle(el);
      return { fontSize: parseFloat(cs.fontSize), fontWeight: cs.fontWeight, color: cs.color };
    });

  const handoverChipStyle = await readChipStyle("#handoverRow .stat-chip");
  const statsChipStyle = await readChipStyle(".stats-row .stat-chip");

  console.log("handover chip style:", handoverChipStyle, "stats chip style:", statsChipStyle);

  assert.ok(
    handoverChipStyle.fontSize > statsChipStyle.fontSize,
    `BUG: the handover line's font-size (${handoverChipStyle.fontSize}px) is not larger than the ` +
      `stats totals' font-size (${statsChipStyle.fontSize}px) - both use the plain .stat-chip rule, so ` +
      "the app's single most important line reads with the same visual weight as its footnote-y totals."
  );

  assert.notEqual(
    handoverChipStyle.color,
    statsChipStyle.color,
    `BUG: the handover line's text color (${handoverChipStyle.color}) is identical to the muted stats ` +
      `totals' color (${statsChipStyle.color}) - the primary handover answer is not visually distinguished ` +
      "from secondary footnote text."
  );
});
