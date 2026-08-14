// Reported bug: in Mehrfachauswahl (paint-drag) mode, dragging across a day
// already owned by the OTHER parent silently overwrote it with the active
// brush's owner, instead of combining it into a shared "both" day the way a
// single tap on that same day would. The drag used to decide one fixed
// owner from the FIRST cell touched and apply that same value to every
// other cell regardless of that cell's own prior owner (see paintCell()).
// Fixed: each touched cell now runs the same nextOwner/COMBINE_TABLE rule a
// lone tap on it would have used, based on *that cell's own* current owner.
const { test, expect } = require("@playwright/test");

test.use({ viewport: { width: 480, height: 1000 }, serviceWorkers: "block" });

test('dragging from an empty day across a day owned by the other parent turns that day "both" instead of overwriting it', async ({ page }) => {
  await page.goto("/index.html");

  const dateKeys = await page.evaluate(() => {
    const now = new Date();
    const y = now.getFullYear();
    const m = String(now.getMonth() + 1).padStart(2, "0");
    const pad = (d) => String(d).padStart(2, "0");
    return { d10: `${y}-${m}-${pad(10)}`, d11: `${y}-${m}-${pad(11)}`, d12: `${y}-${m}-${pad(12)}` };
  });

  // Day 10 = empty, day 11 = already owned by p1 ("Papa"), day 12 = empty.
  // Active brush = p2 ("Mama"). Drag starts on day 10 (empty), so the old
  // bug would lock the whole drag's owner to plain "p2" and stomp day 11.
  await page.evaluate((keys) => {
    localStorage.setItem("kk.entries", JSON.stringify({ [keys.d11]: "p1" }));
    localStorage.setItem("kk.splitOrder", JSON.stringify({}));
    localStorage.setItem("kk.activeBrush", "p2");
  }, dateKeys);

  await page.reload();
  await page.waitForSelector("#dayGrid .day-cell");
  await page.click("#paintModeBtn");
  await page.waitForSelector("#dayGrid.paint-mode");

  const center = async (key) => {
    const box = await page.locator(`.day-cell[data-date="${key}"]`).boundingBox();
    return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
  };
  const c10 = await center(dateKeys.d10);
  const c11 = await center(dateKeys.d11);
  const c12 = await center(dateKeys.d12);

  await page.mouse.move(c10.x, c10.y);
  await page.mouse.down();
  await page.mouse.move(c10.x + 2, c10.y + 1); // jitter under PAINT_DRAG_THRESHOLD
  await page.mouse.move(c11.x, c11.y, { steps: 5 });
  await page.mouse.move(c12.x, c12.y, { steps: 5 });
  await page.mouse.up();

  const ownerOf = (key) =>
    page.evaluate((k) => {
      const cell = document.querySelector(`.day-cell[data-date="${k}"]`);
      return cell.classList.contains("both") ? "both" : cell.classList.contains("p1") ? "p1" : cell.classList.contains("p2") ? "p2" : "none";
    }, key);

  await expect.poll(() => ownerOf(dateKeys.d10)).toBe("p2"); // empty -> painted with the active brush
  await expect.poll(() => ownerOf(dateKeys.d11)).toBe("both"); // p1's day -> combined, not overwritten
  await expect.poll(() => ownerOf(dateKeys.d12)).toBe("p2");
});
