// SR App: screens and actions. State lives in store.js (records) and UI (what is on screen).
import * as store from './store.js';
import * as auth from './auth.js';
import * as sync from './sync.js';
import { makeScheduler, replay, cardInfo, previewIntervals, buildQueue, pickNext, progress, dayStart, nextDayStart, fmtInterval, LEECH_LAPSES, RATING_NAME } from './sched.js';
import { esc, norm, canon, gradeTyped, diff, containsWord, clozeSplit, cleanSelection, similar, parseDelimited } from './text.js';
import { lookupWordIn, exampleSentencesIn, pronunciationIn } from './lookup.js';
import { STARTER } from './starter.js';
import { IS_NETLIFY_COPY, MAIN_APP_URL } from './config.js';
import { translate, uiLang, setUiLang, missing } from './i18n.js';
window.__i18nMissing = missing;

const $app = document.getElementById('app');
const A = {}; window.A = A;
const DEFAULTS = { newPerDay: 15, reviewsPerDay: 200, retention: 90, accent: 'UK', theme: 'system', modes: { flashcard: true, reverse: true, typing: true, mc: true, cloze: true } };
const MODE_NAME = { flashcard: 'Flashcard', reverse: 'Reverse', typing: 'Typing', mc: 'Multiple choice', cloze: 'Cloze' };
const ICON = {
  home: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 11l9-7 9 7v9a1 1 0 0 1-1 1h-5v-6H9v6H4a1 1 0 0 1-1-1z"/></svg>',
  decks: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="4" y="6" width="14" height="14" rx="2"/><path d="M8 3h11a2 2 0 0 1 2 2v11"/></svg>',
  progress: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M4 20V10M10 20V4M16 20v-7M22 20H2"/></svg>',
  settings: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="3"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3M4.9 4.9l2.1 2.1M17 17l2.1 2.1M4.9 19.1L7 17M17 7l2.1-2.1"/></svg>',
  speak: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M11 5L6 9H2v6h4l5 4zM15.5 8.5a5 5 0 0 1 0 7M19 5a10 10 0 0 1 0 14"/></svg>',
};
const ls = { get(k, d) { try { const v = localStorage.getItem(k); return v === null ? d : v; } catch { return d; } }, set(k, v) { try { localStorage.setItem(k, v); } catch {} } };
const ss = { get(k) { try { return JSON.parse(sessionStorage.getItem(k) || 'null'); } catch { return null; } }, set(k, v) { try { v === null ? sessionStorage.removeItem(k) : sessionStorage.setItem(k, JSON.stringify(v)); } catch {} } };

let UI = { screen: 'boot', tab: 'home' };
let M = null; // derived model, rebuilt when records change
store.onChange(() => { M = null; if (UI.screen !== 'boot' && UI.screen !== 'study') render(); });
let lastSyncState = null;
sync.onStatus(st => {
  const changed = st.state !== lastSyncState; lastSyncState = st.state;
  if (changed && ['home', 'settings'].includes(UI.screen) && !UI.modal) return render();
  const p = document.getElementById('syncpill'); if (p) p.outerHTML = syncPill();
});

// ───────── Derived data ─────────
function settings() { const s = store.get('settings'); return { ...DEFAULTS, ...(s || {}), modes: { ...DEFAULTS.modes, ...((s && s.modes) || {}) } }; }
function model() {
  if (M) return M;
  const st = settings(); const f = makeScheduler(st.retention / 100);
  const revs = new Map();
  for (const r of store.all('review')) { if (!revs.has(r.cardId)) revs.set(r.cardId, []); revs.get(r.cardId).push(r); }
  for (const list of revs.values()) list.sort((a, b) => a.time - b.time);
  const decks = store.all('deck').sort((a, b) => (a.order ?? a.createdAt) - (b.order ?? b.createdAt));
  const deckIds = new Set(decks.map(d => d.id));
  const items = [], byId = new Map();
  for (const card of store.all('card')) {
    if (!deckIds.has(card.deckId)) continue;
    const { fc, log, firstReview } = replay(f, card, revs.get(card.id) || []);
    const it = { card, fc, info: cardInfo(fc), log, firstReview };
    items.push(it); byId.set(card.id, it);
  }
  const start = dayStart();
  const newDoneToday = items.filter(x => x.firstReview !== null && x.firstReview >= start).length;
  let reviewsDoneToday = 0;
  for (const x of items) for (const l of x.log) if (l.time >= start && l.prev === 2) reviewsDoneToday++;
  M = { st, f, decks, items, byId, newDoneToday, reviewsDoneToday, allReviews: store.all('review') };
  return M;
}
const deckName = id => (store.get(id) || {}).name || 'Deck';
function queueFor(deckId = null, extraNew = 0) {
  const m = model();
  // "Study all" only uses decks that are switched on; a single deck can always be studied directly.
  const items = deckId ? m.items : m.items.filter(x => !(store.get(x.card.deckId) || {}).off);
  return buildQueue(items, { newLimit: m.st.newPerDay, reviewLimit: m.st.reviewsPerDay, newDoneToday: m.newDoneToday, reviewsDoneToday: m.reviewsDoneToday, deckId, extraNew });
}
function deckStats(deckId) {
  const m = model(); const q = queueFor(deckId);
  const cards = m.items.filter(x => x.card.deckId === deckId && !x.card.suspended);
  const mastered = cards.filter(x => x.info.mastered).length;
  return { due: q.learning.length + q.reviews.length, newCount: q.newCards.length, total: m.items.filter(x => x.card.deckId === deckId).length,
    mastery: cards.length ? Math.round(mastered / cards.length * 100) : 0 };
}

// ───────── Rendering ─────────
function go(screen, extra = {}, push = true) {
  UI = { ...UI, ...extra, screen, modal: null };
  UI.tab = { home: 'home', study: 'home', done: 'home', decks: 'decks', deck: 'decks', card: 'decks', import: 'decks', progress: 'progress', settings: 'settings', help: 'settings' }[screen] || UI.tab;
  if (push) try { history.pushState({ screen }, ''); } catch {}
  render();
  const sc = $app.querySelector('.scroll'); if (sc) sc.scrollTop = 0;
}
A.go = (s, deckId) => go(s, deckId !== undefined ? { deckId } : {});
addEventListener('popstate', () => {
  if (UI.modal) { UI.modal = null; render(); return; }
  if (['boot', 'login', 'home'].includes(UI.screen)) return;
  const back = { study: 'home', done: 'home', add: UI.addReturn || 'home', card: 'deck', deck: 'decks', import: UI.importReturn || 'decks', help: 'settings' }[UI.screen] || 'home';
  go(back, {}, false);
});

function render() {
  const f = document.activeElement; const fid = f && f.id; let sel = null;
  try { if (fid && f.selectionStart != null) sel = [f.selectionStart, f.selectionEnd]; } catch {}
  const view = V[UI.screen] || V.home;
  $app.innerHTML = view() + modalHtml() + (UI.toast ? `<div class="toast" role="status">${esc(UI.toast)}</div>` : '');
  translate($app);
  if (fid) { const el = document.getElementById(fid); if (el) { el.focus({ preventScroll: true }); try { if (sel) el.setSelectionRange(sel[0], sel[1]); } catch {} } }
  const af = $app.querySelector('[data-autofocus]'); if (af && !fid) af.focus();
}
let toastTimer;
function toast(t) { UI.toast = t; render(); clearTimeout(toastTimer); toastTimer = setTimeout(() => { UI.toast = null; render(); }, 2600); }
function modal(m) { UI.modal = m; render(); }
A.closeModal = () => { UI.modal = null; render(); };
A.modalOk = async () => { const m = UI.modal; if (!m) return; const val = document.getElementById('modalin')?.value; const lang = document.getElementById('modallang')?.value; UI.modal = null; UI.modalLang = lang; await m.onOk(val); };
A.modalAlt = async () => { const m = UI.modal; UI.modal = null; if (m && m.onAlt) await m.onAlt(); else render(); };
function modalHtml() {
  const m = UI.modal; if (!m) return '';
  return `<div class="overlay" onclick="if(event.target===this)A.closeModal()"><div class="dialog" role="dialog" aria-modal="true" aria-labelledby="mt">
   <h3 id="mt">${esc(m.title)}</h3>${m.html ? m.html : `<p>${esc(m.body || '')}</p>`}
   <div class="btns"><button class="btn ghost" onclick="A.modalAlt()">${esc(m.alt || 'Cancel')}</button><button class="btn ${m.danger ? 'danger' : ''}" onclick="A.modalOk()">${esc(m.ok)}</button></div></div></div>`;
}
function tabs() {
  return `<nav class="tabs">${[['home', 'Home'], ['decks', 'Decks'], ['progress', 'Progress'], ['settings', 'Settings']].map(([id, n]) =>
    `<button class="${UI.tab === id ? 'on' : ''}" onclick="A.go('${id}')" aria-label="${n}">${ICON[id]}${n}</button>`).join('')}</nav>`;
}
function syncPill() {
  const s = sync.status.state;
  const [cls, label] = { synced: ['', 'Synced'], syncing: ['busy', 'Syncing…'], offline: ['off', 'Offline · saved here'], failed: ['fail', 'Sync failed'],
    login: ['fail', 'Log in to sync'], unavailable: ['fail', 'Sync unavailable'] }[s] || ['', 'Synced'];
  const retry = s === 'failed' || s === 'unavailable';
  return `<span id="syncpill" class="syncwrap"><button class="pill ${cls}" onclick="A.syncInfo()" aria-label="Sync status: ${label}"><i></i>${label}</button>${retry ? `<button class="retry" onclick="A.retrySync()" aria-label="Retry sync">↻ Retry</button>` : ''}</span>`;
}
A.retrySync = async () => { toast('Trying to sync…'); await sync.syncNow(); toast(sync.status.state === 'synced' ? 'Synced.' : 'Still can’t reach the server. Your changes are safe on this device.'); };
A.syncInfo = () => {
  const s = sync.status;
  if (s.state === 'login') return A.relogin();
  if (false) { toast('Trying to sync…'); return sync.syncNow().then(() => toast(sync.status.state === 'synced' ? 'Synced.' : 'Still can’t reach the server. Your changes are safe on this device.')); }
  const pending = store.outbox.size;
  modal({ title: { synced: 'All changes synced', syncing: 'Syncing…', offline: 'Offline', failed: 'Sync failed', unavailable: 'Sync unavailable' }[s.state] || 'Sync',
    body: (s.message || (s.state === 'offline' ? 'You can keep studying. Changes are saved on this device and sync when you are back online.' : 'Your cards are the same on all your devices.'))
      + (pending ? ` ${pending} change${pending > 1 ? 's' : ''} waiting to sync.` : ''),
    ok: 'Sync now', alt: 'Close', onOk: () => sync.syncNow() });
};
const speakBtn = (text, lang = 'en') => `<button class="speak" aria-label="Play pronunciation" onclick="A.speak(this.dataset.say, this.dataset.lang)" data-say="${esc(text)}" data-lang="${lang}">${ICON.speak}</button>`;
const deckLang = deckId => (store.get(deckId) || {}).lang || 'en';
const greeting = () => { const h = new Date().getHours(); return h < 12 ? 'Good morning' : h < 18 ? 'Good afternoon' : 'Good evening'; };
const userName = () => (auth.current()?.user?.name || '').split(' ')[0];

