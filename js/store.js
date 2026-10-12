// Local data: every record kept in memory and saved to IndexedDB (one database per user).
// Records: deck, card, review, settings, profile. Changed ids wait in the outbox until synced.
import { wins } from './merge.js';

let db = null, dbName = null;
export const records = new Map();
export const outbox = new Set();
export const meta = { since: 0 };
const listeners = new Set();
export const onChange = fn => listeners.add(fn);
const emit = (fromSync) => listeners.forEach(fn => fn(fromSync));

export const DEVICE = (() => {
  try { let d = localStorage.getItem('sr-device'); if (!d) { d = rid(); localStorage.setItem('sr-device', d); } return d; }
  catch { return rid(); }
})();
export function rid() { return (crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36) + Math.random().toString(36).slice(2)); }

function idb(name) {
  return new Promise((res, rej) => {
    const r = indexedDB.open(name, 1);
    r.onupgradeneeded = () => { r.result.createObjectStore('records', { keyPath: 'id' }); r.result.createObjectStore('meta'); };
    r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
  });
}
const tx = (store, mode, fn) => new Promise((res, rej) => {
  const t = db.transaction(store, mode); const out = fn(t.objectStore(store));
  t.oncomplete = () => res(out && out.result); t.onerror = () => rej(t.error);
});

export async function open(userId) {
  records.clear(); outbox.clear(); meta.since = 0;
  dbName = 'sr-app-' + userId;
  try {
    db = await idb(dbName);
    const all = await new Promise((res, rej) => { const r = db.transaction('records').objectStore('records').getAll(); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
    for (const rec of all) records.set(rec.id, rec);
    const m = await new Promise(res => { const r = db.transaction('meta').objectStore('meta').get('state'); r.onsuccess = () => res(r.result); r.onerror = () => res(null); });
    if (m) { meta.since = m.since || 0; (m.outbox || []).forEach(id => outbox.add(id)); }
  } catch { db = null; } // private mode: memory only
  emit(false);
}

async function persist(recs) {
  if (!db) return;
  await tx('records', 'readwrite', s => { for (const r of recs) s.put(r); });
  await tx('meta', 'readwrite', s => s.put({ since: meta.since, outbox: [...outbox] }, 'state'));
}

// Local change: stamp, store, queue for sync.
export async function put(...recs) {
  const now = Date.now();
  for (const r of recs) { r.updatedAt = Math.max(now, (records.get(r.id)?.updatedAt || 0) + 1); r.device = DEVICE; records.set(r.id, r); outbox.add(r.id); }
  emit(false);
  await persist(recs);
}

// Records arriving from the server.
// sent: Map id → updatedAt at the moment the change was sent. Unchanged since then = done.
export async function applyRemote(recs, newSince, sent = new Map()) {
  const changed = [];
  for (const [id, at] of sent) if (records.get(id)?.updatedAt === at) outbox.delete(id);
  for (const r of recs) {
    const mine = records.get(r.id);
    if (mine && mine.updatedAt === r.updatedAt && mine.device === r.device) continue; // our own change echoed back
    if (!mine || wins(r, mine)) { records.set(r.id, r); changed.push(r); outbox.delete(r.id); }
  }
  meta.since = Math.max(meta.since, newSince || 0);
  if (changed.length) emit(true);
  await persist(changed);
}

export async function wipe() {
  records.clear(); outbox.clear(); meta.since = 0;
  try { if (db) db.close(); } catch {}
  db = null;
  if (dbName) await new Promise(res => { const r = indexedDB.deleteDatabase(dbName); r.onsuccess = r.onerror = r.onblocked = () => res(); });
}

export const all = type => [...records.values()].filter(r => r.type === type && !r.deleted);
export const get = id => { const r = records.get(id); return r && !r.deleted ? r : null; };
