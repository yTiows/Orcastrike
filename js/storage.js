// Browser storage for the ledger and fee models. IndexedDB is primary. If it can't be
// opened (private mode, blocked site data), localStorage is the fallback, then memory
// (non-persistent, surfaced as a warning). The first IndexedDB open migrates the v1
// localStorage ledger. The localStorage copy is never deleted, so migration is non-destructive.
// Settings, watchlist and the circuit-breaker timestamp stay in localStorage (js/state.js).

import { migrateLedger, replayLedger } from "./ledger.js";

const DB_NAME = "orcastrike";
const STORE = "kv";
const LS_V1_LEDGER = "sat.ledger.v1";
const LS_FALLBACK_PREFIX = "sat.fallback.";

function req(r) {
  return new Promise((resolve, reject) => {
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error ?? new Error("IndexedDB request failed"));
  });
}

async function openIdb(indexedDB, timeoutMs = 3000) {
  if (!indexedDB) throw new Error("IndexedDB unavailable");
  const open = indexedDB.open(DB_NAME, 1);
  open.onupgradeneeded = () => {
    if (!open.result.objectStoreNames.contains(STORE)) open.result.createObjectStore(STORE);
  };
  return Promise.race([req(open), new Promise((_, rej) => setTimeout(() => rej(new Error("IndexedDB open timed out")), timeoutMs))]);
}

function idbStore(db) {
  return {
    kind: "indexeddb",
    async get(key) {
      return req(db.transaction(STORE, "readonly").objectStore(STORE).get(key));
    },
    async set(key, value) {
      const tx = db.transaction(STORE, "readwrite");
      tx.objectStore(STORE).put(value, key);
      await new Promise((resolve, reject) => {
        tx.oncomplete = resolve;
        tx.onerror = () => reject(tx.error);
        tx.onabort = () => reject(tx.error ?? new Error("transaction aborted"));
      });
    },
  };
}

function lsStore(ls) {
  return {
    kind: "localstorage",
    async get(key) {
      const raw = ls.getItem(LS_FALLBACK_PREFIX + key);
      return raw === null ? undefined : JSON.parse(raw);
    },
    async set(key, value) {
      ls.setItem(LS_FALLBACK_PREFIX + key, JSON.stringify(value));
    },
  };
}

function memoryStore() {
  const m = new Map();
  return { kind: "memory", async get(k) { return m.get(k); }, async set(k, v) { m.set(k, v); } };
}

function usableLocalStorage(ls) {
  try {
    ls.setItem("sat.__probe", "1");
    ls.removeItem("sat.__probe");
    return true;
  } catch {
    return false;
  }
}

// Returns { store, warnings, migration }.
export async function openStorage({ indexedDB = globalThis.indexedDB, localStorage = globalThis.localStorage } = {}) {
  const warnings = [];
  let store;
  try {
    store = idbStore(await openIdb(indexedDB));
  } catch (err) {
    warnings.push(`IndexedDB unavailable (${err?.message ?? "error"}); using a fallback`);
    if (localStorage && usableLocalStorage(localStorage)) store = lsStore(localStorage);
    else {
      store = memoryStore();
      warnings.push("no persistent browser storage: the ledger will be lost on reload; export it");
    }
  }
  let migration = null;
  try {
    if (store.kind === "indexeddb" && (await store.get("ledger")) === undefined && localStorage && usableLocalStorage(localStorage)) {
      const raw = localStorage.getItem(LS_V1_LEDGER);
      if (raw) {
        const parsed = JSON.parse(raw);
        const migrated = migrateLedger(parsed);
        const r = replayLedger(migrated);
        if (r.ok) {
          await store.set("ledger", migrated);
          migration = { from: "localStorage", key: LS_V1_LEDGER, schema_from: parsed.schema_version, at: new Date().toISOString(), source_kept: true };
          await store.set("migration", migration);
        } else {
          warnings.push(`localStorage ledger failed validation and was NOT migrated (${r.errors[0]}); it is left untouched`);
        }
      }
    }
  } catch (err) {
    warnings.push(`migration from localStorage failed: ${err?.message ?? "error"}; source left untouched`);
  }
  return { store, warnings, migration: migration ?? (store.kind === "indexeddb" ? (await store.get("migration")) ?? null : null) };
}
