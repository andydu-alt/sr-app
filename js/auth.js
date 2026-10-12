// Netlify Identity (GoTrue) over its REST API: sign up, confirm, log in, refresh, recover, update password.
import { IDENTITY_URL } from './config.js';

const KEY = 'sr-auth';
let session = null;
try { session = JSON.parse(localStorage.getItem(KEY) || 'null'); } catch { session = null; }

export class AuthError extends Error { constructor(msg, status) { super(msg); this.status = status; } }

function save(s) { session = s; try { s ? localStorage.setItem(KEY, JSON.stringify(s)) : localStorage.removeItem(KEY); } catch {} }

async function call(path, opts = {}) {
  let res;
  try { res = await fetch(IDENTITY_URL + path, opts); }
  catch { throw new AuthError('No internet connection. Connect and try again.', 0); }
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    const raw = body.error_description || body.msg || body.error || '';
    throw new AuthError(friendly(raw, res.status), res.status);
  }
  return body;
}

function friendly(raw, status) {
  const r = String(raw).toLowerCase();
  if (r.includes('already') && r.includes('registered')) return 'EMAIL_EXISTS';
  if (r.includes('email not confirmed')) return 'Please confirm your email first. Check your inbox (and spam).';
  if (r.includes('invalid') && (r.includes('password') || r.includes('grant') || r.includes('credentials'))) return 'Wrong email or password.';
  if (r.includes('password') && r.includes('short')) return 'Password must be at least 8 characters.';
  if (r.includes('token') && (r.includes('expired') || r.includes('not found') || r.includes('invalid'))) return 'LINK_EXPIRED';
  if (status === 404) return 'LINK_EXPIRED';
  if (status === 429) return 'Too many attempts. Wait a minute and try again.';
  return raw || 'Something went wrong. Try again.';
}

function fromToken(t) {
  return { access: t.access_token, refresh: t.refresh_token, expires: Date.now() + (t.expires_in || 3600) * 1000 - 60000 };
}
async function loadUser(tokens) {
  const u = await call('/user', { headers: { Authorization: 'Bearer ' + tokens.access } });
  const s = { ...tokens, user: { id: u.id, email: u.email, name: (u.user_metadata && u.user_metadata.full_name) || u.email.split('@')[0] } };
  save(s); return s;
}

export const current = () => session;

export async function signup(name, email, password) {
  return call('/signup', { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password, data: { full_name: name } }) });
}

export async function login(email, password) {
  const t = await call('/token', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'password', username: email, password }) });
  return loadUser(fromToken(t));
}

export async function verify(type, token) {
  const t = await call('/verify', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ type, token }) });
  return loadUser(fromToken(t));
}

export async function recover(email) {
  return call('/recover', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email }) });
}

export async function setPassword(password) {
  const tok = await accessToken();
  return call('/user', { method: 'PUT', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + tok }, body: JSON.stringify({ password }) });
}

// Valid access token, refreshing when needed. Throws AuthError(status 401) when the user must log in again.
export async function accessToken() {
  if (!session) throw new AuthError('Log in to sync.', 401);
  if (Date.now() < session.expires) return session.access;
  try {
    const t = await call('/token', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: session.refresh }) });
    save({ ...session, ...fromToken(t) });
    return session.access;
  } catch (e) {
    if (e.status === 0) throw e;
    session = { ...session, expired: true }; save(session);
    throw new AuthError('Log in again to sync.', 401);
  }
}

export function logout() { save(null); }
