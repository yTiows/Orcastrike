// Backups: canonical JSON, SHA-256 checksum, verified import. File System Access is Chromium-only
// (browser layer); in Node it reports UNSUPPORTED, which is the manual-export fallback path.
import { test } from "node:test";
import assert from "node:assert/strict";
import { BACKUP_FORMAT, canonicalJson, dailyBackup, fsaSupported, makeBackup, sha256Hex, verifyBackup } from "../js/backup.js";
import { emptyLedger, exportLedger, importLedger } from "../js/ledger.js";

test("canonical JSON is key-order independent", () => {
  assert.equal(canonicalJson({ b: 1, a: [2, { d: 3, c: 4 }] }), canonicalJson({ a: [2, { c: 4, d: 3 }], b: 1 }));
});

test("backup round trip verifies the checksum; any modification is rejected", async () => {
  const payload = JSON.parse(exportLedger(emptyLedger(), { nowIso: "2026-09-28T00:00:00.000Z" }));
  const b = await makeBackup(payload, "2026-09-28T00:00:00.000Z");
  assert.equal(b.format, BACKUP_FORMAT);
  assert.equal(b.checksum_sha256, await sha256Hex(canonicalJson(payload)));
  const ok = await verifyBackup(JSON.stringify(b));
  assert.equal(ok.checksum, "VERIFIED");
  assert.equal(importLedger(JSON.stringify(ok.payload)).ok, true);
  const tampered = structuredClone(b);
  tampered.payload.ledger.next_seq = 99;
  const bad = await verifyBackup(JSON.stringify(tampered));
  assert.equal(bad.ok, false);
  assert.match(bad.errors[0], /checksum mismatch/);
  const legacy = await verifyBackup(JSON.stringify(payload));
  assert.equal(legacy.checksum, "ABSENT");
  assert.equal((await verifyBackup("{nope")).ok, false);
});

test("without the File System Access API, daily backup reports UNSUPPORTED (manual export fallback)", async () => {
  assert.equal(fsaSupported({}), false);
  const r = await dailyBackup({ get: async () => undefined, set: async () => {} }, () => ({}), "2026-09-28T00:00:00.000Z", { win: {} });
  assert.equal(r.state, "UNSUPPORTED");
});
