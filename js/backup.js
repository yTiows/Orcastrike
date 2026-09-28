// Ledger backups with SHA-256 checksums. Daily automatic backup uses the File System Access API
// (Chromium). Other browsers: UNVERIFIED, so use the manual export (same checksummed file via
// download). Import verifies the checksum before anything is replayed.

export const BACKUP_FORMAT = "orcastrike-ledger-backup";
export const BACKUP_VERSION = 1;

export function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonicalJson(value[k])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

export async function sha256Hex(text) {
  const bytes = new TextEncoder().encode(text);
  const digest = await globalThis.crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

// payload: the ledger export document (format skin-arb-terminal-ledger).
export async function makeBackup(payload, nowIso) {
  return { format: BACKUP_FORMAT, backup_version: BACKUP_VERSION, created_at: nowIso, checksum_sha256: await sha256Hex(canonicalJson(payload)), payload };
}

// Returns { ok, payload, checksum: "VERIFIED" | "ABSENT" } or { ok: false, errors }.
export async function verifyBackup(text) {
  let doc;
  try {
    doc = JSON.parse(text);
  } catch {
    return { ok: false, errors: ["file is not valid JSON"] };
  }
  if (doc?.format === BACKUP_FORMAT) {
    if (doc.backup_version !== BACKUP_VERSION) return { ok: false, errors: [`unsupported backup_version ${doc.backup_version}`] };
    const actual = await sha256Hex(canonicalJson(doc.payload));
    if (actual !== doc.checksum_sha256) return { ok: false, errors: ["checksum mismatch: the file was modified or corrupted; nothing imported"] };
    return { ok: true, payload: doc.payload, checksum: "VERIFIED" };
  }
  // Plain v1 exports carried no checksum; they are accepted but labeled.
  return { ok: true, payload: doc, checksum: "ABSENT" };
}

export function fsaSupported(win = globalThis) {
  return typeof win.showDirectoryPicker === "function";
}

export async function chooseBackupDirectory(store, win = globalThis) {
  if (!fsaSupported(win)) return { state: "UNSUPPORTED", reason: "File System Access API not available in this browser (UNVERIFIED outside Chromium); use Export" };
  const handle = await win.showDirectoryPicker({ id: "orcastrike-backups", mode: "readwrite" });
  await store.set("backup_dir_handle", handle);
  return { state: "CHOSEN", name: handle.name };
}

// Writes orcastrike-ledger-YYYY-MM-DD.json once per UTC day into the chosen directory.
export async function dailyBackup(store, buildPayload, nowIso, { force = false, win = globalThis } = {}) {
  if (!fsaSupported(win)) return { state: "UNSUPPORTED", reason: "use manual Export (checksummed)" };
  const handle = await store.get("backup_dir_handle");
  if (!handle) return { state: "NO_DIRECTORY", reason: "choose a backup folder" };
  const day = nowIso.slice(0, 10);
  if (!force && (await store.get("last_backup_day")) === day) return { state: "SKIPPED_TODAY", day };
  const perm = typeof handle.queryPermission === "function" ? await handle.queryPermission({ mode: "readwrite" }) : "granted";
  if (perm !== "granted") return { state: "PERMISSION_NEEDED", reason: "click Back up now to grant access to the folder again" };
  try {
    const backup = await makeBackup(buildPayload(), nowIso);
    const file = await handle.getFileHandle(`orcastrike-ledger-${day}.json`, { create: true });
    const w = await file.createWritable();
    await w.write(JSON.stringify(backup, null, 2));
    await w.close();
    await store.set("last_backup_day", day);
    return { state: "WRITTEN", day, checksum_sha256: backup.checksum_sha256 };
  } catch (err) {
    return { state: "ERROR", reason: err?.message ?? "write failed" };
  }
}