// ───────── Speech ─────────
let voices = [];
const loadVoices = () => { try { voices = speechSynthesis.getVoices(); } catch {} };
try { loadVoices(); speechSynthesis.onvoiceschanged = loadVoices; } catch {}
// Best-sounding voices first: natural/neural/enhanced voices beat the old robotic ones.
function voiceScore(v, lang) {
  const n = v.name.toLowerCase(); let s = 0;
  const base = lang.slice(0, 2).toLowerCase();
  if (v.lang.replace('_', '-').toLowerCase() === lang.toLowerCase()) s += 100; else if (v.lang.toLowerCase().startsWith(base)) s += 10; else return -1;
  if (/natural|neural|online/.test(n)) s += 50;
  if (/enhanced|premium|siri/.test(n)) s += 45;
  if (/^google/.test(n)) s += 30;
  if (/sonia|libby|ryan|maisie|thomas|daniel|kate|serena|arthur|martha|aria|jenny|guy|samantha|ava|zoe|evan|denise|henri|eloise|vivienne|remy|amelie|audrey|aurelie/.test(n)) s += 15;
  if (/compact|espeak|novelty|zarvox|whisper|bad news|bells|boing|bubbles|cellos|jester|organ|superstar|trinoids|wobble|albert|fred|junior|ralph|grandma|grandpa|eddy|flo|reed|rocko|sandy|shelley/.test(n)) s -= 80;
  if (v.localService === false) s += 5;
  return s;
}
const englishVoices = lang => voices.map(v => [v, voiceScore(v, lang)]).filter(x => x[1] >= 0).sort((a, b) => b[1] - a[1]).map(x => x[0]);
function chosenVoice(learn = 'en') {
  if (learn === 'fr') { const saved = ls.get('sr-voice-fr', ''); return voices.find(v => v.name === saved) || englishVoices((settings().frAccent === 'CA' ? 'fr-CA' : 'fr-FR'))[0] || null; }
  const lang = settings().accent === 'US' ? 'en-US' : 'en-GB';
  const saved = ls.get('sr-voice', '');
  return voices.find(v => v.name === saved) || englishVoices(lang)[0] || null;
}
window.ls_clearVoice = () => ls.set('sr-voice', '');
window.ls_clearVoiceFr = () => ls.set('sr-voice-fr', '');
try { speechSynthesis.addEventListener('voiceschanged', () => { if (UI.screen === 'settings') render(); }); } catch {}
A.setVoice = name => { ls.set('sr-voice', name); A.speak('Hello! This is how SR App will read your words.'); render(); };
A.setVoiceFr = name => { ls.set('sr-voice-fr', name); A.speak('Bonjour ! Voici comment SR App lira vos mots.', 'fr'); render(); };
A.speak = (text, learn = 'en') => {
  try {
    const lang = learn === 'fr' ? (settings().frAccent === 'CA' ? 'fr-CA' : 'fr-FR') : settings().accent === 'US' ? 'en-US' : 'en-GB';
    const u = new SpeechSynthesisUtterance(text); u.lang = lang; u.rate = 0.95;
    const v = chosenVoice(learn);
    if (v) { u.voice = v; u.lang = v.lang; }
    speechSynthesis.cancel(); speechSynthesis.speak(u);
  } catch { toast('Audio is not available in this browser.'); }
};

// ───────── Views ─────────
const V = {};
V.boot = () => `<div class="scroll" style="justify-content:center"><div class="logo">SR <span class="hl">App</span></div><p class="center muted">${esc(UI.bootMsg || 'Loading…')}</p></div>`;

// Account
V.login = () => {
  const reg = UI.authMode === 'reg';
  const expired = auth.current()?.expired;
  return `<div class="scroll" style="justify-content:center;gap:14px">
  <div class="logo">SR <span class="hl">App</span></div>
  <p class="muted center">Learn English words that stay.</p>
  <div class="seg" style="align-self:center"><button class="${!reg ? 'on' : ''}" onclick="A.authMode('login')">Log in</button><button class="${reg ? 'on' : ''}" onclick="A.authMode('reg')">Register</button></div>
  ${expired && !reg ? `<div class="warn">Your login has expired. Log in again to sync. Changes on this device are kept.</div>` : ''}
  <form id="authform" onsubmit="event.preventDefault();A.${reg ? 'register' : 'login'}()" style="display:flex;flex-direction:column;gap:14px">
  ${reg ? `<div class="field"><label for="nm">Your name</label><input id="nm" autocomplete="given-name" required maxlength="40" value="${esc(UI.fName || '')}"></div>` : ''}
  <div class="field"><label for="em">Email</label><input id="em" type="email" autocomplete="email" required value="${esc(UI.fEmail || auth.current()?.user?.email || '')}"></div>
  <div class="field"><label for="pw">Password</label><input id="pw" type="password" autocomplete="${reg ? 'new-password' : 'current-password'}" required minlength="${reg ? 8 : 1}">${reg ? '<span class="hint">At least 8 characters.</span>' : ''}</div>
  ${UI.authErr === 'EMAIL_EXISTS' ? `<div class="err">This email already has an account. <button type="button" class="link" onclick="A.authMode('login')">Log in</button> or <button type="button" class="link" onclick="A.forgot()">reset the password</button>.</div>` : UI.authErr ? `<div class="err">${esc(UI.authErr)}</div>` : ''}
  ${UI.authOk ? `<div class="ok">${esc(UI.authOk)}</div>` : ''}
  <button class="btn" type="submit" ${UI.busy ? 'disabled' : ''}>${UI.busy ? 'Please wait…' : reg ? 'Create account' : 'Log in'}</button>
  </form>
  ${!reg ? `<button class="btn ghost" onclick="A.forgot()">Forgot password?</button>` : ''}</div>`;
};
A.authMode = m => { keepAuthFields(); UI.authMode = m; UI.authErr = UI.authOk = null; render(); };
function keepAuthFields() { UI.fEmail = document.getElementById('em')?.value ?? UI.fEmail; UI.fName = document.getElementById('nm')?.value ?? UI.fName; }
A.login = async () => {
  keepAuthFields(); const email = UI.fEmail.trim(), pw = document.getElementById('pw').value;
  UI.busy = true; UI.authErr = UI.authOk = null; render();
  try {
    const prev = auth.current();
    const s = await auth.login(email, pw);
    if (prev && prev.user && prev.user.id !== s.user.id) { await store.open(prev.user.id); await store.wipe(); }
    UI.busy = false; await startSession();
  } catch (e) { UI.busy = false; UI.authErr = e.message; render(); }
};
A.register = async () => {
  keepAuthFields(); const name = UI.fName.trim(), email = UI.fEmail.trim(), pw = document.getElementById('pw').value;
  if (pw.length < 8) { UI.authErr = 'Password must be at least 8 characters.'; render(); return; }
  UI.busy = true; UI.authErr = null; render();
  try { await auth.signup(name, email, pw); UI.busy = false; go('verify', { verifyEmail: email }); }
  catch (e) { UI.busy = false; UI.authErr = e.message; render(); }
};
A.forgot = async () => {
  keepAuthFields(); const email = (UI.fEmail || '').trim();
  if (!email) { UI.authErr = 'Type your email above, then tap "Forgot password?" again.'; UI.authMode = 'login'; render(); return; }
  try { await auth.recover(email); UI.authMode = 'login'; UI.authErr = null; UI.authOk = `If ${email} has an account, we sent a reset link. Check your inbox and spam.`; render(); }
  catch (e) { UI.authErr = e.message; render(); }
};
A.relogin = () => go('login', { authMode: 'login', authErr: null, authOk: null });
V.verify = () => `<div class="scroll" style="justify-content:center;text-align:center;gap:14px">
  <div class="logo">Check your email</div>
  <p>We sent a confirmation link to <b>${esc(UI.verifyEmail || 'your email')}</b>.</p>
  <p class="small muted">Open it on any device. Then log in here. No email after 5 minutes? Check spam.</p>
  <button class="btn" onclick="A.go('login')">I've confirmed — log in</button></div>`;
V.confirmed = () => `<div class="scroll" style="justify-content:center;text-align:center;gap:14px"><div class="logo">✓</div><h2 style="margin:0">${esc(UI.confirmTitle || 'Email confirmed')}</h2>
  ${IS_NETLIFY_COPY ? `<p class="muted">Open SR App and log in.</p><a class="btn" href="${MAIN_APP_URL}">Open SR App</a>` : `<p class="muted">You're logged in on this device.</p><button class="btn" onclick="A.startSession()">Continue</button>`}</div>`;
V.setpw = () => `<div class="scroll" style="justify-content:center;gap:14px"><h2 style="margin:0;text-align:center">Set a new password</h2>
  <form onsubmit="event.preventDefault();A.savePw()" style="display:flex;flex-direction:column;gap:14px">
  <div class="field"><label for="np">New password</label><input id="np" type="password" autocomplete="new-password" minlength="8" required><span class="hint">At least 8 characters.</span></div>
  <div class="field"><label for="np2">Repeat new password</label><input id="np2" type="password" autocomplete="new-password" required></div>
  ${UI.authErr ? `<div class="err">${esc(UI.authErr)}</div>` : ''}
  <button class="btn" type="submit">Save new password</button></form></div>`;
A.savePw = async () => {
  const a = document.getElementById('np').value, b = document.getElementById('np2').value;
  if (a.length < 8) { UI.authErr = 'Password must be at least 8 characters.'; return render(); }
  if (a !== b) { UI.authErr = 'The two passwords are different.'; return render(); }
  try { await auth.setPassword(a); go('confirmed', { confirmTitle: 'Password changed' }); } catch (e) { UI.authErr = e.message; render(); }
};
V.expired = () => `<div class="scroll" style="justify-content:center;text-align:center;gap:14px"><div class="logo">Link expired</div>
  <p>This link was already used or is too old.</p><p class="small muted">${esc(UI.expiredHint || 'Go back to log in and request a new link.')}</p>
  <a class="btn" href="${IS_NETLIFY_COPY ? MAIN_APP_URL : './'}">Back to log in</a></div>`;

// First login
V.firstrun = () => `<div class="top"><h2>Welcome, ${esc(userName())}</h2></div><div class="scroll">
  <p>Pick starter decks to begin. You can edit every card later.</p>
  ${STARTER.map((d, i) => `<label class="deck" style="color:var(--ink);font-size:14px;font-weight:400;margin:0;cursor:pointer;padding-right:14px"><input type="checkbox" id="st${i}" checked><div style="min-width:0"><h3>${esc(d.name)}</h3><span class="muted small">${d.cards.length} cards · words with explanations, examples and UK pronunciation</span></div></label>`).join('')}
  <button class="btn" onclick="A.addStarters()">Add decks and start</button>
  <button class="btn ghost" onclick="A.skipStarters()">Start with no decks</button></div>`;
async function markStarterOffered() { await store.put({ id: 'profile', type: 'profile', starterOffered: true }); }
async function addStarterDeck(i) {
  const d = STARTER[i]; const now = Date.now();
  const deck = { id: store.rid(), type: 'deck', name: d.name, createdAt: now, order: now };
  const cards = d.cards.map(([word, explanation, example, ipa], k) => ({ id: store.rid(), type: 'card', deckId: deck.id, word, explanation, example, ipa, notes: '', tags: [], createdAt: now + k, order: k }));
  await store.put(deck, ...cards);
}
A.addStarters = async () => {
  const picks = STARTER.map((_, i) => document.getElementById('st' + i)?.checked);
  for (let i = 0; i < picks.length; i++) if (picks[i]) await addStarterDeck(i);
  await markStarterOffered(); A.afterLogin();
};
A.skipStarters = async () => { await markStarterOffered(); A.afterLogin(); };

