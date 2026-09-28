#!/usr/bin/env node
// Browser smoke test: real Chromium against a real daemon fed by a SYNTHETIC loopback upstream
// (tests/helpers/synthetic-stack.js). Nothing here touches a marketplace. Checks:
//   - localStorage v1 ledger → IndexedDB migration (non-destructive, source kept)
//   - FIFO partial-lot sell through the ledger forms
//   - Research tab: SYNTHETIC/UNVERIFIED rows never ELIGIBLE, blocked reason on every row
//   - UMBRA via the typed override: theme applied, UNPROVEN banner, reduced motion respected
//   - kill switch engage/release
//   - Chart.js CDN blocked → table fallback, rest of the app unaffected
//   - backup label: UNVERIFIED when the File System Access API is absent
//   - no console errors, no page errors, no CSP violations, no horizontal overflow (1280 / 390 px)
// Screenshots and a JSON summary go to reports/browser-smoke/. Exit 0 = all checks passed.
//
// Usage: node scripts/browser-smoke.mjs   (needs `playwright` locally or globally, and Chromium)
import { execSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ITEM, startSyntheticStack } from "../tests/helpers/synthetic-stack.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const OUT = join(ROOT, "reports", "browser-smoke");
mkdirSync(OUT, { recursive: true });

async function loadPlaywright() {
  try {
    return await import("playwright");
  } catch {
    const globalRoot = execSync("npm root -g", { encoding: "utf8" }).trim();
    return createRequire(join(globalRoot, "noop.js"))("playwright");
  }
}

