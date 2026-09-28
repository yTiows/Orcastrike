// Automatic live verification: report selection, the daemon-side runner, and the disabled paths.
// The "contract script" here is a SYNTHETIC test double that writes a report into the output
// directory it is given; nothing in this file touches the network.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Verifier, VERIFY_MAX_AGE_MS } from "../daemon/auto-verify.js";
import { loadLatestVerification, localReportPath, sourceStatus } from "../daemon/verification.js";

function writeReport(path, runAt, results, fixtureRoot = "report_dir") {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, JSON.stringify({ run_at: runAt, fixture_root: fixtureRoot, results }));
}

test("the newest report wins; local fixtures resolve next to their report", () => {
  const data = mkdtempSync(join(tmpdir(), "orca-vr-"));
  const repo = join(data, "repo-report.json");
  writeReport(repo, "2026-09-01T00:00:00.000Z", [{ endpoint: "frankfurter_latest", status: "BLOCKED" }], "repo");
  const local = localReportPath(data);
  mkdirSync(join(data, "contract", "frankfurter_latest"), { recursive: true });
  writeFileSync(join(data, "contract", "frankfurter_latest", "f.json"), "{}");
  writeReport(local, "2026-09-28T00:00:00.000Z", [{ endpoint: "frankfurter_latest", status: "PASS", fixture: "frankfurter_latest/f.json", parse: { parser_version: "frankfurter_latest@1" } }]);
  const v = loadLatestVerification({ dataDir: data, override: repo });
  assert.equal(v.report_run_at, "2026-09-28T00:00:00.000Z");
  assert.equal(v.status["frankfurter_latest@1"].verification_status, "VERIFIED");
  assert.equal(sourceStatus(v).skinport, "UNVERIFIED", "Skinport also needs skinport_items");
  writeReport(repo, "2026-09-29T00:00:00.000Z", [{ endpoint: "frankfurter_latest", status: "BLOCKED" }], "repo");
  const newer = loadLatestVerification({ dataDir: data, override: repo });
  assert.equal(newer.status["frankfurter_latest@1"].verification_status, "BLOCKED", "an older PASS is never merged into a newer run");
});

test("a PASS whose fixture file is missing does not verify", () => {
  const data = mkdtempSync(join(tmpdir(), "orca-vr-"));
  writeReport(localReportPath(data), "2026-09-28T00:00:00.000Z", [{ endpoint: "frankfurter_latest", status: "PASS", fixture: "frankfurter_latest/missing.json", parse: { parser_version: "frankfurter_latest@1" } }]);
  const v = loadLatestVerification({ dataDir: data, override: join(data, "none.json") });
  assert.equal(v.status["frankfurter_latest@1"].verification_status, "UNVERIFIED");
});

test("a live format change is reported per source as FORMAT_CHANGED and never verifies", () => {
  const data = mkdtempSync(join(tmpdir(), "orca-vr-"));
  writeReport(localReportPath(data), "2026-09-28T00:00:00.000Z", [{ endpoint: "csfloat_listings", status: "FAIL", parse: { parser_version: "csfloat_listings@1" } }]);
  const v = loadLatestVerification({ dataDir: data, override: join(data, "none.json") });
  assert.equal(v.status["csfloat_listings@1"].verification_status, "UNVERIFIED");
  assert.equal(sourceStatus(v).csfloat, "FORMAT_CHANGED");
});

test("verifier runs the contract script into the data directory, reports the outcome, then reloads", async () => {
  const data = mkdtempSync(join(tmpdir(), "orca-vr-"));
  const script = join(data, "fake-contract.mjs");
  writeFileSync(
    script,
    `import { mkdirSync, writeFileSync } from "node:fs";
     import { join } from "node:path";
     const out = process.env.ORCASTRIKE_CONTRACT_OUT;
     mkdirSync(join(out, "frankfurter_latest"), { recursive: true });
     writeFileSync(join(out, "frankfurter_latest", "t.json"), JSON.stringify({ fixture_kind: "SYNTHETIC-TEST-DOUBLE" }));
     writeFileSync(join(out, "CONTRACT_REPORT.json"), JSON.stringify({ run_at: new Date().toISOString(), fixture_root: "report_dir",
       results: [{ endpoint: "frankfurter_latest", status: "PASS", fixture: "frankfurter_latest/t.json", parse: { parser_version: "frankfurter_latest@1" } }] }));
     process.exit(2);`,
  );
  let reloaded = 0;
  const v = new Verifier({ root: data, dataDir: data, env: { PATH: process.env.PATH }, script, onDone: () => (reloaded += 1) });
  assert.equal(v.due(null), true);
  assert.equal(v.due(new Date().toISOString()), false);
  assert.equal(v.due(new Date(Date.now() - VERIFY_MAX_AGE_MS - 1000).toISOString()), true);
  const [a, b] = [v.run("manual"), v.run("manual")];
  assert.equal(a, b, "one run at a time");
  const st = await a;
  assert.deepEqual([st.running, st.exit_code, st.outcome, st.trigger], [false, 2, "SOME_UNREACHABLE", "manual"]);
  assert.equal(reloaded, 1);
  const verif = loadLatestVerification({ dataDir: data, override: join(data, "none.json") });
  assert.equal(verif.status["frankfurter_latest@1"].verification_status, "VERIFIED");
});

test("verifier is disabled with a SYNTHETIC upstream or ORCASTRIKE_AUTO_VERIFY=0, and then runs nothing", async () => {
  const data = mkdtempSync(join(tmpdir(), "orca-vr-"));
  for (const env of [{ ORCASTRIKE_SYNTHETIC: "1" }, { ORCASTRIKE_AUTO_VERIFY: "0" }]) {
    const v = new Verifier({ root: data, dataDir: data, env, script: join(data, "does-not-exist.mjs") });
    assert.ok(v.disabledReason());
    const st = await v.run("startup");
    assert.ok(st.skipped);
    assert.equal(st.started_at, null);
  }
});
