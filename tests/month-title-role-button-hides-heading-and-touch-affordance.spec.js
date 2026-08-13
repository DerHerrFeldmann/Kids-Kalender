// Reproduces: "The 'back to today' month title hides the current month from
// screen readers and looks non-interactive on touch" (index.html:75,
// app.js render() line ~628, styles.css #monthTitle rule around line 233).
//
// The "back to today" fix made #monthTitle a
// `role="button" ... aria-label="Zurück zum aktuellen Monat" aria-live="polite"`
// element. Two regressions follow from that:
//
// (a) An explicit `role` attribute always wins over an element's implicit
// role, so the <h1> is now exposed to assistive tech as a plain button
// named "Zurück zum aktuellen Monat" -- never as a heading, and never with
// the actual month/year text (set via .textContent in render(), so it never
// reaches the accessible name at all, since a static aria-label always wins
// over textContent in the accessible-name computation). The one on-screen
// element that announces which month is being viewed -- specifically
// wired with aria-live="polite" so screen-reader users hear it after every
// swipe/tap -- is unreachable as a heading and never speaks the month name.
//
// (b) Sighted touch users get no compensating visual affordance either:
// the only styling #monthTitle has beyond ordinary heading text is
// `cursor: pointer` (styles.css), which never renders on a touchscreen, so
// there is nothing to suggest the title is tappable.
//
// This test FAILS against the current index.html/app.js/styles.css: there
// is no accessible heading naming the displayed month, and #monthTitle has
// no visual tap affordance beyond cursor. It PASSES once the title is
// either (A) reverted to a plain, unadorned <h1> (real heading, exposing
// the month name) with a separate "Heute" control carrying the button
// semantics, or (B) given both a dynamic aria-label that includes the month
// text and a visible tappable treatment (underline/background/border), i.e.
// whatever the fix, *some* element ends up exposed as a heading naming the
// month, and the tappable control looks tappable without relying on
// hover-only cursor styling.
const { test } = require("@playwright/test");
const assert = require("node:assert/strict");

test.use({ serviceWorkers: "block" });

test("the displayed month is exposed as an accessible heading and its tap control looks tappable without a mouse", async ({
  page,
}) => {
  await page.goto("/");
  await page.waitForSelector("#dayGrid .day-cell");

  const monthText = (await page.locator("#monthTitle").textContent()).trim();
  console.log("Rendered month title text:", monthText);
  assert.ok(monthText.length > 0, "setup failed: #monthTitle rendered no text");

  // (a) There must be an accessible heading whose name announces the
  // currently displayed month -- this is the app's only on-screen
  // indication of which month is showing, and it's the element wired with
  // aria-live="polite" specifically so screen-reader users learn it after
  // every navigation.
  const monthHeading = page.getByRole("heading", { name: monthText, exact: true });
  const monthHeadingCount = await monthHeading.count();
  console.log(`Accessible heading named "${monthText}": count=${monthHeadingCount}`);

  const anyHeadingCount = await page.getByRole("heading").count();
  console.log("Total accessible headings on the page:", anyHeadingCount);

  assert.equal(
    monthHeadingCount,
    1,
    `BUG: no accessible heading named "${monthText}" exists (found ${anyHeadingCount} heading(s) in total). ` +
      '#monthTitle carries role="button", which always overrides its implicit <h1> heading role, and its ' +
      'static aria-label ("Zurück zum aktuellen Monat") wins over its textContent in the accessible-name ' +
      "computation -- so a screen-reader user navigating month by month has no heading, and no announcement " +
      "of which month is now displayed."
  );

  // (b) Whatever element carries the "jump back to today" tap behaviour --
  // #monthTitle itself if it's kept clickable, or a separate "Heute"-style
  // control if the fix moves the behaviour off the heading -- must look
  // tappable without relying on a hover-only `cursor` style, which never
  // renders on a touchscreen. Look for a visible affordance: an underline,
  // a non-transparent background, or a visible border.
  const heuteControl = page.getByRole("button", { name: /heute|zurück zum aktuellen monat/i });
  const tapControlLocator = (await heuteControl.count()) > 0 ? heuteControl.first() : page.locator("#monthTitle");
  const controlDescription = await tapControlLocator.evaluate((el) => el.outerHTML.slice(0, 120));
  console.log("Tap-back-to-today control:", controlDescription);

  const affordance = await tapControlLocator.evaluate((el) => {
    const cs = getComputedStyle(el);
    const bg = cs.backgroundColor;
    const hasBackground = !(
      bg === "rgba(0, 0, 0, 0)" ||
      bg === "transparent" ||
      cs.backgroundColor === ""
    );
    const hasUnderline = cs.textDecorationLine.includes("underline");
    const hasVisibleBorder =
      cs.borderStyle !== "none" && parseFloat(cs.borderWidth) > 0;
    return {
      cursor: cs.cursor,
      backgroundColor: bg,
      textDecorationLine: cs.textDecorationLine,
      borderStyle: cs.borderStyle,
      borderWidth: cs.borderWidth,
      hasBackground,
      hasUnderline,
      hasVisibleBorder,
    };
  });
  console.log("Month title computed affordance styles:", affordance);

  assert.ok(
    affordance.hasBackground || affordance.hasUnderline || affordance.hasVisibleBorder,
    "BUG: #monthTitle's only styling beyond plain heading text is `cursor: pointer` " +
      `(computed: background=${affordance.backgroundColor}, textDecorationLine=${affordance.textDecorationLine}, ` +
      `border=${affordance.borderStyle} ${affordance.borderWidth}), which never renders on a touchscreen -- so a ` +
      "sighted touch user has no visual indication that tapping the title does anything."
  );
});
