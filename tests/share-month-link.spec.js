// Covers the "share one month as a link" mechanism (app.js: shareMonthLink,
// parseShareHash, mergeSharedMonth, handleIncomingShare):
//   1. Sharing a month builds a link carrying only that month's entries/notes.
//   2. Opening that link on another "device" (fresh localStorage) prompts for
//      confirmation, then on accept overwrites the whole target month --
//      including days the recipient already had filled in differently --
//      while leaving every other month untouched.
//   3. Declining the prompt leaves the recipient's data unchanged.
// In both cases the #share=... hash is stripped so reloading can't replay it.
const { test, expect } = require("@playwright/test");

test.use({ serviceWorkers: "block" });

async function seedSenderMonth(page) {
  await page.evaluate(() => {
    state.displayedMonth = new Date(2026, 7, 1); // August 2026
    state.entries["2026-08-05"] = "p1";
    state.entries["2026-08-06"] = "p2";
    state.notes["2026-08-05"] = "Zahnarzt";
    // Outside the shared month - must never travel with the link.
    state.entries["2026-09-01"] = "p1";
    saveEntryState();
    saveJSON("notes");
    render();
  });
}

async function buildShareLink(page) {
  await page.evaluate(() => {
    window.__capturedShare = null;
    navigator.share = (data) => {
      window.__capturedShare = data;
      return Promise.resolve();
    };
  });
  await page.locator("#shareBtn").click();
  await page.waitForSelector("#shareDialog[open]");
  await page.locator('#shareDialog button[value="link"]').click();
  await page.waitForFunction(() => window.__capturedShare !== null);
  return page.evaluate(() => window.__capturedShare.url);
}

test("opening a shared-month link overwrites that month only, after confirmation", async ({ page }) => {
  await page.goto("/", { waitUntil: "load" });
  await page.evaluate(() => localStorage.clear());
  await page.reload({ waitUntil: "load" });
  await page.waitForFunction(() => document.getElementById("dayGrid").children.length > 0);

  await seedSenderMonth(page);
  const shareUrl = await buildShareLink(page);
  expect(shareUrl).toMatch(/#share=/);

  // Simulate a different device: wipe local data, then seed a conflicting
  // entry inside the shared month and a control entry outside it.
  await page.evaluate(() => {
    localStorage.clear();
    localStorage.setItem(
      "kk.entries",
      JSON.stringify({ "2026-08-05": "p2", "2026-07-01": "p1" })
    );
  });

  let confirmMessage = null;
  page.once("dialog", (dialog) => {
    confirmMessage = dialog.message();
    dialog.accept();
  });

  // A bare hash-only URL change from the current page would be a
  // same-document navigation (no reload, init() never re-runs) - opening a
  // link from WhatsApp is always a genuine fresh navigation, so force one.
  await page.goto("about:blank");
  await page.goto(shareUrl, { waitUntil: "load" });
  await page.waitForFunction(() => document.getElementById("dayGrid").children.length > 0);

  expect(confirmMessage).toContain("AUGUST");

  const result = await page.evaluate(() => ({
    entries: state.entries,
    notes: state.notes,
    hash: location.hash,
    storedEntries: JSON.parse(localStorage.getItem("kk.entries")),
  }));

  expect(result.hash).toBe("");
  // Overwritten by the sender's value, not left at the recipient's own "p2".
  expect(result.entries["2026-08-05"]).toBe("p1");
  expect(result.entries["2026-08-06"]).toBe("p2");
  expect(result.notes["2026-08-05"]).toBe("Zahnarzt");
  // Untouched: outside the shared month on both ends.
  expect(result.entries["2026-07-01"]).toBe("p1");
  expect(result.entries["2026-09-01"]).toBeUndefined();
  expect(result.storedEntries["2026-08-05"]).toBe("p1");
});

test("declining the import prompt leaves the recipient's data unchanged", async ({ page }) => {
  await page.goto("/", { waitUntil: "load" });
  await page.evaluate(() => localStorage.clear());
  await page.reload({ waitUntil: "load" });
  await page.waitForFunction(() => document.getElementById("dayGrid").children.length > 0);

  await seedSenderMonth(page);
  const shareUrl = await buildShareLink(page);

  await page.evaluate(() => {
    localStorage.clear();
    localStorage.setItem("kk.entries", JSON.stringify({ "2026-08-05": "p2" }));
  });

  page.once("dialog", (dialog) => dialog.dismiss());

  await page.goto("about:blank");
  await page.goto(shareUrl, { waitUntil: "load" });
  await page.waitForFunction(() => document.getElementById("dayGrid").children.length > 0);

  const result = await page.evaluate(() => ({
    entries: state.entries,
    hash: location.hash,
  }));

  expect(result.hash).toBe("");
  expect(result.entries["2026-08-05"]).toBe("p2");
  expect(result.entries["2026-08-06"]).toBeUndefined();
});
