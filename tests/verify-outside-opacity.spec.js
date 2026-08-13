const { test } = require('@playwright/test');

test('check outside day in light theme', async ({ page }) => {
  await page.emulateMedia({ colorScheme: 'light' });
  await page.goto('http://localhost:8934/index.html');
  await page.waitForSelector('.day-cell.outside');

  // Take a screenshot of the calendar area
  await page.screenshot({ path: '/tmp/light-calendar.png', clip: { x: 0, y: 50, width: 600, height: 600 } });

  // Get an outside day that has ownership fill (p1 or p2)
  const outsideCells = page.locator('.day-cell.outside');
  const count = await outsideCells.count();

  console.log(`Found ${count} outside cells`);

  for (let i = 0; i < Math.min(count, 3); i++) {
    const cell = outsideCells.nth(i);
    const classList = await cell.getAttribute('class');
    const styles = await cell.evaluate(el => {
      const computed = window.getComputedStyle(el);
      return {
        backgroundColor: computed.backgroundColor,
        opacity: computed.opacity
      };
    });
    console.log(`Cell ${i}: class="${classList}", styles=`, styles);
  }
});

test('check outside day in dark theme', async ({ page }) => {
  await page.emulateMedia({ colorScheme: 'dark' });
  await page.goto('http://localhost:8934/index.html');
  await page.waitForSelector('.day-cell.outside');

  // Take a screenshot of the calendar area
  await page.screenshot({ path: '/tmp/dark-calendar.png', clip: { x: 0, y: 50, width: 600, height: 600 } });

  // Get an outside day that has ownership fill (p1 or p2)
  const outsideCells = page.locator('.day-cell.outside');
  const count = await outsideCells.count();

  console.log(`Found ${count} outside cells in dark mode`);

  for (let i = 0; i < Math.min(count, 3); i++) {
    const cell = outsideCells.nth(i);
    const classList = await cell.getAttribute('class');
    const styles = await cell.evaluate(el => {
      const computed = window.getComputedStyle(el);
      return {
        backgroundColor: computed.backgroundColor,
        opacity: computed.opacity
      };
    });
    console.log(`Cell ${i}: class="${classList}", styles=`, styles);
  }
});
