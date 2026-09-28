// Automatic live verification. The daemon runs scripts/contract_test.mjs itself: at start when
// the newest report is missing or older than a day, again whenever it gets that old, and on
// request from the UI. Fixtures and the report go to <data>/contract/, never to tracked files.
// Parsers become VERIFIED only from what that run actually observed (D-38); nothing is assumed.
// Disabled with a SYNTHETIC upstream (tests must not touch the network) and with
// ORCASTRIKE_AUTO_VERIFY=0.

import { spawn } from "node:child_process";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { localReportDir } from "./verification.js";

export const VERIFY_MAX_AGE_MS = 24 * 3600 * 1000;
const OUTCOME = { 0: "ALL_PASS", 1: "FORMAT_CHANGED", 2: "SOME_UNREACHABLE" };

export class Verifier {
  constructor({ root, dataDir, env, log = () => {}, onDone = () => {}, script = join(root, "scripts", "contract_test.mjs"), timeoutMs = 180000 }) {
    Object.assign(this, { root, dataDir, env, log, onDone, script, timeoutMs });
    this.state = { running: false, trigger: null, started_at: null, finished_at: null, exit_code: null, outcome: null };
    this.current = null;
  }

  disabledReason() {
    if (this.env.ORCASTRIKE_SYNTHETIC === "1") return "disabled with a SYNTHETIC upstream (test data)";
    if (this.env.ORCASTRIKE_AUTO_VERIFY === "0") return "disabled by ORCASTRIKE_AUTO_VERIFY=0";
    return null;
  }

  due(lastRunAt, nowMs = Date.now()) {
    return !lastRunAt || Number.isNaN(Date.parse(lastRunAt)) || nowMs - Date.parse(lastRunAt) > VERIFY_MAX_AGE_MS;
  }

  // Resolves with the final state; a second call while running returns the same run.
  run(trigger) {
    if (this.disabledReason()) return Promise.resolve({ ...this.state, skipped: this.disabledReason() });
    if (this.current) return this.current;
    const out = localReportDir(this.dataDir);
    mkdirSync(out, { recursive: true });
    this.state = { running: true, trigger, started_at: new Date().toISOString(), finished_at: null, exit_code: null, outcome: null };
    this.log("info", `verifying live data sources (${trigger})`);
    this.current = new Promise((resolve) => {
      const child = spawn(process.execPath, [this.script], {
        cwd: this.root,
        env: { ...this.env, ORCASTRIKE_CONTRACT_OUT: out },
        stdio: ["ignore", "ignore", "ignore"],
      });
      const timer = setTimeout(() => child.kill(), this.timeoutMs);
      const finish = (code) => {
        clearTimeout(timer);
        this.state = { ...this.state, running: false, finished_at: new Date().toISOString(), exit_code: code, outcome: OUTCOME[code] ?? "ERROR" };
        this.current = null;
        this.log(code === 0 ? "info" : "warn", `live verification finished: ${this.state.outcome}`);
        try {
          this.onDone(this.state);
        } catch (err) {
          this.log("error", `reloading verification failed: ${err?.message ?? err}`);
        }
        resolve(this.state);
      };
      child.on("error", () => finish(null));
      child.on("exit", (code) => finish(code));
    });
    return this.current;
  }
}