// Home
V.home = () => {
  const m = model();
  if (!m.decks.length) return `<div class="top"><h2>Hi, ${esc(userName())}</h2>${syncPill()}</div><div class="scroll"><div class="empty"><div class="big">Aa</div><h3 style="margin:0">No decks yet</h3>
    <p class="muted">Add your first word, import a list, or start with a ready-made deck.</p>
    <button class="btn" onclick="A.openAdd()">Add a word</button><button class="btn ghost" onclick="A.go('firstrun')">Add starter decks</button><button class="btn ghost" onclick="A.openImport()">Import a list</button></div></div>${tabs()}`;
  const q = queueFor(); const due = q.learning.length + q.reviews.length, nw = q.newCards.length;
  const p = progress(m.items, m.allReviews);
  const mins = Math.max(1, Math.round((q.reviews.length * 10 + q.learning.length * 10 + nw * 35) / 60));
  const fill = m.items.filter(x => x.card.fillLater).length;
  const nextDue = m.items.filter(x => !x.card.suspended && !x.info.isNew).map(x => x.info.due).sort((a, b) => a - b)[0];
  const anyNew = m.items.some(x => x.info.isNew && !x.card.suspended);
  return `<div class="top"><h2>${greeting()}, ${esc(userName())}</h2>${syncPill()}</div><div class="scroll">
  <form class="quick" onsubmit="event.preventDefault();A.quickAdd()"><input id="qa" placeholder="Quick Add: type or paste a word" maxlength="200" autocapitalize="none" aria-label="Quick Add" oninput="document.getElementById('qab').disabled=!this.value.trim()"><button class="btn sm" id="qab" disabled type="submit">Add</button></form>
  ${fill && navigator.onLine ? `<div class="banner"><span>${fill} card${fill > 1 ? 's need' : ' needs'} details.</span><button class="link" onclick="A.openDeck(null,'Fill later')">Fill now</button></div>` : ''}
  ${sync.status.state === 'login' ? `<div class="banner"><span>Log in again to sync. Your changes are safe here.</span><button class="link" onclick="A.relogin()">Log in</button></div>` : ''}
  <div class="stat-row"><div class="stat"><b>${due}</b><span>reviews due</span></div><div class="stat"><b>${nw}</b><span>new today</span></div><div class="stat"><b>${p.streak}</b><span>day streak</span></div></div>
  ${due + nw ? `<button class="btn" onclick="A.study(null)">Study all decks · about ${mins} min</button>${q.reviewsCapped ? `<p class="small muted">${q.reviewsCapped} more reviews are waiting beyond your daily limit of ${m.st.reviewsPerDay}.</p>` : ''}`
    : `<div class="empty" style="padding:8px 0"><h3 style="margin:0">Nothing due right now</h3><p class="muted">${nextDue ? 'Next review ' + whenText(nextDue) + '.' : 'Add words to start learning.'}</p>${anyNew ? `<button class="btn ghost" onclick="A.study(null,5)">Learn 5 extra new words</button>` : ''}</div>`}
  ${m.decks.map(d => { const s = deckStats(d.id); return `<div class="deck ${d.off ? 'is-off' : ''}"><button class="main" onclick="${s.due + s.newCount ? `A.study('${d.id}')` : `A.openDeck('${d.id}')`}"><h3><span data-notr>${esc(d.name)}</span>${d.lang === 'fr' ? ' <span class="tag">FR</span>' : ''}</h3>
    <span class="counts">${d.off ? `<span class="muted">Off · not included in Study all</span>` : s.total ? `<span><span class="due">${s.due}</span> due</span><span><span class="new">${s.newCount}</span> new</span><span class="muted">${s.mastery}% mastered</span>` : `<span class="muted">No cards yet · tap to add</span>`}</span>
    <span class="bar"><i style="width:${s.mastery}%"></i></span></button>${switchHtml(d)}<button class="icon" aria-label="Manage ${esc(d.name)}" onclick="A.openDeck('${d.id}')">⋯</button></div>`; }).join('')}
  </div>${tabs()}`;
};
function switchHtml(d) { return `<button class="switch ${d.off ? '' : 'on'}" role="switch" aria-checked="${!d.off}" aria-label="Include ${esc(d.name)} in Study all" onclick="A.toggleDeck('${d.id}')"><i></i></button>`; }
A.toggleDeck = async id => { const d = store.get(id); if (!d) return; await store.put({ ...d, off: !d.off }); render(); toast(d.off ? `${d.name} is on.` : `${d.name} is off. It won't appear in Study all.`); };
function whenText(t) { const ms = t - Date.now(); if (ms <= 0) return 'now'; if (ms < 3600000) return 'in ' + Math.ceil(ms / 60000) + ' min'; if (t < nextDayStart()) return 'in ' + Math.max(1, Math.round(ms / 3600000)) + ' h';
  const d = Math.max(1, Math.round(ms / 86400000)); if (d < 60) return `in ${d} day${d === 1 ? '' : 's'}`; const mo = Math.round(d / 30.4); return `in ${mo} months`; }
A.quickAdd = () => { const v = document.getElementById('qa').value; if (v.trim()) A.openAdd({ word: v }); };

// ───────── Study ─────────
A.study = (deckId = null, extraNew = 0) => {
  const q = queueFor(deckId, extraNew);
  UI.session = { deckId, learning: q.learning.map(x => x.card.id), reviews: q.reviews.map(x => x.card.id), newCards: q.newCards.map(x => x.card.id),
    started: Date.now(), reviewed: 0, learned: 0, undo: [], current: null };
  nextCard(); go('study');
};
function infoOf(id) { const it = model().byId.get(id); return it ? it.info : { due: Infinity }; }
function nextCard() {
  const s = UI.session; const m = model();
  for (const k of ['learning', 'reviews', 'newCards']) s[k] = s[k].filter(id => { const it = m.byId.get(id); return it && !it.card.suspended; });
  const id = pickNext(s, infoOf);
  if (!id) { s.current = null; return; }
  const it = m.byId.get(id);
  s.current = id; s.revealed = false; s.answered = null; s.typed = ''; s.pre = null; s.learnStage = 0;
  s.mode = it.info.isNew ? 'learn' : chooseMode(it);
  s.mcOptions = (s.mode === 'mc' || s.mode === 'learn') ? mcOptions(it) : null;
  if (s.mode === 'learn' && !s.mcOptions) s.learnFallback = true; else s.learnFallback = false;
}
function mcOptions(it) {
  const m = model(); const c = it.card;
  const pool = m.items.filter(x => x.card.id !== c.id && canon(x.card.word) !== canon(c.word) && x.card.explanation && !similar(x.card.explanation, c.explanation));
  if (pool.length < 3) return null;
  const same = pool.filter(x => x.card.deckId === c.deckId), other = pool.filter(x => x.card.deckId !== c.deckId);
  const shuffle = a => a.map(v => [Math.random(), v]).sort((a, b) => a[0] - b[0]).map(v => v[1]);
  const picks = []; const seen = new Set([norm(c.explanation)]);
  for (const x of [...shuffle(same), ...shuffle(other)]) { const k = norm(x.card.explanation); if (!seen.has(k)) { seen.add(k); picks.push(x.card.explanation); } if (picks.length === 3) break; }
  if (picks.length < 3) return null;
  return shuffle([c.explanation, ...picks]);
}
function chooseMode(it) {
  const st = model().st; const c = it.card;
  const ok = { flashcard: true, reverse: !!c.explanation, typing: !!c.explanation, mc: !!c.explanation && !!mcOptions(it), cloze: containsWord(c.example, c.word) };
  const enabled = Object.keys(st.modes).filter(k => st.modes[k] && ok[k]);
  return enabled.length ? enabled[Math.floor(Math.random() * enabled.length)] : 'flashcard';
}
function studyLeft() {
  const s = UI.session; const m = model(); const all = [...new Set([...s.learning, ...s.reviews, ...s.newCards])];
  let n = 0, l = 0, r = 0; for (const id of all) { const i = m.byId.get(id)?.info; if (!i) continue; if (i.isNew) n++; else if (i.learning) l++; else r++; }
  return `<div class="left"><b>${n + l + r} left</b><span><span class="dot" style="background:var(--newc)"></span>${n} new</span><span><span class="dot" style="background:var(--hard)"></span>${l} learning</span><span><span class="dot" style="background:var(--easy)"></span>${r} review</span></div>`;
}
V.study = () => {
  const s = UI.session; if (!s || !s.current) return V.done();
  const it = model().byId.get(s.current); if (!it) { nextCard(); return V.study(); }
  const c = it.card; let body = '', actions = '';
  const reveal = `<button class="btn" onclick="A.reveal()">Show answer <span class="small">(Space)</span></button>`;
  const ex = c.example ? `<div class="ex">“${esc(c.example)}”</div>` : '';
  const ipa = c.ipa ? `<div class="ipa">${esc(c.ipa)}</div>` : '';
  const say = speakBtn(c.word + (c.example ? '. ' + c.example : ''), deckLang(c.deckId));
  if (s.mode === 'learn') {
    if (s.learnStage === 0) { body = `<div class="mode">New word · Learn</div><div class="w">${esc(c.word)}</div>${ipa}${say}<div>${esc(c.explanation || '')}</div>${ex}`; actions = `<button class="btn" data-autofocus onclick="A.learnCheck()">Got it, check me</button>`; }
    else if (s.learnFallback) { body = `<div class="mode">Quick check · recall the meaning</div><div class="w">${esc(c.word)}</div>` + (s.revealed ? `<div>${esc(c.explanation || '')}</div>${ex}` : ''); actions = s.revealed ? rateRow(it) : reveal; }
    else { body = mcHtml(c, 'Quick check'); actions = s.answered ? `<p class="small muted center">${s.pre === 'good' ? 'Correct. You will see it again in about 10 minutes.' : 'Not quite. You will see this word again in a minute.'}</p><button class="btn" data-autofocus onclick="A.rate('${s.pre}')">Continue</button>` : ''; }
  } else if (s.mode === 'flashcard') {
    body = `<div class="mode">Flashcard · recall the meaning</div><div class="w">${esc(c.word)}</div>${ipa}${say}` + (s.revealed ? `<hr style="border:0;border-top:1px solid var(--line);width:100%"><div>${esc(c.explanation || '')}</div>${ex}` : '');
    actions = s.revealed ? rateRow(it) : reveal;
  } else if (s.mode === 'reverse') {
    body = `<div class="mode">Reverse · recall the word</div><div style="font-size:18px">${esc(c.explanation)}</div>` + (s.revealed ? `<hr style="border:0;border-top:1px solid var(--line);width:100%"><div class="w">${esc(c.word)}</div>${ipa}${say}${ex}` : '');
    actions = s.revealed ? rateRow(it) : reveal;
  } else if (s.mode === 'typing') {
    body = `<div class="mode">Typing · type the word</div><div style="font-size:18px">${esc(c.explanation)}</div>` + (s.answered
      ? `<div class="diff" aria-label="Your answer compared with the correct one">${diff(s.typed, c.word).map(d => d.t === 'same' ? esc(d.c) : d.t === 'missing' ? `<ins>${esc(d.c)}</ins>` : `<del>${esc(d.c)}</del>`).join('')}</div>
         <div class="small muted">Correct: <b>${esc(c.word)}</b> ${esc(c.ipa || '')}</div>${s.pre !== 'good' ? `<div class="small muted"><del style="color:var(--again)">red</del> = extra letter · <ins style="color:var(--good)">green</ins> = missing letter</div>` : ''}${say}`
      : `<form onsubmit="event.preventDefault();A.checkTyped()"><input id="ty" data-autofocus placeholder="Type the word" autocomplete="off" autocorrect="off" autocapitalize="none" spellcheck="false" style="text-align:center;font-size:18px" value="${esc(s.typed)}" oninput="UI_typed(this.value)"></form>`);
    actions = s.answered ? rateRow(it) : `<button class="btn" onclick="A.checkTyped()">Check <span class="small">(Enter)</span></button>`;
  } else if (s.mode === 'mc') {
    body = mcHtml(c, 'Multiple choice · pick the meaning'); actions = s.answered ? rateRow(it) : '';
  } else if (s.mode === 'cloze') {
    const parts = clozeSplit(c.example, c.word) || [c.example, '', ''];
    body = `<div class="mode">Cloze · fill the gap</div><div class="ex" style="font-size:19px">“${esc(parts[0])}${s.revealed ? `<span class="hl" style="font-style:normal;font-weight:700">${esc(parts[1])}</span>` : '<span class="hl">_____</span>'}${esc(parts[2])}”</div>
      <div class="small muted">Hint: ${esc(c.explanation)}</div>${s.revealed ? say : ''}`;
    actions = s.revealed ? rateRow(it) : reveal;
  }
  return `<div class="top"><button class="btn ghost sm" onclick="A.endStudy()">✕ Close</button>${syncPill()}<button class="btn ghost sm" ${s.undo.length ? '' : 'disabled'} onclick="A.undo()">↶ Undo</button></div>
  <div class="scroll">${studyLeft()}<div class="card" data-notr-content><div class="inner">${body}</div></div>${actions}</div>`;
};
window.UI_typed = v => { if (UI.session) UI.session.typed = v; };
function mcHtml(c, title) {
  const s = UI.session;
  return `<div class="mode">${title}</div><div class="w">${esc(c.word)}</div><div class="opts">${(s.mcOptions || []).map((o, i) =>
    `<button class="opt ${s.answered ? (o === c.explanation ? 'right' : (s.answered === o ? 'wrong' : '')) : ''}" onclick="A.pickMC(${i})">${esc(o)}</button>`).join('')}</div>`;
}
function rateRow(it) {
  const s = UI.session; const iv = previewIntervals(model().f, it.fc);
  return `${s.pre ? `<p class="small muted center">Suggested rating is outlined. You can change it.</p>` : ''}<div class="rate">${[['again', 'a', 'Again'], ['hard', 'h', 'Hard'], ['good', 'g', 'Good'], ['easy', 'e', 'Easy']].map(([k, cls, n], i) =>
    `<button class="${cls} ${s.pre === k ? 'pre' : ''}" onclick="A.rate('${k}')" aria-label="${n}, next in ${iv[k]} (key ${i + 1})">${n}<small>${iv[k]}</small></button>`).join('')}</div>`;
}
A.reveal = () => { UI.session.revealed = true; render(); };
A.learnCheck = () => { UI.session.learnStage = 1; render(); };
A.pickMC = i => { const s = UI.session; if (s.answered) return; const c = model().byId.get(s.current).card; s.answered = s.mcOptions[i]; s.pre = s.answered === c.explanation ? 'good' : 'again'; render(); };
A.checkTyped = () => { const s = UI.session; const v = document.getElementById('ty')?.value ?? s.typed; s.typed = v; s.pre = gradeTyped(v, model().byId.get(s.current).card.word); s.answered = true; render(); };
A.rate = async name => {
  const s = UI.session; const id = s.current; if (!id) return;
  const before = model().byId.get(id);
  const rating = { again: 1, hard: 2, good: 3, easy: 4 }[name];
  const rev = { id: store.rid(), type: 'review', cardId: id, rating, time: Date.now(), mode: s.mode };
  s.undo.push({ reviewId: rev.id, lists: { learning: [...s.learning], reviews: [...s.reviews], newCards: [...s.newCards] }, reviewed: s.reviewed, learned: s.learned });
  if (s.undo.length > 20) s.undo.shift();
  await store.put(rev);
  const after = model().byId.get(id);
  s.reviewed++; if (before.info.isNew) s.learned++;
  s.learning = s.learning.filter(x => x !== id); s.reviews = s.reviews.filter(x => x !== id); s.newCards = s.newCards.filter(x => x !== id);
  if (after.info.learning && after.info.due < nextDayStart()) s.learning.push(id);
  if (rating === 1 && after.info.lapses === LEECH_LAPSES && !before.info.isNew) { nextCard(); toast(`“${after.card.word}” is now a leech. Edit it later to make it easier.`); return; }
  nextCard(); render();
};
A.undo = async () => {
  const s = UI.session; const u = s.undo.pop(); if (!u) return;
  const r = store.records.get(u.reviewId);
  if (r) await store.put({ ...r, deleted: true });
  Object.assign(s, u.lists, { reviewed: u.reviewed, learned: u.learned });
  const it = model().byId.get(r?.cardId);
  if (it) { s.current = it.card.id; s.revealed = false; s.answered = null; s.typed = ''; s.pre = null; s.learnStage = 0;
    s.mode = it.info.isNew ? 'learn' : chooseMode(it); s.mcOptions = (s.mode === 'mc' || s.mode === 'learn') ? mcOptions(it) : null; s.learnFallback = s.mode === 'learn' && !s.mcOptions; }
  render();
};
A.endStudy = () => { UI.session = null; M = null; go('home'); };
V.done = () => {
  const s = UI.session || { reviewed: 0, learned: 0, started: Date.now() };
  const m = model(); const p = progress(m.items, m.allReviews);
  const tomorrow = m.items.filter(x => !x.card.suspended && !x.info.isNew && x.info.due >= nextDayStart() && x.info.due < nextDayStart() + 86400000).length;
  const anyNew = m.items.some(x => x.info.isNew && !x.card.suspended && (!s.deckId || x.card.deckId === s.deckId));
  const mins = Math.max(1, Math.round((Date.now() - s.started) / 60000));
  return `<div class="top"><h2>Done for today</h2>${syncPill()}</div><div class="scroll center">
  <div class="logo" style="font-size:48px">✓</div><p>Nice work.${p.streak ? ` Come back tomorrow to keep your <b class="nowrap">${p.streak}-day streak</b>.` : ''}</p>
  <div class="stat-row"><div class="stat"><b>${s.reviewed}</b><span>reviewed</span></div><div class="stat"><b>${s.learned}</b><span>new learned</span></div><div class="stat"><b>${mins} min</b><span>time spent</span></div></div>
  <p class="small muted">Tomorrow: ${tomorrow} review${tomorrow === 1 ? '' : 's'} due.</p>
  <button class="btn" onclick="A.endStudy()">Back to home</button>${anyNew ? `<button class="btn ghost" onclick="A.study(UI_deck(),5)">Learn 5 extra new words</button>` : ''}</div>${tabs()}`;
};
window.UI_deck = () => (UI.session && UI.session.deckId) || null;

