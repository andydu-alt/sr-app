// Sync loop: sends the outbox, receives other devices' changes. Status: synced | syncing | offline | failed | login | unavailable.
import { SYNC_URL } from './config.js';
import * as store from './store.js';
import { accessToken } from './auth.js';

export const status = { state: 'synced', message: '', lastOk: 0, failures: 0 };
const listeners = new Set();
export const onStatus = fn => listeners.add(fn);
const set = (state, message = '') => { status.state = state; status.message = message; listeners.forEach(fn => fn(status)); };

let running = null, again = false, timer = null;

export function syncSoon(ms = 1500) { clearTimeout(timer); timer = setTimeout(() => syncNow(), ms); }

export async function syncNow() {
  if (running) { again = true; return running; }
  running = (async () => {
    do {
      again = false;
      if (!navigator.onLine) { set('offline'); break; }
      set('syncing');
      try {
        const token = await accessToken();
        const ids = [...store.outbox].slice(0, 2000);
        const sent = new Map(); const changes = [];
        for (const id of ids) { const r = store.records.get(id); if (r) { sent.set(id, r.updatedAt); const { rev, ...clean } = r; changes.push(clean); } }
        const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), 20000);
        const res = await fetch(SYNC_URL, { method: 'POST', signal: ctl.signal,
          headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token },
          body: JSON.stringify({ since: store.meta.since, changes }) }).finally(() => clearTimeout(t));
        if (res.status === 401) { set('login', 'Log in again to sync. Your changes are safe on this device.'); break; }
        if (!res.ok) throw new Error('HTTP ' + res.status);
        const body = await res.json();
        await store.applyRemote(body.changes || [], body.rev, sent);
        status.lastOk = Date.now(); status.failures = 0;
        if (store.outbox.size && ids.length === 2000) again = true;
        set('synced');
      } catch (e) {
        if (e && e.status === 401) { set('login', 'Log in again to sync. Your changes are safe on this device.'); break; }
        if (!navigator.onLine) { set('offline'); break; }
        status.failures++;
        set(status.failures >= 6 ? 'unavailable' : 'failed',
          status.failures >= 6 ? 'Sync unavailable right now. The app keeps working; changes stay on this device.' : 'Sync failed: the server did not answer. Your changes are safe on this device.');
        break;
      }
    } while (again);
    running = null;
  })();
  return running;
}

export function startAutoSync() {
  store.onChange(fromSync => { if (!fromSync) syncSoon(); });
  addEventListener('online', () => syncNow());
  addEventListener('offline', () => set('offline'));
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') syncNow(); });
  setInterval(() => { if (document.visibilityState === 'visible') syncNow(); }, 30000);
  if (!navigator.onLine) set('offline');
}
