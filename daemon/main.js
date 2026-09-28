#!/usr/bin/env node
// Orcastrike daemon: primary data plane. Samples upstream sources within rate limits, stores
// append-only observations in SQLite, and serves the UI + JSON contract on 127.0.0.1.
//
//   node daemon/main.js                       # http://127.0.0.1:8790
//   ORCASTRIKE_PORT=8791 ORCASTRIKE_DATA_DIR=/path node daemon/main.js
//   CSFLOAT_API_KEY=... node daemon/main.js   # optional; secrets only via environment
//
// Nothing here buys, sells or lists anything.

import { chmodSync, mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { RESEARCH_DEFAULTS, SCHEMA, validateResearchSettings } from "../config/settings-schema.js";
import { coreRoutes } from "./api.js";
import { researchRoutes } from "./api-research.js";
import { evidenceRoutes, syncRealTrades } from "./api-evidence.js";
import { closePaperTrades, openPaperTrades, shouldPaperTrade } from "./paper.js";
import { controlRoutes } from "./api-control.js";
import { runAutopilot } from "./autopilot.js";
import { Engine } from "./engine.js";
import { getSettings, integrityCheck, migrate, openDb, parserStatuses, purgeRawPayloads, recordQualityEvent } from "./db.js";
import { UpstreamClient } from "./http-client.js";
import { makeLogger } from "./redact.js";
import { Scheduler } from "./scheduler.js";
import { createDaemonServer } from "./server.js";
import { loadVerification, syncParserVersions } from "./verification.js";

const ROOT = resolve(join(dirname(fileURLToPath(import.meta.url)), ".."));
export const DAEMON_VERSION = "orcastrike-daemon@1";

// Only schema-classified user settings are validated as settings; other rows in the settings
// table are daemon state (watchlist, ledger sync snapshot, kill switch) and never "settings".
export function userSettingOverrides(stored) {
  const keys = new Set(SCHEMA.filter((e) => e.class === "user_setting").map((e) => e.key));
  return Object.fromEntries(Object.entries(stored).filter(([k]) => keys.has(k)));
}

export function effectiveConfig(db) {
  const stored = userSettingOverrides(getSettings(db));
  const v = validateResearchSettings(stored);
  return v.ok ? { cfg: v.effective, errors: [], warnings: v.warnings } : { cfg: RESEARCH_DEFAULTS, errors: [`stored settings rejected, defaults in force: ${v.errors.join("; ")}`], warnings: [] };
}

export async function startDaemon({ env = process.env, port = Number(env.ORCASTRIKE_PORT) || 8790, dataDir = env.ORCASTRIKE_DATA_DIR || join(ROOT, ".orcastrike-data"), extraRoutes = [], startScheduler = true, log = makeLogger(process.stderr, env) } = {}) {
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  try {
    chmodSync(dataDir, 0o700);
  } catch {
    /* best effort on filesystems without POSIX modes */
  }
  const dbPath = join(dataDir, "orcastrike.sqlite");
  const db = openDb(dbPath);
  const integrity = integrityCheck(db);
  const startedAt = new Date().toISOString();
  let verification = loadVerification(env.ORCASTRIKE_CONTRACT_REPORT || undefined);
  let settingsState = effectiveConfig(db);

  const ctx = {
    db,
    env,
    root: ROOT,
    startedAt,
    getCfg: () => settingsState.cfg,
    settingsErrors: () => settingsState.errors,
    reloadSettings: () => (settingsState = effectiveConfig(db)),
    verification: () => verification,
    parserStatus: () => parserStatuses(db),
    dbHealth: () => ({ path_in_data_dir: "orcastrike.sqlite", schema_version: migrate(db), integrity: integrity.ok ? "ok" : "CORRUPT", degraded: !integrity.ok }),
    log,
  };

  if (!integrity.ok) {
    // Corrupt database: serve health + UI read-only, never sample or compute. Recovery is a
    // restore from backup (docs: FAILURE_STATES.md).
    log("error", `database integrity check failed: ${integrity.detail}; running DEGRADED (no sampling)`);
  } else {
    syncParserVersions(db, verification, startedAt);
  }

  const client = new UpstreamClient({ rateLimits: settingsState.cfg.ratelimit, env });
  const scheduler = new Scheduler({ db, client, getCfg: ctx.getCfg, getSettings: () => getSettings(db), env, log, onAfterJob: (job, r) => ctx.onAfterJob?.(job, r) });
  ctx.scheduler = scheduler;
  ctx.client = client;

  const engine = new Engine({ db, getCfg: ctx.getCfg, env, log });
  ctx.engine = engine;
  ctx.syncRealTrades = (trades) => syncRealTrades(db, trades);
  engine.onCycle((cycle) => {
    const cfg = ctx.getCfg();
    const rail = getSettings(db)["ui.csfloat_payout_rail"] ?? "bank";
    if (shouldPaperTrade(cfg)) openPaperTrades(db, cycle, (o, itemId) => engine.persistForce(o, itemId), Date.now());
    closePaperTrades(db, cfg, Date.now(), { rail });
    runAutopilot(db, cycle, cfg, Date.now(), (o, itemId) => engine.persistForce(o, itemId));
  });
  const routes = [...extraRoutes.flatMap((f) => f(ctx)), ...controlRoutes(ctx), ...evidenceRoutes(ctx), ...researchRoutes(ctx), ...coreRoutes(ctx)];
  const server = createDaemonServer({ root: ROOT, port, routes, log });
  await new Promise((r) => server.listen(port, "127.0.0.1", r));

  const timers = [];
  if (integrity.ok && startScheduler) {
    scheduler.start(1000);
    const purge = () => {
      try {
        purgeRawPayloads(db, ctx.getCfg().storage.raw_payload_retention_days, Date.now());
      } catch (err) {
        log("error", `raw payload purge failed: ${err.message}`);
      }
    };
    purge();
    timers.push(setInterval(purge, 6 * 3600 * 1000));
    const runEngine = () => {
      try {
        engine.cycle();
      } catch (err) {
        log("error", `engine cycle failed: ${err?.message ?? err}`);
      }
    };
    runEngine();
    timers.push(setInterval(runEngine, Number(env.ORCASTRIKE_ENGINE_INTERVAL_MS) || 30000));
    timers.push(
      setInterval(() => {
        verification = loadVerification(env.ORCASTRIKE_CONTRACT_REPORT || undefined);
        syncParserVersions(db, verification, new Date().toISOString());
      }, 10 * 60 * 1000),
    );
  } else if (!integrity.ok) {
    try {
      recordQualityEvent(db, { occurred_at: startedAt, severity: "HIGH", code: "DB_INTEGRITY", detail: integrity.detail });
    } catch {
      /* database may not accept writes */
    }
  }

  log("info", `${DAEMON_VERSION} listening on http://127.0.0.1:${port} (data: ${dataDir}); CSFloat ${(env.CSFLOAT_API_KEY ?? "").trim() ? "configured" : "NOT_CONFIGURED"}`);
  const stop = async () => {
    scheduler.stop();
    for (const t of timers) clearInterval(t);
    await new Promise((r) => server.close(r));
    db.close();
  };
  return { ctx, server, stop, port };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const d = await startDaemon();
  const shutdown = async () => {
    await d.stop();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}
