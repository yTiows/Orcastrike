// Parser verification status comes only from the latest live contract report: a parser is
// VERIFIED when that report shows PASS for its endpoint with the same parser version and the
// referenced LIVE fixture exists. Everything else is UNVERIFIED (or BLOCKED if unreachable).
//
// Two reports can exist: the repository's (tests/fixtures/live/, committed after a manual run)
// and the local one the daemon writes when it verifies by itself (<data>/contract/). The newer
// run wins; nothing from an older run is merged in.

import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { registerParser } from "./db.js";
import { ENDPOINTS } from "./sources.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
export const DEFAULT_REPORT = join(ROOT, "tests", "fixtures", "live", "CONTRACT_REPORT.json");
export const localReportDir = (dataDir) => join(dataDir, "contract");
export const localReportPath = (dataDir) => join(localReportDir(dataDir), "CONTRACT_REPORT.json");

function readReport(path) {
  if (!path || !existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}

export function loadVerification(reportPath = DEFAULT_REPORT) {
  const status = {};
  const report = readReport(reportPath);
  const base = report?.fixture_root === "report_dir" ? dirname(reportPath) : ROOT;
  for (const [endpoint, d] of Object.entries(ENDPOINTS)) {
    const r = report?.results?.find((x) => x.endpoint === endpoint);
    const fixture = r?.fixture ? join(base, r.fixture) : null;
    if (r?.status === "PASS" && r.parse?.parser_version === d.parser_version && fixture && existsSync(fixture)) {
      status[d.parser_version] = { endpoint, verification_status: "VERIFIED", verified_fixture: r.fixture, verified_at: report.run_at };
    } else {
      status[d.parser_version] = { endpoint, verification_status: r?.status === "BLOCKED" ? "BLOCKED" : "UNVERIFIED", verified_fixture: null, verified_at: null };
    }
  }
  const results = Object.fromEntries((report?.results ?? []).map((r) => [r.endpoint, r.status]));
  return { report_run_at: report?.run_at ?? null, report_path: report ? reportPath : null, results, status };
}

// The newest of the repository report (or an explicit override) and the local report.
export function loadLatestVerification({ dataDir, override } = {}) {
  const candidates = [override || DEFAULT_REPORT, dataDir ? localReportPath(dataDir) : null].filter(Boolean);
  let best = loadVerification(candidates[0]);
  for (const p of candidates.slice(1)) {
    const v = loadVerification(p);
    if (v.report_run_at && (!best.report_run_at || Date.parse(v.report_run_at) > Date.parse(best.report_run_at))) best = v;
  }
  return best;
}

// Per-source summary for the browser's Level 1 scanner, same rule as the contract test's
// static/parser-verification.json: a source counts only when all of its parsers passed.
// FORMAT_CHANGED (a live response no longer matches the parser) is shown, never used.
export function sourceStatus(verification) {
  const st = (ep) => {
    const r = verification.results?.[ep];
    const pv = ENDPOINTS[ep]?.parser_version;
    if (pv && verification.status[pv]?.verification_status === "VERIFIED") return "VERIFIED";
    return r === "BLOCKED" ? "BLOCKED" : r === "FAIL" ? "FORMAT_CHANGED" : "UNVERIFIED";
  };
  const both = (a, b) => (st(a) === "VERIFIED" && st(b) === "VERIFIED" ? "VERIFIED" : st(a) === "VERIFIED" ? st(b) : st(a));
  return { steam: both("steam_listing_page", "steam_histogram"), csfloat: st("csfloat_listings"), skinport: both("skinport_items", "frankfurter_latest") };
}

export function syncParserVersions(db, verification, nowIso) {
  for (const [parser_version, v] of Object.entries(verification.status)) registerParser(db, { parser_version, ...v }, nowIso);
}
