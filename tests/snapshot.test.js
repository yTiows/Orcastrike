// Snapshot grouping. Observation rows below are SYNTHETIC test inputs.
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildSnapshotGroup } from "../js/research/snapshot.js";
import { RESEARCH_DEFAULTS } from "../config/settings-schema.js";

const NOW = Date.parse("2026-09-28T12:00:00.000Z");
const at = (secAgo) => new Date(NOW - secAgo * 1000).toISOString();
const VERIFIED = { "csfloat_listings@1": "VERIFIED", "steam_histogram@1": "VERIFIED", "skinport_items@1": "VERIFIED", "skinport_sales_history@1": "VERIFIED" };
const row = (id, source, secAgo, over = {}) => ({
  observation_id: id,
  observed_at: at(secAgo),
  parser_version: { csfloat: "csfloat_listings@1", steam: "steam_histogram@1", skinport: "skinport_items@1" }[source],
  quality_state: "COMPLETE",
  synthetic: 1,
  ...over,
});

const REQ = [
  { role: "entry_quote", source: "steam", kind: "quote", required: true },
  { role: "exit_quote", source: "csfloat", kind: "quote", required: true },
  { role: "exit_reference", source: "csfloat", kind: "reference", required: false },
];

const group = (observations, snapshotCfg = RESEARCH_DEFAULTS.snapshot, parserStatus = VERIFIED) =>
  buildSnapshotGroup({ requirements: REQ, observations, nowMs: NOW, snapshotCfg, parserStatus });

test("fresh, synchronized, verified observations → COMPLETE with recorded contributions", () => {
  const g = group({ entry_quote: row(1, "steam", 10), exit_quote: row(2, "csfloat", 40) });
  assert.equal(g.state, "COMPLETE");
  assert.equal(g.skew_s, 30);
  assert.match(g.sufficiency, /within max age, parsers VERIFIED, cross-source skew 30s ≤ 120s/);
  assert.deepEqual(g.contributing.map((c) => [c.role, c.id, c.effective_age_s]), [["entry_quote", 1, 10], ["exit_quote", 2, 40]]);
  assert.equal(g.synthetic, true);
  assert.ok(g.notes.some((n) => /exit_reference/.test(n)), "missing optional signal is a note, not a state change");
});

test("ACCEPTANCE 2: observations 200s apart across sources → CONFLICTING", () => {
  const g = group({ entry_quote: row(1, "steam", 10), exit_quote: row(2, "csfloat", 210) }, { ...RESEARCH_DEFAULTS.snapshot, max_age_quote_s: 600 });
  assert.equal(g.state, "CONFLICTING");
  assert.match(g.reasons.join(" "), /skew 200s > max 120s/);
});

test("ACCEPTANCE 1 (grouping part): stale CSFloat quote → STALE", () => {
  const g = group({ entry_quote: row(1, "steam", 10), exit_quote: row(2, "csfloat", 181) });
  assert.equal(g.state, "STALE");
  assert.match(g.reasons.join(" "), /exit_quote: effective age 181s > max 180s/);
});

test("unverified parser → INSUFFICIENT (PARSER_UNVERIFIED), even with perfect data", () => {
  const g = group({ entry_quote: row(1, "steam", 10), exit_quote: row(2, "csfloat", 10) }, RESEARCH_DEFAULTS.snapshot, { ...VERIFIED, "csfloat_listings@1": "UNVERIFIED" });
  assert.equal(g.state, "INSUFFICIENT");
  assert.match(g.reasons.join(" "), /PARSER_UNVERIFIED csfloat_listings@1/);
});

test("Skinport's upstream cache is added to effective age", () => {
  const req = [{ role: "exit_quote", source: "skinport", kind: "quote", required: true }];
  const g = buildSnapshotGroup({ requirements: req, observations: { exit_quote: row(1, "skinport", 10) }, nowMs: NOW, snapshotCfg: RESEARCH_DEFAULTS.snapshot, parserStatus: VERIFIED });
  assert.equal(g.contributing[0].effective_age_s, 310);
  assert.equal(g.state, "STALE"); // stale by construction under the default 180s limit (DECISIONS D-40)
});

test("precedence: INVALID > INSUFFICIENT > STALE > CONFLICTING", () => {
  assert.equal(group({ entry_quote: row(1, "steam", 10, { quality_state: "INVALID" }), exit_quote: row(2, "csfloat", 999) }).state, "INVALID");
  assert.equal(group({ entry_quote: null, exit_quote: row(2, "csfloat", 999) }).state, "INSUFFICIENT");
  assert.equal(group({ entry_quote: row(1, "steam", 500), exit_quote: row(2, "csfloat", 10) }).state, "STALE");
  assert.equal(group({ entry_quote: row(1, "steam", 10, { observed_at: "not-a-date" }), exit_quote: row(2, "csfloat", 10) }).state, "INVALID");
});

test("future timestamps are INVALID, not fresh", () => {
  const g = group({ entry_quote: row(1, "steam", -3600), exit_quote: row(2, "csfloat", 10) });
  assert.equal(g.state, "INVALID");
});
