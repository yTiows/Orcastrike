// CONFIGURATION.md covers every value, and stays in sync with the code that defines them.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DOC_PATH, renderConfigDoc, v1Leaves } from "../scripts/gen-config-doc.mjs";
import { SCHEMA, V1_DEFAULTS_CLASSIFICATION } from "../config/settings-schema.js";

const CLASSES = ["invariant", "developer_default", "user_setting"];

test("every v1 default leaf is classified, and nothing classified is stale", () => {
  const leaves = v1Leaves();
  assert.deepEqual(leaves.filter((k) => !V1_DEFAULTS_CLASSIFICATION[k]), []);
  assert.deepEqual(Object.keys(V1_DEFAULTS_CLASSIFICATION).filter((k) => !leaves.includes(k)), []);
  for (const [k, [cls, persistence, validation]] of Object.entries(V1_DEFAULTS_CLASSIFICATION)) {
    assert.ok(CLASSES.includes(cls), k);
    assert.ok(persistence && validation, `${k} needs persistence and validation`);
  }
});

test("every research setting has a class, a default, persistence and a doc; user settings have bounds or options", () => {
  const keys = new Set();
  for (const e of SCHEMA) {
    assert.ok(!keys.has(e.key), `duplicate ${e.key}`);
    keys.add(e.key);
    assert.ok(CLASSES.includes(e.class), e.key);
    assert.ok("default" in e && e.persistence && e.doc, e.key);
    const numeric = typeof e.default === "number" || (e.default === null && e.unit);
    if (e.class === "user_setting" && numeric) assert.ok(e.min !== undefined && e.max !== undefined, `${e.key} needs min/max`);
  }
});

test("CONFIGURATION.md is generated from the current code (run scripts/gen-config-doc.mjs)", () => {
  const doc = readFileSync(DOC_PATH, "utf8");
  assert.equal(doc, renderConfigDoc());
  for (const e of SCHEMA) assert.ok(doc.includes(`\`${e.key}\``), e.key);
  for (const k of v1Leaves()) assert.ok(doc.includes(`\`${k}\``), k);
  assert.ok(!doc.includes("UNCLASSIFIED"));
});