// ───────── Add panel ─────────
// Add panel: a 4-step wizard — 1 Word, 2 Meaning, 3 Example, 4 Details.
A.openAdd = (p = {}) => {
  const decks = model().decks;
  const last = ls.get('sr-lastDeck', ''); const deckId = p.deckId || (decks.find(d => d.id === last) ? last : decks[0]?.id) || '';
  const { word, cut } = cleanSelection(p.word || '', p.sentence || '');
  const sentence = (p.sentence || '').trim();
  UI.add = { step: word ? 2 : 1, word, cut, sentence, deckId, lang: deckId ? deckLang(deckId) : 'en', explanation: '', example: sentence, ipa: '', notes: '', tags: '', fillLater: true,
    lookup: null, examplesLoading: false, ipaLoading: false, mSel: [], examples: [], exSel: [], dup: null, from: p.from || '', newDeck: !decks.length, lookedUp: '' };
  UI.addErr = null;
  UI.addReturn = UI.screen === 'add' ? UI.addReturn : (['home', 'deck', 'decks'].includes(UI.screen) ? UI.screen : 'home');
  go('add');
  if (word) startLookup();
};
function findDup(word) { return store.all('card').find(c => canon(c.word) === canon(word) && store.get(c.deckId)) || null; }
// Several meanings → numbered lines; several examples → one per line.
const joinDefs = defs => defs.length === 1 ? defs[0] : defs.map((d, i) => `${i + 1}. ${d}`).join('\n');
function startLookup() {
  const a = UI.add; const w = a.word.trim().replace(/\s+/g, ' '); if (!w) return;
  a.lookedUp = w; a.dup = findDup(w); a.baseOffer = null;
  a.lookup = { status: 'loading', word: w }; a.examplesLoading = true; a.ipaLoading = true;
  a.mSel = []; a.exSel = []; a.explanation = ''; a.ipa = ''; a.example = a.sentence;
  a.examples = a.sentence ? [{ text: a.sentence, src: 'From the page you highlighted' }] : [];
  if (a.sentence) a.exSel = [0];
  render();
  const still = () => UI.screen === 'add' && UI.add === a && a.lookedUp === w;
  lookupWordIn(w, a.lang).then(async res => {
    if (!still()) return;
    a.lookup = res;
    if (res.status === 'ok') {
      if (res.base && res.word !== w.toLowerCase()) a.baseOffer = res.word;
      if (!a.explanation) { a.mSel = [0]; a.explanation = joinDefs([meaningText(res.meanings[0])]); }
      for (const m of res.meanings) if (m.example && a.examples.length < 6 && !a.examples.some(e => e.text === m.example)) a.examples.push({ text: m.example, src: 'Dictionary' });
      if (res.ipa && !a.ipa) { a.ipa = res.ipa; }
    }
    if (!a.exSel.length && a.examples.length && !a.example) { a.exSel = [0]; a.example = a.examples[0].text; }
    render();
    if (!a.ipa) { const ipa = await pronunciationIn(res.word || w, a.lang); if (still() && !a.ipa) a.ipa = ipa; }
    if (still()) { a.ipaLoading = false; render(); }
  });
  exampleSentencesIn(w, 4, a.lang).then(list => {
    if (!still()) return;
    for (const t of list) if (a.examples.length < 6 && !a.examples.some(e => e.text === t)) a.examples.push({ text: t, src: 'Tatoeba sentence library' });
    if (!a.exSel.length && a.examples.length && !a.example) { a.exSel = [0]; a.example = a.examples[0].text; }
    a.examplesLoading = false; render();
  });
}
window.UI_add = (k, v) => { if (UI.add) UI.add[k] = v; };
A.addNext = () => {
  const a = UI.add; UI.addErr = null;
  if (a.step === 1) {
    a.word = (document.getElementById('aw')?.value ?? a.word).trim().replace(/\s+/g, ' ');
    if (!a.word) { UI.addErr = 'Type a word or phrase.'; return render(); }
    a.step = 2;
    if (a.word !== a.lookedUp) startLookup(); else render();
    return;
  }
  if (a.step < 4) { a.step++; render(); const sc = $app.querySelector('.scroll'); if (sc) sc.scrollTop = 0; return; }
  A.saveAdd();
};
// Switching language moves the target deck to one in that language (or a new deck).
A.setAddLang = lang => { const a = UI.add; a.lang = lang; const ds = model().decks.filter(d => (d.lang || 'en') === lang);
  if (!ds.some(d => d.id === a.deckId)) { a.deckId = ds[0]?.id || ''; a.newDeck = !ds.length; if (!ds.length) a.newDeckName = lang === 'fr' ? 'Mots français' : 'My words'; }
  a.lookedUp = ''; render(); };
