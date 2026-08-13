// Repro for review finding: "'__proto__' key in a restored map re-parents
// state.entries, creating calendar entries the user cannot delete"
// (webapp/app.js, migrateLegacyOwnerMap, ~line 254).
//
// Claimed scenario:
//   Importing a backup / poisoning localStorage with
//     {"entries": {"__proto__": {"<dateKey>": "p1"}}}
//   makes migrateLegacyOwnerMap do `migrated["__proto__"] = <that object>`,
//   which (since `migrated` is a plain {} still linked to Object.prototype)
//   invokes the __proto__ accessor and re-parents `migrated` itself, so
//   `migrated["<dateKey>"]` resolves to "p1" as an *inherited* property.
//   That phantom entry can't be removed via the UI (setOwner/undoLastAction
//   both use `delete state.entries[key]`, a no-op on an inherited key) and
//   silently disappears from any JSON export (JSON.stringify only walks own
//   properties), so the calendar can show a day no backup/export contains.
//
// This test loads the *real* migrateLegacyOwnerMap out of the current
// webapp/app.js (via vm, executing only the prefix of the file needed to
// define it, so it can't drift from a hand-copied reimplementation) and
// feeds it the exact payload from the finding.

"use strict";

const { test } = require("@playwright/test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const APP_JS_PATH = path.join(__dirname, "..", "app.js");

// Load only the portion of app.js up to (but not including) loadState():
// migrateLegacyOwnerMap and its dependencies (migrateLegacyOwner,
// VALID_OWNERS) are all defined before that point, and everything before it
// only touches document.documentElement / getComputedStyle at module scope,
// which we stub. This avoids needing a full DOM to exercise pure logic.
function loadMigrateLegacyOwnerMap() {
  const src = fs.readFileSync(APP_JS_PATH, "utf8");
  const marker = "function loadState";
  const cutoff = src.indexOf(marker);
  assert.ok(cutoff > 0, `expected to find "${marker}" in app.js - has the file structure changed?`);

  const sandbox = {
    document: { documentElement: {} },
    getComputedStyle: () => ({ getPropertyValue: () => "" }),
    console,
  };
  vm.createContext(sandbox);
  vm.runInContext(src.slice(0, cutoff), sandbox, { filename: "app.js (prefix up to loadState)" });

  assert.strictEqual(
    typeof sandbox.migrateLegacyOwnerMap,
    "function",
    "migrateLegacyOwnerMap should be defined by this point in app.js"
  );
  // The vm sandbox is a separate realm with its own Object/Object.prototype,
  // distinct from this test file's. Any object created *inside* the sandbox
  // (e.g. migrateLegacyOwnerMap's return value) must be compared against
  // *that* realm's Object.prototype, not this file's - otherwise a
  // same-shape-but-different-realm prototype would wrongly look identical
  // or wrongly look different regardless of the actual bug.
  return {
    migrateLegacyOwnerMap: sandbox.migrateLegacyOwnerMap,
    sandboxObjectPrototype: vm.runInContext("Object.prototype", sandbox),
  };
}

test('a "__proto__" key in an imported entries map must not create an inherited/undeletable calendar entry', () => {
  const { migrateLegacyOwnerMap, sandboxObjectPrototype } = loadMigrateLegacyOwnerMap();

  // Exact payload from the finding: a backup file whose "entries" map has
  // a "__proto__" key mapping to an object with a real date -> owner entry.
  // JSON.parse creates "__proto__" as an ordinary own enumerable property
  // (it does not itself trigger the accessor), so this is a realistic
  // parse of an attacker-supplied backup file, not a JS-literal artifact.
  const maliciousBackup = JSON.parse('{"entries":{"__proto__":{"2026-08-20":"p1"}}}');
  assert.deepStrictEqual(
    Object.keys(maliciousBackup.entries),
    ["__proto__"],
    'sanity check: JSON.parse should produce "__proto__" as an own key, not silently reparent maliciousBackup.entries itself'
  );

  const migrated = migrateLegacyOwnerMap(maliciousBackup.entries);

  // Bug per the finding: migrated["__proto__"] = <object> re-parents
  // `migrated`, so migrated["2026-08-20"] resolves via the prototype chain
  // to "p1" even though "2026-08-20" was never an owner value written by
  // the user - and being inherited (not own), `delete migrated["2026-08-20"]`
  // is a no-op, so the phantom entry can never be cleared.
  assert.strictEqual(
    migrated["2026-08-20"],
    undefined,
    'BUG: entries["2026-08-20"] leaked a value ("p1") purely via the prototype chain (a "__proto__" key ' +
      "re-parented the result of migrateLegacyOwnerMap) - this phantom entry cannot be deleted through the UI " +
      "(delete on an inherited key is a no-op) and vanishes from JSON.stringify exports."
  );

  // Corollary of the same bug: the result object's actual prototype must
  // stay Object.prototype - if it doesn't, `delete migrated[key]` for the
  // legitimate case (a real day being un-painted) is also compromised.
  assert.strictEqual(
    Object.getPrototypeOf(migrated),
    sandboxObjectPrototype,
    'BUG: a "__proto__" key in the imported map overwrote the internal prototype of migrateLegacyOwnerMap\'s result object'
  );
});
