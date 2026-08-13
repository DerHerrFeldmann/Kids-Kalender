// Reproduces: 'Kein "Heute"-Marker und kein Weg zurück zum aktuellen Monat'
// (app.js buildDayCell() around line 477, and init()'s prevMonth/nextMonth
// wiring around line 1385-1390).
//
// Scenario under test: a custody calendar's central question is "who has the
// kids now/next" -- once the user has swiped/tapped a few months away (each
// swipe/tap is one month, via changeMonth()/slideToMonth()), there is no
// affordance anywhere in the UI to jump straight back to the month
// containing today. The top bar (index.html) only has "prevMonth"/
// "nextMonth" arrow buttons; #monthTitle is a plain, non-interactive <h1>
// with no click handler, and there is no "Heute" button/chip in the DOM at
// all. The only way back is counting swipes in the other direction.
//
// This test drives state.displayedMonth three months away from today via
// changeMonth() (the same function the "nextMonth" button and a completed
// swipe both call -- using it directly, like the sibling
// undo-after-month-navigation test does, avoids depending on the
// requestAnimationFrame/transitionend timing of the animated slide), then
// checks for either of the two affordances the review recommends:
//   (a) a tappable #monthTitle that jumps back to the current month, or
//   (b) a "Heute" button/chip (anywhere in the topbar) that does the same.
//
// FAILS against current app.js/index.html: neither affordance exists, so
// clicking the title is a no-op and no "Heute" element can be found, leaving
// state.displayedMonth (and the visible grid) stuck three months away from
// today.
//
// PASSES once fixed by either documented option: clicking #monthTitle, or
// clicking a "Heute" control, navigates state.displayedMonth (and the
// rendered #monthTitle) back to the month containing today.
const { test } = require("@playwright/test");
const assert = require("node:assert/strict");

// The app registers a service worker whose controllerchange handler triggers
// a page reload on a fresh/incognito context; irrelevant here but can race
// with navigation, so block it entirely.
test.use({ serviceWorkers: "block" });

test('a control exists to jump back to the current month after navigating away', async ({ page }) => {
  await page.goto("/");
  await page.evaluate(() => localStorage.clear());
  await page.reload();
  await page.waitForSelector("#dayGrid .day-cell");

  const setup = await page.evaluate(() => {
    const originalMonthTitle = monthTitle(state.displayedMonth);
    // Navigate three months forward, exactly like three taps on "nextMonth"
    // (or three completed right-swipes) would -- changeMonth() is the
    // function both eventually call.
    changeMonth(3);
    return {
      originalMonthTitle,
      awayMonthTitle: monthTitle(state.displayedMonth),
      domTitleAfterNav: document.getElementById("monthTitle").textContent,
    };
  });

  console.log("Setup:", setup);
  assert.notEqual(
    setup.awayMonthTitle,
    setup.originalMonthTitle,
    "setup failed: changeMonth(3) didn't actually move the displayed month away from today"
  );
  assert.equal(
    setup.domTitleAfterNav,
    setup.awayMonthTitle,
    "setup failed: rendered month title doesn't match the navigated-to month"
  );

  // Look for either recommended affordance: a "Heute" button/chip anywhere
  // in the topbar, or a click on the month title itself.
  const heuteControl = page.getByRole("button", { name: /heute/i });
  const heuteCount = await heuteControl.count();
  console.log(`"Heute" control found: ${heuteCount > 0}`);

  if (heuteCount > 0) {
    await heuteControl.first().click();
  } else {
    await page.locator("#monthTitle").click();
  }

  // Give a click-driven slideToMonth()/changeMonth() call time to finish its
  // (possibly animated) transition back.
  await page.waitForFunction(
    () => !document.getElementById("calendarViewport").classList.contains("sliding"),
    null,
    { timeout: 2000 }
  ).catch(() => {}); // fine if it was never sliding to begin with (a synchronous changeMonth() fix)

  const result = await page.evaluate(() => ({
    displayedMonthTitle: monthTitle(state.displayedMonth),
    domTitle: document.getElementById("monthTitle").textContent,
  }));

  console.log("After attempting to return to today:", result);

  assert.equal(
    result.displayedMonthTitle,
    setup.originalMonthTitle,
    "BUG: there is no way to get back to the current month after navigating away -- neither a " +
      '"Heute" control exists nor is the month title tappable, so state.displayedMonth is still ' +
      `stuck on '${result.displayedMonthTitle}' instead of returning to today's month ` +
      `('${setup.originalMonthTitle}'). The user's only option is to count taps/swipes back manually.`
  );
  assert.equal(
    result.domTitle,
    setup.originalMonthTitle,
    "the rendered #monthTitle text doesn't agree with state.displayedMonth after trying to return to today"
  );
});