A.addBack = () => { const a = UI.add; UI.addErr = null; if (a.step > 1) { a.step--; render(); } };
A.useBase = () => { const a = UI.add; a.word = a.baseOffer; a.baseOffer = null; startLookup(); };
A.typeMyself = () => { const a = UI.add; if (a.lookup?.status === 'loading') a.lookup = { status: 'skipped', word: a.lookedUp }; render(); document.getElementById('ae')?.focus(); };
const toggleIn = (arr, i) => arr.includes(i) ? arr.filter(x => x !== i) : [...arr, i].sort((x, y) => x - y);
const meaningText = m => (m.pos ? `(${m.pos}) ` : '') + m.def;
A.pickMeaning = i => { const a = UI.add; a.mSel = toggleIn(a.mSel, i); a.explanation = a.mSel.length ? joinDefs(a.mSel.map(k => meaningText(a.lookup.meanings[k]))) : ''; render(); };
A.allMeanings = () => { const a = UI.add; const n = a.lookup.meanings.length; a.mSel = a.mSel.length === n ? [] : [...Array(n).keys()]; a.explanation = a.mSel.length ? joinDefs(a.mSel.map(k => meaningText(a.lookup.meanings[k]))) : ''; render(); };
A.allExamples = () => { const a = UI.add; const n = a.examples.length; a.exSel = a.exSel.length === n ? [] : [...Array(n).keys()]; a.example = a.exSel.map(k => a.examples[k].text).join('\n'); render(); };
A.pickExample = i => { const a = UI.add; a.exSel = toggleIn(a.exSel, i); a.example = a.exSel.map(k => a.examples[k].text).join('\n'); render(); };
A.retryLookup = () => startLookup();
const spinner = text => `<div class="loading"><span class="spinner" aria-hidden="true"></span><span>${esc(text)}</span></div>`;
V.add = () => {
  const a = UI.add; const decks = model().decks.filter(d => (d.lang || 'en') === a.lang); const L = a.lookup || {}; const st = L.status;
  const names = ['Word', 'Meaning', 'Example', 'Details'];
  const steps = `<div class="steps" aria-label="Step ${a.step} of 4">${names.map((n, i) => `<span class="${i + 1 === a.step ? 'on' : i + 1 < a.step ? 'done' : ''}">${i + 1}. ${n}</span>`).join('')}</div>`;
  const wordLine = a.step > 1 ? `<div class="wordline" data-notr><span class="w">${esc(a.word)}</span>${a.ipa ? `<span class="muted">${esc(a.ipa)}</span>` : ''}</div>` : '';
  let body = '';
  if (a.step === 1) {
    body = `<div class="toggle" style="border:0;padding:0"><span>Language</span><div class="seg">${[['en', 'English'], ['fr', 'French']].map(([v, n]) => `<button class="${a.lang === v ? 'on' : ''}" onclick="A.setAddLang('${v}')">${n}</button>`).join('')}</div></div>
      <div class="field"><label for="aw">Word or phrase</label><input id="aw" value="${esc(a.word)}" maxlength="60" autocapitalize="none" autocomplete="off" data-autofocus
      oninput="UI_add('word',this.value);document.getElementById('anext').disabled=!this.value.trim()" onkeydown="if(event.key==='Enter'){event.preventDefault();A.addNext()}">
      ${a.cut ? '<span class="hint">The highlighted text was long, so it was shortened to 60 characters.</span>' : '<span class="hint">Then tap Next to look it up.</span>'}</div>`;
  } else if (a.step === 2) {
    let list = '';
    if (st === 'loading') list = `${spinner(`Looking up “${L.word}”…`)}<button class="link" onclick="A.typeMyself()">Don't wait, I'll type it myself</button>`;
    else if (st === 'offline') list = `<div class="warn"><b>Offline.</b> Type the explanation yourself. The card saves now and syncs later.</div>`;
    else if (st === 'slow' || st === 'error') list = `<div class="warn"><b>Connection is slow.</b> Type the explanation yourself, or <button class="link" onclick="A.retryLookup()">try again</button>.</div>`;
    else if (st === 'notfound') list = `<div class="warn"><b>No dictionary entry for “${esc(L.word)}”.</b> Phrases and idioms are often missing. Type the explanation yourself.</div>`;
    else if (st === 'ok') list = `<div><div class="listhead"><label>Dictionary meanings (tick one or more)</label>${L.meanings.length > 1 ? `<button class="link" onclick="A.allMeanings()">${a.mSel.length === L.meanings.length ? 'Clear all' : 'Select all'}</button>` : ''}</div><div class="opts">${L.meanings.map((m, i) => `<button class="meaning check ${a.mSel.includes(i) ? 'on' : ''}" role="checkbox" aria-checked="${a.mSel.includes(i)}" onclick="A.pickMeaning(${i})"><span class="box">${a.mSel.includes(i) ? '✓' : ''}</span><span data-notr>${esc(meaningText(m))}</span></button>`).join('')}</div></div>`;
    body = `${a.dup ? `<div class="warn"><b>“${esc(a.dup.word)}”</b> is already in ${esc(deckName(a.dup.deckId))}: <i>“${esc(a.dup.explanation || 'no explanation')}”</i>. You can still add it, for example for a different meaning.</div>` : ''}
      ${a.baseOffer ? `<div class="warn">The dictionary lists this under <b>“${esc(a.baseOffer)}”</b>. <button class="link" onclick="A.useBase()">Use “${esc(a.baseOffer)}” instead</button></div>` : ''}
      ${list}
      ${st === 'loading' ? '' : `<div class="field"><label for="ae">${a.lang === 'fr' ? 'French explanation' : 'English explanation'}</label><textarea id="ae" rows="3" placeholder="${a.lang === 'fr' ? 'A short explanation in French' : 'A short explanation in English'}" oninput="UI_add('explanation',this.value)">${esc(a.explanation)}</textarea></div>`}`;
  } else if (a.step === 3) {
    body = `${a.examples.length ? `<div><div class="listhead"><label>Suggested examples (tick one or more)</label>${a.examples.length > 1 ? `<button class="link" onclick="A.allExamples()">${a.exSel.length === a.examples.length ? 'Clear all' : 'Select all'}</button>` : ''}</div><div class="opts">${a.examples.map((e, i) => `<button class="meaning check ${a.exSel.includes(i) ? 'on' : ''}" role="checkbox" aria-checked="${a.exSel.includes(i)}" onclick="A.pickExample(${i})"><span class="box">${a.exSel.includes(i) ? '✓' : ''}</span><span><span data-notr>${esc(e.text)}</span><br><span class="small muted">${esc(e.src)}</span></span></button>`).join('')}</div></div>` : ''}
      ${a.examplesLoading ? spinner('Finding example sentences…') : (!a.examples.length ? `<p class="muted">${navigator.onLine ? 'No example sentences found.' : 'Offline.'} Write your own below.</p>` : '')}
      <div class="field"><label for="ax">Example sentence</label><textarea id="ax" rows="3" placeholder="An example sentence using the word" oninput="UI_add('example',this.value)">${esc(a.example)}</textarea></div>`;
  } else {
    const empty = !a.explanation.trim() || !a.example.trim();
    body = `<div class="field"><label for="ai">Pronunciation (IPA)</label><input id="ai" value="${esc(a.ipa)}" placeholder="${a.ipaLoading ? 'Looking up…' : 'Not found — you can type it'}" oninput="UI_add('ipa',this.value)">${a.ipaLoading ? spinner('Looking up pronunciation…') : ''}</div>
      <div class="field"><label for="ad">Deck</label>${decks.length && !a.newDeck ? `<select id="ad" onchange="if(this.value==='__new'){UI_add('newDeck',true);A.rerender()}else UI_add('deckId',this.value)">${decks.map(d => `<option value="${d.id}" ${d.id === a.deckId ? 'selected' : ''}>${esc(d.name)}</option>`).join('')}<option value="__new">+ New deck…</option></select>`
        : `<input id="adn" placeholder="New deck name" value="${esc(a.newDeckName || 'My words')}" oninput="UI_add('newDeckName',this.value)">`}</div>
      <div class="field"><label for="an">Notes (optional)</label><input id="an" value="${esc(a.notes)}" oninput="UI_add('notes',this.value)"></div>
      <div class="field"><label for="ag">Tags (optional, separate with commas)</label><input id="ag" value="${esc(a.tags)}" placeholder="e.g. email, meetings" oninput="UI_add('tags',this.value)"></div>
      ${empty ? `<label style="display:flex;gap:8px;align-items:center;font-weight:500;color:var(--ink);margin:0"><input type="checkbox" ${a.fillLater ? 'checked' : ''} onchange="UI_add('fillLater',this.checked)">The ${!a.explanation.trim() ? 'explanation' : 'example'} is empty — mark “Fill later”</label>` : ''}`;
  }
  return `<div class="top"><h2>Add a word</h2><button class="btn ghost sm" onclick="A.cancelAdd()">Cancel</button></div>
  <div class="scroll">${steps}${wordLine}${body}${UI.addErr ? `<div class="err">${esc(UI.addErr)}</div>` : ''}</div>
  <div class="foot">${a.step > 1 ? `<button class="btn ghost" onclick="A.addBack()">Back</button>` : ''}<span class="spacer"></span>
   <button class="btn" id="anext" ${a.step === 1 && !a.word.trim() ? 'disabled' : ''} onclick="A.addNext()">${a.step === 4 ? 'Save' : 'Next'}</button></div>`;
};
A.rerender = () => render();
A.cancelAdd = () => { if (UI.add?.from === 'ext') { try { window.close(); } catch {} } go(UI.addReturn || 'home'); };
A.saveAdd = async () => {
  const a = UI.add; UI.addErr = null;
  const word = a.word.trim().replace(/\s+/g, ' ');
  if (!word) { a.step = 1; UI.addErr = 'Type a word or phrase.'; return render(); }
  const emptyDetails = !a.explanation.trim() || !a.example.trim();
  if (!a.explanation.trim() && !a.fillLater) { UI.addErr = 'Add an English explanation (step 2), or tick “Fill later”.'; return render(); }
  let deckId = a.deckId;
  if (a.newDeck || !deckId) {
    const name = (a.newDeckName || 'My words').trim() || 'My words';
    const now = Date.now(); const deck = { id: store.rid(), type: 'deck', name, lang: a.lang || 'en', createdAt: now, order: now };
    await store.put(deck); deckId = deck.id;
  }
  ls.set('sr-lastDeck', deckId);
  const now = Date.now();
  await store.put({ id: store.rid(), type: 'card', deckId, word, explanation: a.explanation.trim(), example: a.example.trim(), ipa: a.ipa.trim(), notes: a.notes.trim(),
    tags: a.tags.split(',').map(t => t.trim()).filter(Boolean), fillLater: emptyDetails && a.fillLater, createdAt: now, order: now });
  if (a.from === 'ext') { UI.screen = 'saved'; render(); setTimeout(() => { try { window.close(); } catch {} }, 1200); return; }
  const back = UI.addReturn || 'home'; UI.add = null; go(back); toast(`Saved to ${deckName(deckId)}.`);
};
V.saved = () => `<div class="scroll" style="justify-content:center;text-align:center"><div class="logo">✓</div><p>Saved. You can close this window.</p></div>`;

