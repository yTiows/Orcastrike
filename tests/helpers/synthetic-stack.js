// A real daemon process fed by a loopback upstream that serves SYNTHETIC responses
// (documented shapes, invented values). The daemon flags every row synthetic and parsers stay
// UNVERIFIED, so nothing produced here can become evidence or an ELIGIBLE opportunity.
// Shared by tests/integration.test.js and scripts/browser-smoke.mjs.
import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const ITEM = "AK-47 | Redline (Field-Tested)";
export const FAKE_KEY = "TEST_ONLY_integration_key_000";
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

export function freePort() {
  return new Promise((resolve) => {
    const s = createServer();
    s.listen(0, "127.0.0.1", () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });
}

const SYNTHETIC = {
  "/api.frankfurter.dev/v1/latest": () => ({ amount: 1, base: "EUR", date: new Date().toISOString().slice(0, 10), rates: { USD: 1.1 } }),
  "/api.skinport.com/v1/items": () => [{ market_hash_name: ITEM, currency: "EUR", min_price: 20.0, quantity: 9 }],
  "/api.skinport.com/v1/sales/history": () => [
    { market_hash_name: ITEM, currency: "EUR", last_24_hours: { volume: 4, median: 20 }, last_7_days: { volume: 30, median: 20 }, last_30_days: { volume: 100, median: 20 }, last_90_days: { volume: 300, median: 20 } },
  ],
  "/csfloat.com/api/v1/listings": (req) => {
    if (req.headers.authorization !== FAKE_KEY) return { __status: 401 };
    return [1, 2, 3, 4, 5, 6].map((i) => ({ id: String(i), type: "buy_now", state: "listed", price: 2400 + i * 10, item: { market_hash_name: ITEM, float_value: 0.2, paint_seed: i, paint_index: 282 } }));
  },
  "/steamcommunity.com/market/priceoverview/": () => ({ success: true, lowest_price: "$21.00", volume: "150", median_price: "$20.50" }),
  "/steamcommunity.com/market/itemordershistogram": () => ({ success: 1, lowest_sell_order: "2100", price_prefix: "$", price_suffix: "", sell_order_graph: [[21.0, 3, ""], [22.0, 8, ""], [30.0, 20, ""]] }),
};

// Returns { base, log(), stop() }. `engineIntervalMs` speeds the engine up for tests.
export async function startSyntheticStack({ engineIntervalMs = 500 } = {}) {
  const upstream = createServer((req, res) => {
    const u = new URL(req.url, "http://x");
    if (u.pathname.startsWith("/steamcommunity.com/market/listings/730/")) {
      res.writeHead(200, { "content-type": "text/html" });
      res.end('<script>var line1=[["Sep 01 2026 01: +0",20.5,"12"]];var strFormatPrefix = "$";var strFormatSuffix = "";Market_LoadOrderSpread( 555 );</script>');
      return;
    }
    const h = SYNTHETIC[u.pathname];
    const body = h ? h(req) : { __status: 404 };
    res.writeHead(body.__status ?? 200, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
  });
  await new Promise((r) => upstream.listen(0, "127.0.0.1", r));
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  let log = "";
  const daemon = spawn(process.execPath, ["--disable-warning=ExperimentalWarning", join(ROOT, "daemon/main.js")], {
    cwd: ROOT,
    env: {
      PATH: process.env.PATH,
      ORCASTRIKE_PORT: String(port),
      ORCASTRIKE_DATA_DIR: mkdtempSync(join(tmpdir(), "orca-int-")),
      ORCASTRIKE_UPSTREAM_OVERRIDE: `http://127.0.0.1:${upstream.address().port}`,
      ORCASTRIKE_SYNTHETIC: "1",
      ORCASTRIKE_CONTRACT_REPORT: join(tmpdir(), "no-such-report.json"),
      CSFLOAT_API_KEY: FAKE_KEY,
      ORCASTRIKE_ENGINE_INTERVAL_MS: String(engineIntervalMs),
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  daemon.stdout.on("data", (d) => (log += d));
  daemon.stderr.on("data", (d) => (log += d));
  const stop = () => {
    daemon.kill("SIGTERM");
    upstream.close();
  };
  for (let i = 0; i < 100; i += 1) {
    try {
      if ((await fetch(`${base}/api/v2/health`)).ok) return { base, log: () => log, stop };
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  stop();
  throw new Error(`daemon did not start: ${log}`);
}
