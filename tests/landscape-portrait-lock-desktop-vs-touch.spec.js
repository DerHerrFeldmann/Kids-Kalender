// Regression test: an earlier version of the landscape "force portrait" CSS
// (styles.css) gated purely on `(orientation: landscape)`, which also fired
// for any desktop/laptop browser window wider than tall -- rotating <html>
// broke position:fixed-based UI everywhere (native <dialog> centers itself
// via position:fixed, whose containing block becomes the transformed
// ancestor instead of the viewport once a `transform` is present), which is
// exactly why dozens of unrelated tests started failing. The fix additionally
// gates on (hover: none) and (pointer: coarse), so it only ever applies on an
// actual touchscreen phone.
const { test, expect } = require("@playwright/test");

test.use({ serviceWorkers: "block" });

async function htmlTransform(page) {
  return page.evaluate(() => getComputedStyle(document.documentElement).transform);
}

test("a landscape-shaped DESKTOP window (mouse/no touch) does not rotate <html>", async ({ browser }) => {
  const context = await browser.newContext({
    viewport: { width: 1280, height: 720 },
    hasTouch: false,
    serviceWorkers: "block",
  });
  try {
    const page = await context.newPage();
    await page.goto("/index.html");
    await page.waitForFunction(() => document.getElementById("dayGrid").children.length > 0);

    expect(await htmlTransform(page)).toBe("none");

    // The regression this guards against broke <dialog> centering specifically
    // (position:fixed containing-block changes once a transform is present on
    // an ancestor) -- assert the settings dialog still opens and is usable.
    await page.click("#settingsBtn");
    await expect(page.locator("#settingsDialog")).toBeVisible();
  } finally {
    await context.close();
  }
});

test("a landscape-shaped TOUCH phone viewport does rotate <html> back to portrait", async ({ browser }) => {
  const context = await browser.newContext({
    viewport: { width: 926, height: 428 },
    hasTouch: true,
    isMobile: true,
    serviceWorkers: "block",
  });
  try {
    const page = await context.newPage();
    await page.goto("/index.html");
    await page.waitForFunction(() => document.getElementById("dayGrid").children.length > 0);

    expect(await htmlTransform(page)).not.toBe("none");

    // The rotated box should still exactly cover the physical viewport.
    const appBox = await page.evaluate(() => {
      const r = document.querySelector(".app").getBoundingClientRect();
      return { width: r.width, height: r.height };
    });
    expect(appBox.width).toBe(926);
    expect(appBox.height).toBe(428);

    // Click coordinates should still resolve through the transform correctly.
    // #todayBtn starts disabled (app boots on the current month), so navigate
    // away first -- otherwise clicking anywhere at all would leave it
    // "disabled" and the assertion below would pass without the click having
    // actually landed on the button.
    await page.evaluate(() => document.getElementById("prevMonth").click());
    await expect(page.locator("#todayBtn")).toBeEnabled();

    const todayBtn = await page.evaluate(() => {
      const r = document.getElementById("todayBtn").getBoundingClientRect();
      return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
    });
    await page.mouse.click(todayBtn.x, todayBtn.y);
    await expect(page.locator("#todayBtn")).toBeDisabled();
  } finally {
    await context.close();
  }
});