// ───────── Import ─────────
A.openImport = (deckId) => { UI.importReturn = UI.screen; UI.imp = { text: '', sep: '\t', header: false, deckId: deckId || model().decks[0]?.id || '__new', newName: 'Imported words', file: '' }; go('import'); };
function importRows() {
  const i = UI.imp; let rows = parseDelimited(i.text, i.sep);
  if (i.header && rows.length) rows = rows.slice(1);
  const existing = new Set(store.all('card').filter(c => c.deckId === i.deckId).map(c => canon(c.word)));
  const seen = new Set();
  return rows.map(r => {
    const word = (r[0] || '').trim(), explanation = (r[1] || '').trim(), example = (r[2] || '').trim(), ipa = (r[3] || '').trim();
    let status = 'new';
    if (!word) status = 'empty'; else if (word.length > 60) status = 'long'; else if (existing.has(canon(word))) status = 'exists'; else if (seen.has(canon(word))) status = 'repeat';
    if (word) seen.add(canon(word));
    return { word, explanation, example, ipa, status };
  });
}
V.import = () => {
  const i = UI.imp; const decks = model().decks; const rows = importRows(); const ok = rows.filter(r => r.status === 'new');
  const label = { new: ['New', ''], exists: ['Skip: already in deck', 'leech'], repeat: ['Skip: duplicate line', 'leech'], empty: ['Skip: no word', 'leech'], long: ['Skip: word too long', 'leech'] };
  return `<div class="top"><h2>Import cards</h2><button class="btn ghost sm" onclick="A.go(UI_impBack())">Cancel</button></div><div class="scroll">
  <div class="field"><label for="ipf">CSV or text file (optional)</label><input id="ipf" type="file" accept=".csv,.txt,.tsv,text/csv,text/plain" onchange="A.importFile(this.files[0])">${i.file ? `<span class="hint">Loaded ${esc(i.file)}</span>` : ''}</div>
  <div class="field"><label for="ip">Or paste: one card per line — word, explanation, example, pronunciation (optional)</label><textarea id="ip" style="min-height:120px;font-family:ui-monospace,monospace;font-size:13px" placeholder="agenda&#9;a list of things to discuss&#9;Let's stick to the agenda." oninput="UI_imp('text',this.value)">${esc(i.text)}</textarea></div>
  <div><label>Separator</label><div class="chips">${[['\t', 'Tab'], [',', 'Comma'], [';', 'Semicolon']].map(([s, n]) => `<button class="chip ${i.sep === s ? 'on' : ''}" onclick="UI_imp('sep',${JSON.stringify(s).replace(/"/g, '&quot;')});A.rerender()">${n}</button>`).join('')}</div></div>
  <label style="display:flex;gap:8px;align-items:center;font-weight:500;color:var(--ink);margin:0"><input type="checkbox" ${i.header ? 'checked' : ''} onchange="UI_imp('header',this.checked);A.rerender()">First line is a header</label>
  <div class="field"><label for="ipd">Into deck</label><select id="ipd" onchange="UI_imp('deckId',this.value);A.rerender()">${decks.map(d => `<option value="${d.id}" ${d.id === i.deckId ? 'selected' : ''}>${esc(d.name)}</option>`).join('')}<option value="__new" ${i.deckId === '__new' ? 'selected' : ''}>+ New deck</option></select></div>
  ${i.deckId === '__new' ? `<div class="field"><label for="ipn">New deck name</label><input id="ipn" value="${esc(i.newName)}" oninput="UI_imp('newName',this.value)"></div>` : ''}
  <button class="btn ghost" onclick="A.rerender()">Update preview</button>
  ${rows.length ? `<div><label>Preview (${rows.length} line${rows.length > 1 ? 's' : ''})</label><div class="list">${rows.slice(0, 50).map(r => `<div class="row" style="cursor:default"><div><b>${esc(r.word || '—')}</b><span class="sub">${esc(r.explanation || 'no explanation')}</span></div><span class="tag ${label[r.status][1]}">${label[r.status][0]}</span></div>`).join('')}</div>${rows.length > 50 ? `<p class="small muted">…and ${rows.length - 50} more lines.</p>` : ''}</div>` : ''}
  </div><div class="foot"><button class="btn" style="flex:1" ${ok.length ? '' : 'disabled'} onclick="A.doImport()">Import ${ok.length} card${ok.length === 1 ? '' : 's'}</button></div>`;
};
window.UI_imp = (k, v) => { UI.imp[k] = v; };
window.UI_impBack = () => UI.importReturn && UI.importReturn !== 'import' ? UI.importReturn : 'decks';
A.importFile = async file => {
  if (!file) return;
  const buf = await file.arrayBuffer();
  let text = new TextDecoder('utf-8').decode(buf);
  if (text.includes('�')) text = new TextDecoder('windows-1252').decode(buf);
  const first = text.split(/\r?\n/)[0] || '';
  const sep = first.includes('\t') ? '\t' : (first.split(';').length > first.split(',').length ? ';' : ',');
  Object.assign(UI.imp, { text, sep, file: file.name, header: /^(word|term|front)\b/i.test(first) });
  render();
};
A.doImport = async () => {
  const i = UI.imp; const rows = importRows().filter(r => r.status === 'new'); if (!rows.length) return;
  let deckId = i.deckId; const now = Date.now();
  if (deckId === '__new') { const deck = { id: store.rid(), type: 'deck', name: (i.newName || 'Imported words').trim(), createdAt: now, order: now }; await store.put(deck); deckId = deck.id; }
  const cards = rows.map((r, k) => ({ id: store.rid(), type: 'card', deckId, word: r.word, explanation: r.explanation, example: r.example, ipa: r.ipa || '', notes: '', tags: [],
    fillLater: !r.explanation || !r.example, createdAt: now + k, order: now + k }));
  for (let k = 0; k < cards.length; k += 500) await store.put(...cards.slice(k, k + 500));
  UI.imp = null; A.openDeck(deckId); toast(`Imported ${cards.length} card${cards.length === 1 ? '' : 's'}.`);
};

// ───────── Decks, deck, card ─────────
V.decks = () => {
  const m = model();
  return `<div class="top"><h2>Decks</h2>${syncPill()}</div><div class="scroll">
  ${m.decks.length ? `<div class="list">${m.decks.map(d => { const s = deckStats(d.id); return `<div class="row deckrow ${d.off ? 'is-off' : ''}"><button class="rowmain" onclick="A.openDeck('${d.id}')"><b data-notr>${esc(d.name)}</b><span class="sub">${d.lang === 'fr' ? 'French · ' : ''}${s.total} card${s.total === 1 ? '' : 's'} · ${d.off ? 'off' : `${s.due} due`}</span></button>${switchHtml(d)}</div>`; }).join('')}</div><p class="small muted">Switch a deck off to leave it out of Study all. Its progress is kept.</p>`
    : `<div class="empty"><h3 style="margin:0">No decks yet</h3><p class="muted">Create a deck, or add the starter decks.</p><button class="btn ghost" onclick="A.go('firstrun')">Add starter decks</button></div>`}
  <button class="btn ghost" onclick="A.newDeck()">+ New deck</button>
  <button class="btn ghost" onclick="A.openImport()">Import a list</button></div>${tabs()}`;
};
A.newDeck = () => modal({ title: 'New deck', html: `<input id="modalin" placeholder="Deck name, e.g. Kids' school words" maxlength="40" data-autofocus><label for="modallang" style="margin-top:4px">Language of the words</label><select id="modallang"><option value="en">English</option><option value="fr">French</option></select>`, ok: 'Create',
  onOk: async v => { const name = (v || '').trim(); if (!name) return render(); const lang = UI.modalLang || 'en'; const now = Date.now(); const d = { id: store.rid(), type: 'deck', name, lang, createdAt: now, order: now }; await store.put(d); A.openDeck(d.id); } });
A.openDeck = (deckId, filter = 'All') => { UI.deckId = deckId; UI.filter = filter; UI.search = ''; go('deck'); };
const FILTERS = ['All', 'New', 'Learning', 'Review', 'Mastered', 'Leeches', 'Suspended', 'Fill later'];
function matchFilter(x, f) {
  if (f === 'All') return true; if (f === 'Suspended') return !!x.card.suspended; if (f === 'Fill later') return !!x.card.fillLater;
  if (f === 'Leeches') return x.info.lapses >= LEECH_LAPSES; if (x.card.suspended) return false; return x.info.stateName === f;
}
V.deck = () => {
  const m = model(); const deck = UI.deckId ? store.get(UI.deckId) : null;
  if (UI.deckId && !deck) return V.decks();
  const cards = m.items.filter(x => !UI.deckId || x.card.deckId === UI.deckId);
  const counts = Object.fromEntries(FILTERS.map(f => [f, cards.filter(x => matchFilter(x, f)).length]));
  const q = canon(UI.search || '');
  const rows = cards.filter(x => matchFilter(x, UI.filter)).filter(x => !q || canon(x.card.word + ' ' + x.card.explanation + ' ' + (x.card.example || '') + ' ' + (x.card.tags || []).join(' ')).includes(q))
    .sort((a, b) => a.card.word.localeCompare(b.card.word));
  const s = deck ? deckStats(deck.id) : null;
  return `<div class="top"><button class="btn ghost sm" onclick="A.go('decks')" aria-label="Back to decks">‹</button><h2 class="spacer" ${deck ? 'data-notr' : ''}>${esc(deck ? deck.name : 'All decks')}</h2><button class="btn ghost sm" onclick="A.openAdd({deckId:'${deck ? deck.id : ''}'})">+ Add</button></div><div class="scroll">
  ${!cards.length ? `<div class="empty"><div class="big">Aa</div><h3 style="margin:0">No cards yet</h3><p class="muted">Add words here, highlight them on web pages, or import a list.</p><button class="btn" onclick="A.openAdd({deckId:'${deck ? deck.id : ''}'})">Add a word</button><button class="btn ghost" onclick="A.openImport('${deck ? deck.id : ''}')">Import a list</button></div>` : `
  ${s && s.due + s.newCount ? `<button class="btn" onclick="A.study('${deck.id}')">Study this deck · ${s.due} due, ${s.newCount} new</button>` : ''}
  <input id="srch" placeholder="Search word, explanation, tag" value="${esc(UI.search || '')}" oninput="UI.search=this.value;A.rerender()" aria-label="Search cards">
  <div class="chips">${FILTERS.filter(f => f === 'All' || counts[f]).map(f => `<button class="chip ${UI.filter === f ? 'on' : ''}" onclick="UI_filter('${f}')">${f} ${counts[f]}</button>`).join('')}</div>
  ${rows.length ? `<div class="list">${rows.slice(0, 300).map(x => { const t = x.card.suspended ? ['Suspended', ''] : x.info.lapses >= LEECH_LAPSES ? ['Leech', 'leech'] : x.card.fillLater ? ['Fill later', 'fill'] : x.info.mastered ? ['Mastered', ''] : null;
      return `<button class="row" onclick="A.openCard('${x.card.id}')"><div><b data-notr>${esc(x.card.word)}</b><span class="sub">${esc(cardSub(x))}</span></div>${t ? `<span class="tag ${t[1]}">${t[0]}</span>` : ''}</button>`; }).join('')}</div>${rows.length > 300 ? `<p class="small muted">Showing 300 of ${rows.length}. Search to narrow down.</p>` : ''}`
    : `<div class="empty"><h3 style="margin:0">No cards match</h3><p class="muted">Try another word, or add it as a new card.</p><button class="btn ghost" onclick="A.openAdd({word:UI.search||'',deckId:'${deck ? deck.id : ''}'})">Add it</button></div>`}`}
  ${deck ? `<div class="toggle"><span>Include in Study all</span>${switchHtml(deck)}</div>
  <div class="toggle"><span>Language of the words</span><div class="seg">${[['en', 'English'], ['fr', 'French']].map(([v, n]) => `<button class="${(deck.lang || 'en') === v ? 'on' : ''}" onclick="A.setDeckLang('${deck.id}','${v}')">${n}</button>`).join('')}</div></div>
  <div class="chips"><button class="chip" onclick="A.openImport('${deck.id}')">Import</button><button class="chip" onclick="A.renameDeck('${deck.id}')">Rename deck</button><button class="chip danger" onclick="A.deleteDeck('${deck.id}')">Delete deck</button></div>` : ''}
  </div>${tabs()}`;
};
window.UI = new Proxy({}, { get: (_, k) => UI[k], set: (_, k, v) => { UI[k] = v; return true; } });
window.UI_filter = f => { UI.filter = f; render(); };
function cardSub(x) {
  if (x.card.suspended) return 'Suspended';
  if (x.info.isNew) return 'New';
  if (x.card.fillLater) return 'Needs details';
  const when = x.info.due <= Date.now() ? 'due now' : 'next ' + whenText(x.info.due);
  return `${x.info.stateName} · ${when}${x.info.lapses >= LEECH_LAPSES ? ` · forgotten ${x.info.lapses} times` : ''}`;
}
A.setDeckLang = async (id, lang) => { const d = store.get(id); if (d) await store.put({ ...d, lang }); render(); };
A.renameDeck = id => modal({ title: 'Rename deck', html: `<input id="modalin" value="${esc(deckName(id))}" maxlength="40" data-autofocus>`, ok: 'Save',
  onOk: async v => { const name = (v || '').trim(); if (name) await store.put({ ...store.get(id), name }); render(); } });
A.deleteDeck = id => {
  const n = store.all('card').filter(c => c.deckId === id).length;
  modal({ title: `Delete “${deckName(id)}”?`, body: `Its ${n} card${n === 1 ? '' : 's'} and their progress will be deleted on all your devices. This cannot be undone.`, ok: 'Delete deck', danger: true,
    onOk: async () => { const cards = store.all('card').filter(c => c.deckId === id).map(c => ({ ...c, deleted: true })); await store.put({ ...store.get(id), deleted: true }, ...cards); go('decks'); toast('Deck deleted.'); } });
};
A.openCard = id => { const c = store.get(id); if (!c) return; UI.cardId = id; UI.edit = { ...c, tagsText: (c.tags || []).join(', ') }; UI.cardMsg = null; go('card'); };
V.card = () => {
  const it = model().byId.get(UI.cardId); if (!it) return V.deck();
  const e = UI.edit; const decks = model().decks; const leech = it.info.lapses >= LEECH_LAPSES;
  const reviews = it.log.length;
  return `<div class="top"><button class="btn ghost sm" onclick="A.go('deck')" aria-label="Back to deck">‹</button><h2 class="spacer" data-notr>${esc(it.card.word)}</h2>${speakBtn(it.card.word, deckLang(it.card.deckId))}</div><div class="scroll">
  ${leech ? `<div class="err"><b>Leech:</b> you've forgotten this card ${it.info.lapses} times. Try a clearer explanation or a personal example, or suspend it for now.</div>` : ''}
  ${it.card.suspended ? `<div class="warn">This card is suspended. It won't appear in study sessions.</div>` : ''}
  ${e.fillLater ? `<div class="warn">This card needs details. ${navigator.onLine ? `<button class="link" onclick="A.cardAutofill()">Auto-fill from the dictionary</button>` : 'Connect to the internet to auto-fill.'}</div>` : ''}
  ${UI.cardMsg ? `<div class="ok">${esc(UI.cardMsg)}</div>` : ''}
  <div class="field"><label for="cw">Word or phrase</label><input id="cw" maxlength="60" value="${esc(e.word)}" oninput="UI_edit('word',this.value)"></div>
  <div class="field"><label for="ce">English explanation</label><textarea id="ce" oninput="UI_edit('explanation',this.value)">${esc(e.explanation || '')}</textarea></div>
  <div class="field"><label for="cx">Example sentence</label><textarea id="cx" oninput="UI_edit('example',this.value)">${esc(e.example || '')}</textarea></div>
  <div class="field"><label for="ci">Pronunciation (IPA)</label><input id="ci" value="${esc(e.ipa || '')}" oninput="UI_edit('ipa',this.value)"></div>
  <div class="field"><label for="cn">Notes</label><input id="cn" value="${esc(e.notes || '')}" oninput="UI_edit('notes',this.value)"></div>
  <div class="field"><label for="ct">Tags</label><input id="ct" value="${esc(e.tagsText || '')}" oninput="UI_edit('tagsText',this.value)"></div>
  <div class="field"><label for="cd">Deck</label><select id="cd" onchange="UI_edit('deckId',this.value)">${decks.map(d => `<option value="${d.id}" ${d.id === e.deckId ? 'selected' : ''}>${esc(d.name)}</option>`).join('')}</select></div>
  <p class="small muted">${it.info.stateName} · reviewed ${reviews} time${reviews === 1 ? '' : 's'} · forgotten ${it.info.lapses}${!it.info.isNew ? ' · next review ' + whenText(it.info.due) : ''}</p>
  <div class="chips"><button class="chip" onclick="A.suspend()">${it.card.suspended ? 'Unsuspend' : 'Suspend'}</button><button class="chip" onclick="A.resetCard()">Reset</button><button class="chip danger" onclick="A.deleteCard()">Delete</button></div></div>
  <div class="foot"><button class="btn" style="flex:1" onclick="A.saveCard()">Save changes</button></div>`;
};
window.UI_edit = (k, v) => { UI.edit[k] = v; };
A.saveCard = async () => {
  const e = UI.edit; const c = store.get(UI.cardId); if (!c) return go('deck');
  if (!e.word.trim()) { toast('The word cannot be empty.'); return; }
  const fillLater = !!c.fillLater && (!String(e.explanation || '').trim() || !String(e.example || '').trim());
  await store.put({ ...c, word: e.word.trim(), explanation: (e.explanation || '').trim(), example: (e.example || '').trim(), ipa: (e.ipa || '').trim(), notes: (e.notes || '').trim(),
    tags: (e.tagsText || '').split(',').map(t => t.trim()).filter(Boolean), deckId: e.deckId, fillLater });
  go('deck'); toast('Saved.');
};
A.cardAutofill = async () => {
  const e = UI.edit; UI.cardMsg = 'Looking up…'; render();
  const [res, sents] = await Promise.all([lookupWordIn(e.word, deckLang(e.deckId)), exampleSentencesIn(e.word, 1, deckLang(e.deckId))]);
  if (res.status === 'ok') {
    if (!String(e.explanation || '').trim()) e.explanation = res.meanings[0]?.def || '';
    if (!String(e.example || '').trim()) e.example = res.meanings.find(m => m.example)?.example || sents[0] || '';
    if (!String(e.ipa || '').trim()) e.ipa = res.ipa || await pronunciationIn(res.word || e.word, deckLang(e.deckId));
    UI.cardMsg = 'Filled from the dictionary. Check it, then tap Save changes.';
  } else UI.cardMsg = { notfound: 'No dictionary entry found. Type the details yourself.', offline: 'You are offline.', slow: 'Connection is slow. Try again later.' }[res.status] || 'Lookup failed. Try again later.';
  render();
};
A.suspend = async () => { const c = store.get(UI.cardId); await store.put({ ...c, suspended: !c.suspended }); render(); };
A.resetCard = () => modal({ title: `Reset “${store.get(UI.cardId).word}”?`, body: 'It goes back to New. Its content stays; its learning progress starts again.', ok: 'Reset card',
  onOk: async () => { await store.put({ id: store.rid(), type: 'review', cardId: UI.cardId, rating: 0, time: Date.now() }); toast('Card reset.'); } });
A.deleteCard = () => modal({ title: `Delete “${store.get(UI.cardId).word}”?`, body: 'The card and its review history will be deleted on all your devices.', ok: 'Delete card', danger: true,
  onOk: async () => { await store.put({ ...store.get(UI.cardId), deleted: true }); go('deck'); toast('Card deleted.'); } });

// ───────── Progress ─────────
V.progress = () => {
  const m = model(); const p = progress(m.items, m.allReviews); const total = Object.values(p.counts).reduce((a, b) => a + b, 0) || 1;
  const max = Math.max(1, ...p.forecast.map(f => f.n));
  const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const colors = { New: '--newc', Learning: '--hard', Review: '--easy', Mastered: '--good' };
  return `<div class="top"><h2>Progress</h2>${syncPill()}</div><div class="scroll">
  <div class="stat-row"><div class="stat"><b>${p.streak}</b><span>day streak</span></div><div class="stat"><b>${p.today}</b><span>reviews today</span></div><div class="stat"><b>${p.retention === null ? '–' : p.retention + '%'}</b><span>30-day retention</span></div></div>
  ${p.retention === null ? '<p class="small muted">Retention appears after your first reviews of learned cards.</p>' : ''}
  <div><label>Cards by state</label><div class="bar" style="height:14px">${Object.entries(p.counts).map(([k, n]) => `<i style="width:${n / total * 100}%;background:var(${colors[k]})"></i>`).join('')}</div>
  <div class="legend">${Object.entries(p.counts).map(([k, n]) => `<span><span class="dot" style="background:var(${colors[k]})"></span>${k} ${n}</span>`).join('')}</div></div>
  <div><label>Reviews due, next 7 days</label><div class="chart">${p.forecast.map((f, i) => `<div>${f.n}<i style="height:${f.n / max * 80}px"></i>${i === 0 ? 'Today' : days[new Date(f.t + 3600000 * 6).getDay()]}</div>`).join('')}</div></div>
  <p class="small muted">Mastered = next review 21 days or more away. A study day starts at 4:00.</p></div>${tabs()}`;
};

// ───────── Settings ─────────
V.settings = () => {
  const st = model().st; const u = auth.current()?.user || {}; const s = sync.status;
  return `<div class="top"><h2>Settings</h2>${syncPill()}</div><div class="scroll">
  <div class="toggle"><span><label for="snp" style="margin:0;color:var(--ink);font-size:14px;font-weight:400">New cards per day</label></span><input id="snp" type="number" inputmode="numeric" min="0" max="200" value="${st.newPerDay}" style="width:90px" onchange="A.setSetting('newPerDay',this.value,0,200)"></div>
  <div class="toggle"><span><label for="srp" style="margin:0;color:var(--ink);font-size:14px;font-weight:400">Reviews per day</label><span class="small muted">Most overdue first when there are more</span></span><input id="srp" type="number" inputmode="numeric" min="10" max="9999" value="${st.reviewsPerDay}" style="width:90px" onchange="A.setSetting('reviewsPerDay',this.value,10,9999)"></div>
  <div class="toggle"><span>Retention target<br><span class="small muted">Higher = more reviews</span></span><span style="display:flex;gap:8px;align-items:center"><input type="range" min="80" max="95" value="${st.retention}" aria-label="Retention target" oninput="this.nextElementSibling.textContent=this.value+'%'" onchange="A.setSetting('retention',this.value,80,95)" style="width:110px"><b>${st.retention}%</b></span></div>
  ${uiLang() !== 'fr' ? `<div class="toggle" style="border:0;padding-bottom:0"><b>English voice</b></div>
  <div class="toggle"><span>Voice accent</span><div class="seg">${['UK', 'US'].map(a => `<button class="${st.accent === a ? 'on' : ''}" onclick="ls_clearVoice();A.setSetting('accent','${a}')">${a}</button>`).join('')}</div></div>
  <div class="toggle"><span><label for="svoice" style="margin:0;color:var(--ink);font-size:14px;font-weight:400">Voice on this device</label><span class="small muted">Pick the one that sounds best</span></span>
   <span style="display:flex;gap:6px;align-items:center;min-width:0">${(() => { const list = englishVoices(st.accent === 'US' ? 'en-US' : 'en-GB'); const cur = chosenVoice();
     return list.length ? `<select id="svoice" style="max-width:170px" onchange="A.setVoice(this.value)" data-notr>${list.map(v => `<option value="${esc(v.name)}" ${cur && cur.name === v.name ? 'selected' : ''}>${esc(v.name.replace(/^Microsoft /, '').replace(/ - English.*$/, '').replace(/ Online \(Natural\)/, ' (Natural)'))} · ${esc(v.lang)}</option>`).join('')}</select>` : '<span class="small muted">No English voices found</span>'; })()}
   <button class="speak" aria-label="Test voice" onclick="A.speak('Hello! This is how SR App will read your words.')">${ICON.speak}</button></span></div>` : ''}
  ${uiLang() === 'fr' ? `<div class="toggle" style="border:0;padding-bottom:0"><span><b>French voice</b> <span class="small muted">Used for French decks</span></span></div>
  <div class="toggle"><span>Voice accent</span><div class="seg">${[['FR', 'FR'], ['CA', 'CA']].map(([v, n]) => `<button class="${(st.frAccent || 'FR') === v ? 'on' : ''}" onclick="ls_clearVoiceFr();A.setSetting('frAccent','${v}')">${n}</button>`).join('')}</div></div>
  ${true ? `<div class="toggle"><span><label for="svoicefr" style="margin:0;color:var(--ink);font-size:14px;font-weight:400">Voice on this device</label><span class="small muted">Pick the one that sounds best</span></span>
   <span style="display:flex;gap:6px;align-items:center;min-width:0">${(() => { const list = englishVoices(st.frAccent === 'CA' ? 'fr-CA' : 'fr-FR'); const cur = chosenVoice('fr');
     return list.length ? `<select id="svoicefr" style="max-width:170px" onchange="A.setVoiceFr(this.value)" data-notr>${list.map(v => `<option value="${esc(v.name)}" ${cur && cur.name === v.name ? 'selected' : ''}>${esc(v.name.replace(/^Microsoft /, '').replace(/ - French.*$/, '').replace(/ Online \(Natural\)/, ' (Natural)'))} · ${esc(v.lang)}</option>`).join('')}</select>` : '<span class="small muted">No French voices found</span>'; })()}
   <button class="speak" aria-label="Test voice" onclick="A.speak('Bonjour ! Voici comment SR App lira vos mots.', 'fr')">${ICON.speak}</button></span></div>` : ''}` : ''}
  <div class="toggle" style="flex-direction:column;align-items:flex-start"><span>Study modes <span class="small muted">(at least one stays on)</span></span><div class="chips">${Object.keys(MODE_NAME).map(k => `<button class="chip ${st.modes[k] ? 'on' : ''}" onclick="A.toggleMode('${k}')">${MODE_NAME[k]}</button>`).join('')}</div></div>
  <div class="toggle"><span>App language</span><div class="seg">${[['en', 'English'], ['fr', 'Français']].map(([v, n]) => `<button class="${uiLang() === v ? 'on' : ''}" onclick="A.setUiLang('${v}')" data-notr>${n}</button>`).join('')}</div></div>
  <div class="toggle" style="flex-direction:column;align-items:flex-start"><span>Text size <span class="small muted">(this device)</span></span><div class="seg">${TEXT_SIZES.map(([v, n]) => `<button class="${ls.get('sr-textsize', '100') === v ? 'on' : ''}" onclick="A.setTextSize('${v}')">${n}</button>`).join('')}</div></div>
  <div class="toggle"><span>Theme</span><div class="seg">${[['system', 'System'], ['light', 'Light'], ['dark', 'Dark']].map(([v, n]) => `<button class="${st.theme === v ? 'on' : ''}" onclick="A.setSetting('theme','${v}')">${n}</button>`).join('')}</div></div>
  <div class="toggle"><span>Sync<br><span class="small muted">${{ synced: 'All changes synced', syncing: 'Syncing…', offline: 'Offline — saved on this device', failed: 'Sync failed', login: 'Log in again to sync', unavailable: 'Sync unavailable' }[s.state]}${store.outbox.size ? ` · ${store.outbox.size} waiting` : ''}</span></span><button class="chip" onclick="${s.state === 'login' ? 'A.relogin()' : 'A.syncNow()'}">${s.state === 'login' ? 'Log in' : 'Sync now'}</button></div>
  ${s.message && ['failed', 'unavailable', 'login'].includes(s.state) ? `<div class="err">${esc(s.message)}</div>` : ''}
  <div class="toggle"><span>Add words from other apps</span><button class="chip" onclick="A.go('help')">Show how</button></div>
  <div class="toggle"><span>Backup</span><span class="chips"><button class="chip" onclick="A.exportBackup()">Export</button><label class="chip" style="margin:0;color:var(--ink);font-weight:400">Import<input type="file" accept=".json,application/json" hidden onchange="A.importBackup(this.files[0])"></label></span></div>
  <div class="toggle"><span>${esc(u.name || '')}<br><span class="small muted">${esc(u.email || '')}</span></span><button class="chip" onclick="A.logout()">Log out</button></div>
  <p class="small muted">SR App · words: Free Dictionary API (Wiktionary, CC BY-SA) and Tatoeba (CC BY 2.0 FR).</p></div>${tabs()}`;
};
A.syncNow = () => sync.syncNow();
A.setUiLang = l => { setUiLang(l); render(); };
A.setSetting = async (k, v, min, max) => {
  const cur = store.get('settings') || { id: 'settings', type: 'settings' };
  if (min !== undefined) { v = Math.round(Number(v)); if (!Number.isFinite(v)) v = DEFAULTS[k]; v = Math.min(max, Math.max(min, v)); }
  await store.put({ ...cur, [k]: v }); if (k === 'theme') applyTheme(); render();
};
A.toggleMode = async k => {
  const st = settings(); const modes = { ...st.modes, [k]: !st.modes[k] };
  if (!Object.values(modes).some(Boolean)) { toast('At least one study mode must stay on.'); return; }
  await A.setSetting('modes', modes);
};
const TEXT_SIZES = [['90','Small'],['100','Normal'],['115','Large'],['130','Extra large']];
function applyTextSize() {
  const z = Number(ls.get('sr-textsize', '100')) / 100;
  $app.style.zoom = z === 1 ? '' : String(z); $app.style.height = '';
  // Browsers differ on whether zoom also scales the height; shrink it only if the app now overflows the screen.
  if (z !== 1 && $app.getBoundingClientRect().bottom > innerHeight + 2) $app.style.height = innerWidth >= 600 ? `calc((100% - 32px) / ${z})` : `calc(100% / ${z})`;
}
addEventListener('resize', () => applyTextSize());
A.setTextSize = v => { ls.set('sr-textsize', v); applyTextSize(); render(); };
applyTextSize();
function applyTheme() { const t = settings().theme; if (t === 'system') document.documentElement.removeAttribute('data-theme'); else document.documentElement.setAttribute('data-theme', t); }
V.help = () => uiLang() === 'fr' ? helpFr() : `<div class="top"><button class="btn ghost sm" onclick="A.go('settings')" aria-label="Back">‹</button><h2 class="spacer">Add words from other apps</h2></div><div class="scroll">
  <h3 style="margin:0">On PC (Chrome or Edge)</h3>
  <div class="step"><span class="n">1</span><span>Install the SR App extension once (Andy has the folder): open <b>chrome://extensions</b>, turn on <b>Developer mode</b>, click <b>Load unpacked</b> and pick the <b>extension</b> folder.</span></div>
  <div class="step"><span class="n">2</span><span>On any web page, highlight a word, right-click, choose <b>Add to SR App</b>.</span></div>
  <h3 style="margin:8px 0 0">On iPhone (Safari or Chrome)</h3>
  <p class="small muted">Build the shortcut once, about 2 minutes:</p>
  <div class="step"><span class="n">1</span><span>Open the <b>Shortcuts</b> app, tap <b>+</b>, and name the shortcut <b>Add to SR App</b>.</span></div>
  <div class="step"><span class="n">2</span><span>Tap <b>ⓘ</b> and turn on <b>Show in Share Sheet</b>. Set it to receive <b>Text</b>.</span></div>
  <div class="step"><span class="n">3</span><span>Add the action <b>URL Encode</b> and set it to encode <b>Shortcut Input</b>.</span></div>
  <div class="step"><span class="n">4</span><span>Add the action <b>Text</b>. Paste this address, then insert <b>URL Encoded Text</b> right after it:</span></div>
  <pre class="code">${esc(MAIN_APP_URL)}?add=</pre>
  <div class="step"><span class="n">5</span><span>Add the action <b>Open URLs</b> (it uses the Text above). Tap <b>Done</b>.</span></div>
  <div class="step"><span class="n">6</span><span>Try it: highlight a word in Safari or Chrome, tap <b>Share</b>, then <b>Add to SR App</b>. To give it to family: in Shortcuts, press and hold it, <b>Share</b>, <b>Copy iCloud Link</b>.</span></div>
  <p class="note">The shortcut opens SR App in your browser. Log in there once; the home-screen app and the browser keep separate logins.</p>
  <h3 style="margin:8px 0 0">On Android</h3>
  <div class="step"><span class="n">1</span><span>Install SR App to the home screen (browser menu → <b>Install app</b>).</span></div>
  <div class="step"><span class="n">2</span><span>Highlight a word → <b>Share</b> → <b>SR App</b>.</span></div></div>${tabs()}`;

// ───────── Backup ─────────
A.exportBackup = () => {
  const u = auth.current()?.user || {};
  const data = { app: 'sr-app', version: 1, email: u.email, exportedAt: new Date().toISOString(), records: [...store.records.values()].filter(r => !r.deleted).map(({ rev, ...r }) => r) };
  const blob = new Blob([JSON.stringify(data)], { type: 'application/json' });
  const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = `sr-app-backup-${new Date().toISOString().slice(0, 10)}.json`;
  document.body.appendChild(a); a.click(); setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
  toast('Backup file saved.');
};
A.importBackup = async file => {
  if (!file) return;
  let data; try { data = JSON.parse(await file.text()); } catch { toast('This file is not an SR App backup.'); return; }
  if (!data || data.app !== 'sr-app' || !Array.isArray(data.records)) { toast('This file is not an SR App backup.'); return; }
  const me = auth.current()?.user?.email;
  const other = data.email && me && data.email.toLowerCase() !== me.toLowerCase();
  const nCards = data.records.filter(r => r.type === 'card').length;
  modal({ title: 'Replace all your data?', html: `<p>${other ? `This backup was made by <b>${esc(data.email)}</b>, not your account. ` : ''}Importing replaces all your decks, cards and progress with the ${nCards} card${nCards === 1 ? '' : 's'} in this backup. This cannot be undone.</p>`,
    ok: 'Replace my data', danger: true, onOk: () => restoreBackup(data) });
};
async function restoreBackup(data) {
  const kill = [...store.records.values()].filter(r => ['deck', 'card', 'review'].includes(r.type) && !r.deleted).map(r => ({ ...r, deleted: true }));
  const map = new Map(); const fresh = [];
  for (const r of data.records) if (['deck', 'card', 'review'].includes(r.type)) map.set(r.id, store.rid());
  for (const r of data.records) {
    if (r.type === 'deck') fresh.push({ ...r, id: map.get(r.id) });
    else if (r.type === 'card' && map.has(r.deckId)) fresh.push({ ...r, id: map.get(r.id), deckId: map.get(r.deckId) });
    else if (r.type === 'review' && map.has(r.cardId)) fresh.push({ ...r, id: map.get(r.id), cardId: map.get(r.cardId) });
    else if (r.type === 'settings') fresh.push({ ...r, id: 'settings' });
  }
  for (let k = 0; k < kill.length; k += 1000) await store.put(...kill.slice(k, k + 1000));
  for (let k = 0; k < fresh.length; k += 1000) await store.put(...fresh.slice(k, k + 1000));
  applyTheme(); go('home'); toast('Backup imported.');
}

// ───────── Session lifecycle ─────────
A.logout = () => {
  const pending = store.outbox.size;
  const doIt = async () => { await store.wipe(); auth.logout(); UI = { screen: 'login', tab: 'home', authMode: 'login' }; M = null; render(); };
  if (pending) modal({ title: `${pending} change${pending > 1 ? 's are' : ' is'} not synced yet`, body: 'If you log out now, they will be lost. Connect to the internet and sync first.',
    ok: 'Log out anyway', danger: true, alt: 'Sync first', onOk: doIt, onAlt: () => sync.syncNow() });
  else modal({ title: 'Log out?', body: 'Your cards stay in your account. This device will not keep a copy.', ok: 'Log out', onOk: doIt });
};
let autoSyncStarted = false;
A.startSession = () => startSession();
async function startSession() {
  const s = auth.current(); if (!s || !s.user) { go('login', { authMode: 'login' }, false); return; }
  await store.open(s.user.id);
  if (!autoSyncStarted) { sync.startAutoSync(); autoSyncStarted = true; }
  applyTheme();
  if (!store.records.size && navigator.onLine) { UI.screen = 'boot'; UI.bootMsg = 'Loading your cards…'; render(); await Promise.race([sync.syncNow(), new Promise(r => setTimeout(r, 15000))]); }
  else sync.syncNow();
  A.afterLogin();
}
A.afterLogin = () => {
  M = null;
  const profile = store.get('profile');
  if (!profile && sync.status.lastOk) { go('firstrun', {}, false); return; }
  const pending = ss.get('sr-pendingAdd');
  if (pending) { ss.set('sr-pendingAdd', null); UI.screen = 'home'; A.openAdd(pending); return; }
  go('home', {}, false);
};

// Keyboard shortcuts in study: Space = reveal, 1–4 = rating.
document.addEventListener('keydown', e => {
  if (UI.screen !== 'study' || !UI.session || UI.modal) return;
  if (['INPUT', 'TEXTAREA', 'SELECT'].includes(e.target.tagName)) return;
  const s = UI.session;
  if (e.code === 'Space') { e.preventDefault(); if (!s.revealed && ['flashcard', 'reverse', 'cloze'].includes(s.mode) || (s.mode === 'learn' && s.learnFallback && s.learnStage === 1 && !s.revealed)) A.reveal(); else if (s.mode === 'learn' && s.learnStage === 0) A.learnCheck(); }
  else if ('1234'.includes(e.key) && document.querySelector('.rate')) A.rate(RATING_NAME[e.key]);
});

// ───────── Boot ─────────
async function boot() {
  history.replaceState({ screen: 'boot' }, '');
  const hash = new URLSearchParams(location.hash.slice(1));
  const params = new URLSearchParams(location.search);
  // Words arriving from the extension, the iPhone shortcut or the Android share menu.
  const shared = params.get('add') ?? params.get('text') ?? params.get('title');
  if (shared !== null) {
    let word = shared; const urlOnly = /^https?:\/\//.test(word.trim());
    if (urlOnly) word = '';
    word = word.split(/\r?\n/)[0];
    ss.set('sr-pendingAdd', { word, sentence: params.get('s') || '', from: params.get('from') || '' });
    history.replaceState({ screen: 'boot' }, '', location.pathname);
  }
  // Links from Netlify Identity emails.
  const err = hash.get('error_description') || hash.get('error');
  const tokenType = ['confirmation_token', 'recovery_token', 'invite_token', 'email_change_token'].find(k => hash.get(k));
  if (err || tokenType) {
    history.replaceState({ screen: 'boot' }, '', location.pathname);
    if (err) { go('expired', { expiredHint: 'Request a new link from the log-in screen.' }, false); return; }
    try {
      if (tokenType === 'confirmation_token') { await auth.verify('signup', hash.get(tokenType)); go('confirmed', { confirmTitle: 'Email confirmed' }, false); return; }
      if (tokenType === 'recovery_token') { await auth.verify('recovery', hash.get(tokenType)); go('setpw', {}, false); return; }
      if (tokenType === 'invite_token') { go('login', { authMode: 'reg', authOk: 'You were invited. Register with the invited email address.' }, false); return; }
      if (tokenType === 'email_change_token') { await auth.verify('email_change', hash.get(tokenType)); go('confirmed', { confirmTitle: 'Email address updated' }, false); return; }
    } catch (e) { go('expired', { expiredHint: e.message === 'LINK_EXPIRED' ? 'Request a new link from the log-in screen.' : e.message }, false); return; }
  }
  if (!auth.current()) { go('login', { authMode: 'login' }, false); return; }
  if (auth.current().expired) { await store.open(auth.current().user.id); if (!autoSyncStarted) { sync.startAutoSync(); autoSyncStarted = true; } sync.status.state = 'login'; A.afterLogin(); return; }
  await startSession();
}
addEventListener('hashchange', () => { if (/(confirmation|recovery|invite|email_change)_token=|error=/.test(location.hash)) location.reload(); });
boot();

// French version of the "Add words from other apps" guide (written as whole sentences rather than translated in pieces).
function helpFr() {
  return `<div class="top"><button class="btn ghost sm" onclick="A.go('settings')" aria-label="Retour" data-notr>‹</button><h2 class="spacer" data-notr>Ajouter des mots depuis d’autres apps</h2></div><div class="scroll" data-notr>
  <h3 style="margin:0">Sur PC (Chrome ou Edge)</h3>
  <div class="step"><span class="n">1</span><span>Installez une fois l’extension SR App : ouvrez <b>chrome://extensions</b>, activez le <b>Mode développeur</b>, cliquez sur <b>Charger l’extension non empaquetée</b> et choisissez le dossier <b>extension</b>.</span></div>
  <div class="step"><span class="n">2</span><span>Sur n’importe quelle page web, sélectionnez un mot, faites un clic droit et choisissez <b>Add to SR App</b>.</span></div>
  <h3 style="margin:8px 0 0">Sur iPhone (Safari ou Chrome)</h3>
  <p class="small muted">Créez le raccourci une seule fois, environ 2 minutes :</p>
  <div class="step"><span class="n">1</span><span>Ouvrez l’app <b>Raccourcis</b>, touchez <b>+</b> et nommez le raccourci <b>Add to SR App</b>.</span></div>
  <div class="step"><span class="n">2</span><span>Touchez <b>ⓘ</b> et activez <b>Afficher dans la feuille de partage</b>. Choisissez de recevoir du <b>Texte</b>.</span></div>
  <div class="step"><span class="n">3</span><span>Ajoutez l’action <b>Encoder l’URL</b> appliquée à l’<b>Entrée du raccourci</b>.</span></div>
  <div class="step"><span class="n">4</span><span>Ajoutez l’action <b>Texte</b>. Collez cette adresse, puis insérez juste après <b>Texte encodé en URL</b> :</span></div>
  <pre class="code">${esc(MAIN_APP_URL)}?add=</pre>
  <div class="step"><span class="n">5</span><span>Ajoutez l’action <b>Ouvrir les URL</b> (elle utilise le Texte ci-dessus). Touchez <b>OK</b>.</span></div>
  <div class="step"><span class="n">6</span><span>Essayez : sélectionnez un mot dans Safari ou Chrome, touchez <b>Partager</b>, puis <b>Add to SR App</b>. Pour le partager en famille : dans Raccourcis, maintenez-le appuyé, <b>Partager</b>, <b>Copier le lien iCloud</b>.</span></div>
  <p class="note">Le raccourci ouvre SR App dans votre navigateur. Connectez-vous-y une fois : l’app de l’écran d’accueil et le navigateur ont des connexions séparées.</p>
  <h3 style="margin:8px 0 0">Sur Android</h3>
  <div class="step"><span class="n">1</span><span>Installez SR App sur l’écran d’accueil (menu du navigateur → <b>Installer l’application</b>).</span></div>
  <div class="step"><span class="n">2</span><span>Sélectionnez un mot → <b>Partager</b> → <b>SR App</b>.</span></div></div>${tabs()}`;
}
