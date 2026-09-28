// Browser storage fallbacks. IndexedDB itself (and the v1 → IndexedDB migration) is exercised in
// real Chromium by scripts/browser-smoke.mjs; Node has no IndexedDB, which is the "unavailable"
// case tested here.
import { test } from "node:test";
import assert from "node:assert/strict";
import { openStorage } from "../js/storage.js";

function fakeLocalStorage({ broken = false } = {}) {
  const m = new Map();
  return {
    getItem: (k) => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => {
      if (broken) throw new Error("QuotaExceededError");
      m.set(k, String(v));
    },
    removeItem: (k) => m.delete(k),
    _map: m,
  };
}

test("IndexedDB unavailable → localStorage fallback, with a visible warning", async () => {
  const ls = fakeLocalStorage();
  const { store, warnings, migration } = await openStorage({ indexedDB: undefined, localStorage: ls });
  assert.equal(store.kind, "localstorage");
  assert.match(warnings.join(" "), /IndexedDB unavailable/);
  assert.equal(migration, null);
  await store.set("ledger", { a: 1 });
  assert.deepEqual(await store.get("ledger"), { a: 1 });
  assert.ok([...ls._map.keys()].every((k) => k.startsWith("sat.fallback.")), "fallback never writes the v1 key");
});

test("no usable storage at all → memory store; warns the ledger will be lost on reload", async () => {
  const { store, warnings } = await openStorage({ indexedDB: undefined, localStorage: fakeLocalStorage({ broken: true }) });
  assert.equal(store.kind, "memory");
  assert.match(warnings.join(" "), /lost on reload; export it/);
});

test("IndexedDB open that never completes times out into the fallback instead of hanging", async () => {
  const hanging = { open: () => ({}) }; // request whose callbacks never fire
  const t0 = Date.now();
  const { store, warnings } = await openStorage({ indexedDB: hanging, localStorage: fakeLocalStorage() });
  assert.equal(store.kind, "localstorage");
  assert.match(warnings.join(" "), /timed out/);
  assert.ok(Date.now() - t0 < 6000);
});