const results = [];
function check(name, ok, detail = "") {
  results.push({ name, ok: Boolean(ok), detail: String(detail).slice(0, 500) });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail && !ok ? ` — ${detail}` : ""}`);
}

const V1_LEDGER = {
  schema_version: 1,
  next_seq: 3,
  lots: [
    {
      lot_id: "seed-lot-1",
      seq: 2,
      canonical_item_id: "M4A1-S | Hyper Beast (Field-Tested)",
      quantity: 2,
      buy_market: "csfloat",
      buy_price_cents: 1000,
      buy_timestamp: "2026-08-01T10:00:00.000Z",
      minimum_hold_until: "2026-08-08T10:00:00.000Z",
      status: "open",
      funding_source: "usd_cash",
      recorded_at: "2026-08-01T10:00:00.000Z",
    },
  ],
  trades: [],
  adjustments: [{ adjustment_id: "seed-adj-1", seq: 1, kind: "cash", amount_cents: 10000, from_banked: false, timestamp: "2026-08-01T09:00:00.000Z", note: "SYNTHETIC seed", recorded_at: "2026-08-01T09:00:00.000Z" }],
};

const stack = await startSyntheticStack({ engineIntervalMs: 1000 });
const { chromium } = await loadPlaywright();
const browser = await chromium.launch(process.env.PW_CHROMIUM ? { executablePath: process.env.PW_CHROMIUM } : {});
const TABS = ["dashboard", "research", "scanner", "ledger", "events", "settings"];

async function newPage({ width = 1280, height = 900, reducedMotion = "no-preference", noFsa = false } = {}) {
  const context = await browser.newContext({ viewport: { width, height }, reducedMotion });
  // CDN deliberately unreachable: the chart must degrade to a table and nothing else may break.
  await context.route("https://cdnjs.cloudflare.com/**", (r) => r.abort());
  if (noFsa) await context.addInitScript(() => Object.defineProperty(window, "showDirectoryPicker", { value: undefined, configurable: true }));
  const page = await context.newPage();
  const errors = [];
  const expected = new Set(); // "METHOD path status" the test provokes on purpose
  page.on("response", (r) => {
    if (r.status() < 400) return;
    const u = new URL(r.url());
    const key = `${r.request().method()} ${u.pathname} ${r.status()}`;
    if (expected.has(key)) return;
    errors.push(`HTTP ${key}${u.search}`);
  });
  page.on("console", (m) => {
    if (m.type() !== "error") return;
    if ((m.location()?.url ?? "").startsWith("https://cdnjs.cloudflare.com/")) return; // the blocked CDN itself
    if (/^Failed to load resource: the server responded with a status of/.test(m.text())) return; // reported above with its URL
    errors.push(m.text());
  });
  page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
  page.on("dialog", (d) => d.accept());
  return { context, page, errors, expected };
}

async function overflow(page) {
  return page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
}

async function gotoTab(page, tab) {
  await page.click(`nav.tabs a[data-tab="${tab}"]`);
  await page.waitForSelector(`[data-view="${tab}"]:not([hidden])`);
}

try {
  // Let the scheduler + engine produce rows before the UI looks.
  await fetch(`${stack.base}/api/v2/watchlist`, { method: "POST", headers: { "content-type": "application/json", origin: stack.base }, body: JSON.stringify({ items: [ITEM] }) });
  for (let i = 0; i < 100; i += 1) {
    const o = await (await fetch(`${stack.base}/api/v2/opportunities?all=1`)).json();
    if ((o.opportunities ?? []).length) break;
    await new Promise((r) => setTimeout(r, 200));
  }

  // ---- desktop session ------------------------------------------------------------------
  const { context, page, errors, expected } = await newPage();
  await page.goto(`${stack.base}/`);
  await page.evaluate((v1) => localStorage.setItem("sat.ledger.v1", JSON.stringify(v1)), V1_LEDGER);
  await page.reload();
  await page.waitForSelector("#ledger-storage", { state: "attached" });
  await gotoTab(page, "ledger");
  await page.waitForFunction(() => /indexeddb/.test(document.querySelector("#ledger-storage")?.textContent ?? ""));
  const storageText = await page.textContent("#ledger-storage");
  check("storage: IndexedDB is primary", /Storage: indexeddb/.test(storageText), storageText);
  check("storage: v1 localStorage ledger migrated, original kept", /migrated from localStorage \(v1\).*original was kept/.test(storageText), storageText);
  check("storage: localStorage source untouched", (await page.evaluate(() => localStorage.getItem("sat.ledger.v1"))) === JSON.stringify(V1_LEDGER));
  check("storage: migrated lot visible", (await page.textContent("#t-lots")).includes("Hyper Beast"));
  check("backup: Chromium exposes File System Access → configurable", /Daily backup: (not configured|NO_DIRECTORY|CHOSEN|SKIPPED_TODAY|WRITTEN|PERMISSION_NEEDED)/.test(await page.textContent("#backup-state")), await page.textContent("#backup-state"));

  // Record cash, a 3-unit buy, then sell 2: FIFO must split the lot and leave 1 open.
  await page.fill("#f-cash [name=amount]", "500.00");
  await page.fill("#f-cash [name=ts]", "2026-08-30T10:00");
  await page.click("#f-cash button[type=submit]");
  await page.fill("#f-buy [name=item]", ITEM);
  await page.fill("#f-buy [name=qty]", "3");
  await page.selectOption("#f-buy [name=market]", "csfloat");
  await page.fill("#f-buy [name=price]", "20.00");
  await page.fill("#f-buy [name=ts]", "2026-09-01T10:00");
  await page.click("#f-buy button[type=submit]");
  await page.waitForFunction(() => (document.querySelector("#f-buy .result")?.textContent ?? "") !== "");
  const buyResult = await page.textContent("#f-buy .result");
  await page.waitForFunction(() => (document.querySelector("#t-lots")?.textContent ?? "").includes("Redline"), null, { timeout: 5000 }).catch(() => {});
  check("ledger: buy recorded", /^Recorded/.test(buyResult) && (await page.textContent("#t-lots")).includes("Redline"), buyResult);
  await page.fill("#f-sell [name=item]", ITEM);
  await page.fill("#f-sell [name=qty]", "2");
  await page.selectOption("#f-sell [name=market]", "skinport");
  await page.fill("#f-sell [name=price]", "25.00");
  await page.fill("#f-sell [name=ts]", "2026-09-20T10:00");
  await page.click("#f-sell button[type=submit]");
  await page.waitForFunction(() => (document.querySelector("#t-trades")?.textContent ?? "").includes("Redline"), null, { timeout: 5000 }).catch(() => {});
  const sellResult = await page.textContent("#f-sell .result");
  const lotRow = await page.locator("#t-lots tr", { hasText: "Redline" }).first().textContent();
  check("ledger: partial sell recorded (FIFO split)", /\b1\b/.test(lotRow) && (await page.textContent("#t-trades")).includes("Redline"), `${sellResult} | ${lotRow}`);
  await page.screenshot({ path: join(OUT, "ledger-desktop.png"), fullPage: true });

  // Persistence: a reload reads the ledger back from IndexedDB, not from the v1 copy.
  await page.reload();
  await gotoTab(page, "ledger");
  await page.waitForFunction(() => (document.querySelector("#t-trades")?.textContent ?? "").includes("Redline"));
  check("storage: ledger survives reload from IndexedDB", true);

  // Dashboard: CDN blocked → chart fallback; five profit figures present.
  await gotoTab(page, "dashboard");
  await page.waitForFunction(() => document.querySelectorAll("#dash-figures .card").length >= 5);
  const figs = await page.textContent("#dash-figures");
  check("dashboard: five separate profit figures", ["REALIZED", "PAPER", "HISTORICAL", "MARK_TO_MARKET", "ESTIMATED_EXIT"].every((k) => figs.includes(k)), figs.slice(0, 300));
  const chartText = await page.textContent("#dash-chart");
  check("dashboard: chart area never blank without Chart.js", /Chart unavailable|No history loaded|INSUFFICIENT|UNAVAILABLE|UNVERIFIED|Loading/.test(chartText), chartText.slice(0, 200));
  check("dashboard: Chart.js absent (CDN blocked)", await page.evaluate(() => typeof window.Chart === "undefined"));
  await page.screenshot({ path: join(OUT, "dashboard-desktop.png"), fullPage: true });

  // Research: rows exist, none ELIGIBLE, every non-eligible row carries a blocked reason.
  await gotoTab(page, "research");
  await page.check("#rs-showall");
  await page.waitForSelector("#rs-opps tr[data-key]", { timeout: 20000 });
  const rows = await page.$$eval("#rs-opps tr[data-key]", (trs) => trs.map((tr) => ({ status: tr.children[3]?.textContent.trim(), reason: tr.lastElementChild?.textContent.trim(), text: tr.textContent })));
  check("research: evaluated pairs rendered", rows.length > 0, rows.length);
  check("research: SYNTHETIC/UNVERIFIED data never ELIGIBLE", rows.every((r) => r.status !== "ELIGIBLE"), JSON.stringify(rows.map((r) => r.status)));
  check("research: every blocked row states its reason", rows.every((r) => r.reason.length > 0), JSON.stringify(rows.filter((r) => !r.reason)));
  check("research: SYNTHETIC label on rows", rows.every((r) => r.text.includes("SYNTHETIC")));
  check("research: PARSER_UNVERIFIED surfaced", rows.some((r) => /PARSER_UNVERIFIED|UNVERIFIED/.test(r.reason)), rows[0]?.reason);
  await page.click("#rs-opps tr[data-key]");
  await page.waitForSelector("#rs-opps .trace-row");
  check("research: row expands into a step-by-step trace", (await page.$$("#rs-opps .trace li")).length > 0);
  await page.screenshot({ path: join(OUT, "research-desktop.png"), fullPage: true });

  // Kill switch.
  await page.click("#kill-switch");
  await page.waitForFunction(() => /ENGAGED/.test(document.querySelector("#kill-switch")?.textContent ?? ""));
  check("kill switch: engages from the header", true);
  await page.click("#kill-switch");
  await page.waitForFunction(() => !/ENGAGED/.test(document.querySelector("#kill-switch")?.textContent ?? ""));
  check("kill switch: release needs confirmation and works", true);

  // UMBRA with the typed override (SIGNAL_EVIDENCE has not passed on SYNTHETIC data).
  expected.add("POST /api/v2/umbra 422");
  await page.fill("#rs-umbra-form [name=bankroll]", "500.00");
  await page.click("#rs-umbra-form button[type=submit]");
  await page.waitForFunction(() => (document.querySelector("#rs-umbra-form .result")?.textContent ?? "") !== "");
  expected.delete("POST /api/v2/umbra 422");
  const refused = await page.textContent("#rs-umbra-form .result");
  check("UMBRA: refused without evidence or the typed phrase", /unproven edge|SIGNAL_EVIDENCE/i.test(refused), refused);
  await page.fill("#rs-umbra-form [name=bankroll]", "500.00");
  await page.fill("#rs-umbra-form [name=phrase]", "unproven edge");
  await page.click("#rs-umbra-form button[type=submit]");
  await page.waitForFunction(() => document.documentElement.dataset.mode === "umbra");
  const banner = await page.textContent("#umbra-banner");
  check("UMBRA: theme applied, UNPROVEN banner, no execution", /UNPROVEN/.test(banner) && /no execution/.test(banner), banner);
  check("UMBRA: background drift animates", (await page.evaluate(() => getComputedStyle(document.body, "::before").animationName)) === "umbra-drift");
  const bg = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
  await page.waitForTimeout(700); // 600ms crossfade
  check("UMBRA: palette base #06060A applied", (await page.evaluate(() => getComputedStyle(document.body).backgroundColor)) === "rgb(6, 6, 10)", bg);
  // Let the engine run an UMBRA cycle, then reload so the page fetches it.
  await new Promise((r) => setTimeout(r, 2500));
  await page.reload();
  await gotoTab(page, "research");
  await page.check("#rs-showall");
  await page.waitForSelector("#rs-opps tr[data-key]", { timeout: 20000 });
  await page.waitForTimeout(700); // 600ms crossfade
  const rowsU = await page.$$eval("#rs-opps tr[data-key]", (trs) => trs.map((tr) => tr.children[3]?.textContent.trim()));
  check("UMBRA: rows evaluated, and the mode grants no eligibility", rowsU.length > 0 && rowsU.every((s) => s !== "ELIGIBLE"), JSON.stringify(rowsU));
  await page.screenshot({ path: join(OUT, "research-umbra-desktop.png"), fullPage: true });
  await gotoTab(page, "dashboard");
  await page.screenshot({ path: join(OUT, "dashboard-umbra-desktop.png"), fullPage: true });

  // Overflow on every tab, desktop.
  for (const t of TABS) {
    await gotoTab(page, t);
    const o = await overflow(page);
    check(`layout: no horizontal overflow at 1280px (${t})`, o <= 0, `${o}px`);
  }
  check("console: no errors, page errors or CSP violations (desktop)", errors.length === 0, errors.join(" | "));
  await context.close();

  // ---- reduced motion (UMBRA still active in the daemon) ---------------------------------
  const rm = await newPage({ reducedMotion: "reduce" });
  await rm.page.goto(`${stack.base}/#research`);
  await rm.page.waitForFunction(() => document.documentElement.dataset.mode === "umbra");
  check("reduced motion: drift disabled", (await rm.page.evaluate(() => getComputedStyle(document.body, "::before").animationName)) === "none");
  check("reduced motion: crossfade disabled", (await rm.page.evaluate(() => getComputedStyle(document.body).transitionDuration)) === "0s");
  await rm.context.close();

  // ---- mobile 390px, File System Access absent (Firefox/Safari path) ----------------------
  const m = await newPage({ width: 390, height: 844, noFsa: true });
  await m.page.goto(`${stack.base}/`);
  await m.page.waitForSelector("#ledger-storage", { state: "attached" });
  for (const t of TABS) {
    await gotoTab(m.page, t);
    await m.page.waitForTimeout(700); // let the 600ms theme crossfade finish before measuring/capturing
    const o = await overflow(m.page);
    check(`layout: no horizontal overflow at 390px (${t})`, o <= 0, `${o}px`);
    if (["dashboard", "research", "ledger"].includes(t)) await m.page.screenshot({ path: join(OUT, `${t}-umbra-mobile.png`), fullPage: true });
  }
  await gotoTab(m.page, "ledger");
  const bs = await m.page.textContent("#backup-state");
  check("backup: UNVERIFIED label without File System Access", /UNVERIFIED/.test(bs), bs);
  // Leave the daemon as found: UMBRA off.
  await gotoTab(m.page, "research");
  await m.page.click("#rs-umbra-off");
  await m.page.waitForFunction(() => document.documentElement.dataset.mode === "standard");
  check("UMBRA: deactivation restores the standard theme", true);
  await m.page.screenshot({ path: join(OUT, "research-mobile.png"), fullPage: true });
  check("console: no errors, page errors or CSP violations (mobile)", m.errors.length === 0, m.errors.join(" | "));
  await m.context.close();
} catch (err) {
  check("smoke run completed", false, `${err.message}\n${stack.log().slice(-2000)}`);
} finally {
  await browser.close();
  stack.stop();
}

const failed = results.filter((r) => !r.ok);
writeFileSync(
  join(OUT, "report.json"),
  `${JSON.stringify({ run_at: new Date().toISOString(), upstream: "SYNTHETIC (loopback)", browser: "chromium (headless)", passed: results.length - failed.length, failed: failed.length, results }, null, 2)}\n`,
);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length ? 1 : 0);
