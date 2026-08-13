// Repro for review finding: "Settings dialog inputs have no programmatic
// labels" (index.html:~113-134, #settingsDialog / .person-group markup).
//
// The four settings controls (#p1NameInput, #p1ColorInput, #p2NameInput,
// #p2ColorInput) sit next to a <span class="group-label">Person 1</span>
// (or "Person 2") and, for the name inputs, a placeholder="Name" - but
// neither is programmatically associated with the input via <label for>,
// aria-label, or aria-labelledby. A placeholder is not an accessible name
// (and disappears once the field has a value), and a bare adjacent <span>
// is invisible to the accessibility tree unless explicitly wired up. As a
// result a screen reader announces both name fields identically as an
// unlabelled "edit text" and both color pickers identically as a bare
// "color" control, with no indication of which belongs to Person 1 vs.
// Person 2. Neither <dialog> has an accessible name either, since <dialog>
// does not derive one from a nested <h2> automatically.
//
// This test computes each input's accessible name the same way assistive
// tech does (@axe-core/playwright's accname evaluation via a full a11y
// scan of the open dialog, plus a direct check that <label for=...>,
// aria-label or aria-labelledby is actually present). It FAILS against the
// current index.html because axe reports "label" violations for all four
// inputs and none of them has any of the three valid labelling mechanisms.
// It should PASS once each input is wrapped in/associated with a real
// <label> (or given aria-label / aria-labelledby) that names both the
// field's purpose and which person it belongs to, and once both dialogs
// gain an aria-labelledby pointing at their heading.
const { test, expect } = require("@playwright/test");
const AxeBuilder = require("@axe-core/playwright").default;
const assert = require("node:assert/strict");

test.use({ serviceWorkers: "block" });

// Accessible-name resolution per the input's associated <label for>,
// aria-label, and aria-labelledby - the three mechanisms the review's
// recommendation calls out. This mirrors (a simplified form of) the
// browser/AT accessible-name computation without pulling in a full
// implementation.
async function hasProgrammaticLabel(page, selector) {
  return page.evaluate((sel) => {
    const el = document.querySelector(sel);
    if (!el) return false;
    if (el.hasAttribute("aria-label") && el.getAttribute("aria-label").trim() !== "") {
      return true;
    }
    if (el.hasAttribute("aria-labelledby")) {
      const ids = el.getAttribute("aria-labelledby").trim().split(/\s+/);
      if (ids.length && ids.every((id) => document.getElementById(id))) return true;
    }
    if (el.id && document.querySelector(`label[for="${el.id}"]`)) return true;
    if (el.closest("label")) return true;
    return false;
  }, selector);
}

test("settings dialog name/color inputs have a real programmatic label", async ({ page }) => {
  await page.goto("/index.html");
  await page.click("#settingsBtn");
  await page.waitForSelector("#settingsDialog[open]");

  const inputs = ["#p1NameInput", "#p1ColorInput", "#p2NameInput", "#p2ColorInput"];
  const results = {};
  for (const sel of inputs) {
    results[sel] = await hasProgrammaticLabel(page, sel);
  }
  console.log("programmatic-label presence per input:", results);

  for (const sel of inputs) {
    assert.ok(
      results[sel],
      `BUG: ${sel} has no programmatic label - it is associated with neither a ` +
        "<label for>, an aria-label, nor an aria-labelledby, so a screen reader " +
        'announces it as a bare, unnamed control (e.g. "edit text" / "color") ' +
        "with no indication of which field or which person it belongs to."
    );
  }
});

test("axe reports no label violations for the open settings dialog", async ({ page }) => {
  await page.goto("/index.html");
  await page.click("#settingsBtn");
  await page.waitForSelector("#settingsDialog[open]");

  const results = await new AxeBuilder({ page })
    .include("#settingsDialog")
    .withRules(["label", "aria-input-field-name"])
    .analyze();

  const labelViolations = results.violations.filter(
    (v) => v.id === "label" || v.id === "aria-input-field-name"
  );
  const offendingTargets = labelViolations.flatMap((v) =>
    v.nodes.map((n) => n.target.join(" "))
  );
  console.log("axe label-related violations:", JSON.stringify(labelViolations, null, 2));

  assert.deepStrictEqual(
    offendingTargets,
    [],
    "BUG: axe-core flags the settings dialog's name/color inputs as missing an " +
      `accessible name: ${JSON.stringify(offendingTargets)}`
  );
});
