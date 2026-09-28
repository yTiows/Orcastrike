// Docs cite tests by their literal titles; a renamed or deleted test must not leave a doc
// claiming coverage that no longer exists.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";

const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8").replace(/\r\n/g, "\n");
const titles = new Set(
  readdirSync(new URL(".", import.meta.url))
    .filter((f) => f.endsWith(".test.js"))
    .flatMap((f) => [...read(`tests/${f}`).matchAll(/\btest\(\s*"((?:[^"\\]|\\.)*)"/g)].map((m) => m[1].replace(/\\"/g, '"'))),
);
const smoke = read("scripts/browser-smoke.mjs");

function citedTests(doc) {
  return doc
    .split("\n")
    .filter((l) => /^\| TEST \|/.test(l))
    .flatMap((l) => [...l.matchAll(/`([^`]+)`/g)].map((m) => m[1]));
}

for (const doc of ["FAILURE_STATES.md"]) {
  test(`${doc}: every cited test title exists`, () => {
    const cited = citedTests(read(doc));
    assert.ok(cited.length > 20, "expected TEST rows");
    const missing = cited.filter((t) => !titles.has(t) && !smoke.includes(t.replace(/\*$/, "")));
    assert.deepEqual(missing, []);
  });
}

test("REQUIREMENTS.md (v2 sections): every quoted test title exists (a trailing … matches by prefix)", () => {
  const doc = read("REQUIREMENTS.md");
  const v2 = doc.slice(doc.indexOf("## v2"));
  const rows = v2.split("\n").filter((l) => l.startsWith("| ") && !l.startsWith("| Status") && !l.startsWith("|---"));
  // Quoted phrases that are UI text, not test titles.
  const prose = new Set(["unproven edge", "Forward paper trading evaluation", "backtest"]);
  const quoted = rows.flatMap((l) => [...l.matchAll(/"([^"|]{6,})"/g)].map((m) => m[1])).filter((q) => !prose.has(q));
  assert.ok(quoted.length > 50, "expected many citations");
  const known = (q) => {
    if (titles.has(q) || smoke.includes(q)) return true;
    if (!q.endsWith("…")) return false;
    const prefix = q.replace(/[:\s]*…$/, "");
    return [...titles].some((t) => t.startsWith(prefix)) || smoke.includes(prefix);
  };
  assert.deepEqual(quoted.filter((q) => !known(q)), []);
});
