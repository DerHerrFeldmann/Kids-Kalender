// Repro for review finding: "user-scalable=no disables pinch zoom"
// (index.html:~5, <meta name="viewport" ...>).
//
// The viewport meta sets `user-scalable=no`, which blocks pinch-to-zoom in
// browsers that honour it (notably older WebKit and Android). Users who
// need magnification to read the 12-14px day numbers and stats have no way
// to enlarge the calendar, which is an outright failure of WCAG 1.4.4
// Resize Text.
//
// This test FAILS on the current index.html: the viewport meta's `content`
// attribute contains `user-scalable=no` (and/or a `maximum-scale` that caps
// zoom below 2x). It should PASS once the meta is simplified to e.g.
// `width=device-width, initial-scale=1, viewport-fit=cover` - i.e. no
// user-scalable=no and no restrictive maximum-scale.
const { test, expect } = require("@playwright/test");

test.use({ serviceWorkers: "block" });

test("viewport meta does not disable pinch-to-zoom", async ({ page }) => {
  await page.goto("/index.html");

  const content = await page.locator('meta[name="viewport"]').getAttribute("content");
  expect(content).not.toBeNull();
  console.log("viewport meta content:", content);

  const directives = Object.fromEntries(
    content
      .split(",")
      .map((part) => part.trim())
      .filter(Boolean)
      .map((part) => {
        const [key, value] = part.split("=").map((s) => s.trim());
        return [key.toLowerCase(), value];
      })
  );

  expect(
    directives["user-scalable"],
    `BUG: viewport meta contains "user-scalable=${directives["user-scalable"]}", which blocks ` +
      "pinch-to-zoom in browsers that honour it (older WebKit/Android). Low-vision users have no " +
      "way to enlarge the 12-14px day numbers/stats - a WCAG 1.4.4 Resize Text failure."
  ).not.toBe("no");

  if (directives["maximum-scale"] !== undefined) {
    const maxScale = parseFloat(directives["maximum-scale"]);
    expect(
      maxScale,
      `BUG: viewport meta caps zoom at maximum-scale=${directives["maximum-scale"]}, which still ` +
        "prevents users from magnifying the page enough to read small text (WCAG 1.4.4)."
    ).toBeGreaterThanOrEqual(2);
  }
});
