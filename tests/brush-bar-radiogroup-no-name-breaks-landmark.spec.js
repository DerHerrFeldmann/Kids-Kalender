// Repro for review finding: "Brush bar: role=\"radiogroup\" on <footer> has no
// accessible name, no radio keyboard pattern, and destroys the contentinfo
// landmark" (index.html:110-119 `<footer class="brush-bar" role="radiogroup">`
// with `<button role="radio">` children; selection handled by plain click
// listeners in app.js around updateBrushActiveStyles()/the
// #p1Brush/#p2Brush click handlers).
//
// Three problems in one construct:
//
// (1) The radiogroup has neither aria-label nor aria-labelledby, so a screen
// reader announces "Papa, radio button, checked" with no indication of what
// the group controls - the group decides what every calendar tap does
// (WCAG 4.1.2 / 1.3.1).
//
// (2) It claims the radio/radiogroup pattern but implements none of it: both
// #p1Brush and #p2Brush stay in the tab order (tabIndex 0/0, i.e. no roving
// tabindex onto only the checked radio) and there is no ArrowLeft/ArrowRight
// handling to move focus+selection between them - only plain `click`
// listeners. The announced semantics (a radiogroup) contradict the actual
// keyboard behaviour (two independent tab stops, no arrow-key support).
//
// (3) Putting role="radiogroup" on <footer> overrides its implicit
// contentinfo role. axe-core reports both `aria-allowed-role` (this role is
// not allowed on <footer>) and `region` ("some page content is not contained
// by landmarks") for this element, so the brush bar drops out of landmark
// navigation entirely.
//
// This test FAILS against the current index.html/app.js because:
//  - axe reports aria-allowed-role and region violations targeting <footer>;
//  - the [role="radiogroup"] element has no aria-label and no resolving
//    aria-labelledby; and
//  - both [role="radio"] buttons have tabIndex 0 (no roving tabindex) and
//    ArrowRight does not move focus between them.
// It PASSES once either (A) the radiogroup role is moved off the <footer>
// landmark onto an inner wrapper that has an aria-label, and the real radio
// keyboard pattern (roving tabindex + arrow keys) is implemented, or (B) the
// role="radio"/"radiogroup" attributes are dropped entirely in favour of two
// plain toggle buttons with aria-pressed (matching the existing click-only
// behaviour) - in which case there is no radiogroup/radio role left for this
// test to hold to the stricter pattern, and only the landmark check applies.
const { test } = require("@playwright/test");
const AxeBuilder = require("@axe-core/playwright").default;
const assert = require("node:assert/strict");

test.use({ serviceWorkers: "block" });

test("brush bar footer keeps a valid landmark role (no aria-allowed-role / region violations)", async ({
  page,
}) => {
  await page.goto("/index.html");
  await page.waitForSelector("#dayGrid .day-cell");

  const results = await new AxeBuilder({ page }).withRules(["aria-allowed-role", "region"]).analyze();

  const relevant = results.violations.filter((v) => v.id === "aria-allowed-role" || v.id === "region");
  const offendingTargets = relevant.flatMap((v) => v.nodes.map((n) => n.target.join(" ")));
  console.log("aria-allowed-role/region violations:", JSON.stringify(relevant, null, 2));

  assert.deepStrictEqual(
    offendingTargets,
    [],
    `BUG: axe reports landmark-role violation(s) targeting: ${JSON.stringify(offendingTargets)}. ` +
      'Putting role="radiogroup" directly on <footer class="brush-bar"> overrides its implicit ' +
      "contentinfo role (aria-allowed-role: role not allowed on footer) and removes the brush bar from " +
      'landmark navigation entirely (region: "some page content is not contained by landmarks"). The role ' +
      "should live on a wrapper element inside the footer, not on the landmark element itself."
  );
});

test("any radiogroup/radio roles on the brush bar have an accessible name and a real keyboard pattern", async ({
  page,
}) => {
  await page.goto("/index.html");
  await page.waitForSelector("#dayGrid .day-cell");

  // --- Part 1: if a radiogroup role exists, it must have an accessible name.
  const groupInfo = await page.evaluate(() => {
    const rg = document.querySelector('[role="radiogroup"]');
    if (!rg) return null;
    const labelledbyId = rg.getAttribute("aria-labelledby");
    return {
      outerHTML: rg.outerHTML.slice(0, 120),
      ariaLabel: rg.getAttribute("aria-label"),
      ariaLabelledby: labelledbyId,
      labelledbyResolves: labelledbyId ? !!document.getElementById(labelledbyId) : false,
    };
  });
  console.log("radiogroup info:", groupInfo);

  if (groupInfo) {
    const hasAccessibleName =
      (groupInfo.ariaLabel && groupInfo.ariaLabel.trim() !== "") ||
      (groupInfo.ariaLabelledby && groupInfo.labelledbyResolves);
    assert.ok(
      hasAccessibleName,
      `BUG: ${groupInfo.outerHTML} has role="radiogroup" but neither a non-empty aria-label nor a ` +
        `resolving aria-labelledby (aria-label=${JSON.stringify(groupInfo.ariaLabel)}, ` +
        `aria-labelledby=${JSON.stringify(groupInfo.ariaLabelledby)}) - a screen reader announces its ` +
        '"radio" children (e.g. "Papa, radio button, checked") with no indication of what the group ' +
        "controls."
    );
  }

  // --- Part 2: if radio roles exist, they must implement the real radio
  // keyboard pattern (roving tabindex onto the checked radio, arrow keys
  // move focus+selection) rather than just claiming the role via markup.
  const radios = await page.locator('[role="radio"]').all();
  console.log("role=radio element count:", radios.length);

  if (radios.length > 0) {
    const tabIndexes = [];
    for (const r of radios) tabIndexes.push(await r.evaluate((el) => el.tabIndex));
    const tabbableCount = tabIndexes.filter((t) => t === 0).length;
    console.log("radio tabIndex values:", tabIndexes);

    assert.equal(
      tabbableCount,
      1,
      `BUG: role="radio" is used on ${radios.length} element(s), but ${tabbableCount} of them are in the ` +
        `tab order (tabIndex values: ${JSON.stringify(tabIndexes)}). A real radiogroup exposes exactly one ` +
        "tab stop - the checked radio - via a roving tabindex, with the other radio(s) at tabIndex -1; " +
        "this app leaves every radio individually focusable, which is not how a radiogroup behaves."
    );

    const firstId = await radios[0].evaluate((el) => el.id);
    await radios[0].focus();
    const focusedBefore = await page.evaluate(() => document.activeElement.id);
    await page.keyboard.press("ArrowRight");
    const focusedAfterArrow = await page.evaluate(() => document.activeElement.id);
    console.log(`focus before/after ArrowRight from ${firstId}:`, focusedBefore, focusedAfterArrow);

    assert.notEqual(
      focusedAfterArrow,
      focusedBefore,
      `BUG: pressing ArrowRight while the first role="radio" element ("${focusedBefore}") is focused should ` +
        "move focus to the next radio per the standard radiogroup keyboard pattern (WAI-ARIA APG), but focus " +
        `stayed on "${focusedAfterArrow}" - there is no arrow-key handling at all, only plain click listeners.`
    );
  }
});
