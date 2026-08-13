// Reproduces the review finding: "No responsive rules at all: brush bar is
// clipped on a 4.7" phone and three screens down in landscape" (styles.css:
// the only @media query is `prefers-color-scheme` at line ~32; `main`
// [~189-194] and `.calendar-card` [~202-207] have no max-width; `.day-cell`
// [~257-259] sizes every cell via a fixed `aspect-ratio: 0.82` with nothing
// capping the resulting grid height).
//
// Root cause: because nothing constrains the calendar grid's height on
// short viewports, the page's total content height (topbar + hint banner +
// month title + weekday row + up to 6 rows of aspect-ratio-driven day cells
// + notes hint + handover/stats rows) can exceed the viewport height. The
// footer `.brush-bar` - which holds the Papa/Mama radio buttons that every
// paint interaction depends on - sits at the very bottom of that flow with
// no `position: sticky`, so on a 375x667 viewport (iPhone SE / mini class)
// with the first-run notes hint visible, it is measured pushed below the
// fold (finding: document scrollHeight 717px vs. 667px viewport, brush-bar
// starting at y=647).
//
// This test loads the app at 375x667 with the first-run notes hint visible
// (a fresh install, i.e. localStorage cleared) and asserts that the
// Papa/Mama brush buttons are fully within the viewport without the user
// having to scroll - i.e. their bounding box bottom edge is <= the
// viewport height.
//
// - Current (unfixed) styles.css: the brush buttons' bottom edge is well
//   past y=667, so this test FAILS.
// - Fixed styles.css (e.g. a short-viewport media query capping the grid
//   height, and/or `position: sticky; bottom: 0` on `.brush-bar`): the
//   brush buttons stay within the 667px viewport, so this test PASSES.
const { test, expect } = require("@playwright/test");
const assert = require("node:assert/strict");

test.use({
  viewport: { width: 375, height: 667 },
  serviceWorkers: "block",
});

test("Papa/Mama brush bar stays within the viewport on a 375x667 phone with the first-run hint visible", async ({ page }) => {
  await page.goto("/index.html");
  // Fresh install: nothing dismissed yet, so the first-run notes hint is
  // showing - exactly the state the finding was measured in.
  await page.evaluate(() => localStorage.clear());
  await page.reload();
  await page.waitForSelector("#dayGrid .day-cell");

  const notesHint = page.locator("#notesHint");
  await expect(notesHint).toBeVisible();

  const viewportSize = page.viewportSize();
  assert.ok(viewportSize, "expected a viewport size to be set for this test");

  const p1Brush = page.locator("#p1Brush");
  const p2Brush = page.locator("#p2Brush");
  await expect(p1Brush).toBeVisible();
  await expect(p2Brush).toBeVisible();

  const p1Box = await p1Brush.boundingBox();
  const p2Box = await p2Brush.boundingBox();
  assert.ok(p1Box, "expected #p1Brush to be laid out with a bounding box");
  assert.ok(p2Box, "expected #p2Brush to be laid out with a bounding box");

  const documentScrollHeight = await page.evaluate(() => document.documentElement.scrollHeight);

  console.log(
    `viewport=${viewportSize.width}x${viewportSize.height} documentScrollHeight=${documentScrollHeight}`,
    `p1Brush bottom=${p1Box.y + p1Box.height} p2Brush bottom=${p2Box.y + p2Box.height}`
  );

  assert.ok(
    p1Box.y + p1Box.height <= viewportSize.height,
    `BUG: the "Papa" brush button's bottom edge (y=${(p1Box.y + p1Box.height).toFixed(1)}) is below the ` +
      `${viewportSize.height}px viewport (document scrollHeight=${documentScrollHeight}px) - the person ` +
      "selector every interaction depends on is clipped below the fold on first launch."
  );

  assert.ok(
    p2Box.y + p2Box.height <= viewportSize.height,
    `BUG: the "Mama" brush button's bottom edge (y=${(p2Box.y + p2Box.height).toFixed(1)}) is below the ` +
      `${viewportSize.height}px viewport (document scrollHeight=${documentScrollHeight}px) - the person ` +
      "selector every interaction depends on is clipped below the fold on first launch."
  );
});
