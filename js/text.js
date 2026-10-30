// Pure text helpers: answer checking, spelling diff, cloze, selection cleanup, CSV parsing.

export const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// Lowercase, hyphen = space, drop punctuation, collapse spaces.
export function norm(s) {
  return String(s ?? '').toLowerCase().replace(/[‐-―-]/g, ' ').replace(/[’']/g, "'")
    .replace(/[^\p{L}' ]/gu, '').replace(/'/g, '').replace(/\s+/g, ' ').trim();
}

// Map UK and US spellings to one form, applied to both sides of a comparison.
export function canon(s) {
  return norm(s).split(' ').map(w => w
    .replace(/isation$/, 'ization').replace(/isations$/, 'izations')
    .replace(/ise(s|d)?$/, 'ize$1').replace(/ising$/, 'izing')
    .replace(/yse(s|d)?$/, 'yze$1').replace(/ysing$/, 'yzing')
    .replace(/our(s|ed|ing|ful|ite)?$/, 'or$1')
    .replace(/tre(s)?$/, 'ter$1')
    .replace(/ogue(s)?$/, 'og$1')
    .replace(/ence$/, 'ense')
    .replace(/ll(ed|ing|er)$/, 'l$1')
    .replace(/ae/g, 'e').replace(/oe/g, 'e')
  ).join(' ');
}

export function lev(a, b) {
  const m = Array.from({ length: a.length + 1 }, (_, i) => [i]);
  for (let j = 1; j <= b.length; j++) m[0][j] = j;
  for (let i = 1; i <= a.length; i++)
    for (let j = 1; j <= b.length; j++)
      m[i][j] = Math.min(m[i - 1][j] + 1, m[i][j - 1] + 1, m[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
  return m[a.length][b.length];
}

// Typed answer → suggested rating. exact: 'good'; one letter off: 'hard'; else 'again'.
export function gradeTyped(typed, answer) {
  const a = canon(typed), b = canon(answer);
  if (!a) return 'again';
  const d = lev(a, b);
  return d === 0 ? 'good' : d === 1 ? 'hard' : 'again';
}

// Letter-level diff: [{t:'same'|'extra'|'missing', c}]
export function diff(typed, answer) {
  const a = norm(typed), b = norm(answer);
  const L = Array.from({ length: a.length + 1 }, () => Array(b.length + 1).fill(0));
  for (let i = a.length - 1; i >= 0; i--)
    for (let j = b.length - 1; j >= 0; j--)
      L[i][j] = a[i] === b[j] ? L[i + 1][j + 1] + 1 : Math.max(L[i + 1][j], L[i][j + 1]);
  const out = []; let i = 0, j = 0;
  while (i < a.length || j < b.length) {
    if (i < a.length && j < b.length && a[i] === b[j]) { out.push({ t: 'same', c: a[i] }); i++; j++; }
    else if (j < b.length && (i >= a.length || L[i][j + 1] >= L[i + 1][j])) { out.push({ t: 'missing', c: b[j] }); j++; }
    else { out.push({ t: 'extra', c: a[i] }); i++; }
  }
  return out;
}

const reEsc = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
export function wordRegex(word) {
  const parts = String(word).trim().split(/[\s-]+/).map(reEsc);
  return new RegExp('(^|[^\\p{L}])(' + parts.join('[\\s-]+') + ')(?![\\p{L}])', 'iu');
}
export const containsWord = (sentence, word) => !!word && wordRegex(word).test(sentence || '');
// Returns [before, match, after] or null.
export function clozeSplit(sentence, word) {
  const m = wordRegex(word).exec(sentence || '');
  if (!m) return null;
  const start = m.index + m[1].length;
  return [sentence.slice(0, start), m[2], sentence.slice(start + m[2].length)];
}

// Clean a highlighted selection: trim punctuation, lower a sentence-start capital, max 60 chars.
export function cleanSelection(raw, sentence = '') {
  let s = String(raw || '').replace(/\s+/g, ' ').trim();
  s = s.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, '');
  let cut = false;
  if (s.length > 60) { s = s.slice(0, 60).replace(/\s+\S*$/, ''); cut = true; }
  if (/^\p{Lu}\p{Ll}/u.test(s)) {
    const at = sentence ? sentence.indexOf(s) : 0;
    const before = sentence ? sentence.slice(0, Math.max(at, 0)).trim() : '';
    const sentenceStart = at <= 0 || /[.!?]$/.test(before) || before === '';
    if (sentenceStart) s = s[0].toLowerCase() + s.slice(1);
  }
  return { word: s, cut };
}

// Base-form guesses for a word or phrase ("followed up" → "follow up", "children" → "child").
const IRREG = { children: 'child', men: 'man', women: 'woman', people: 'person', feet: 'foot', teeth: 'tooth', mice: 'mouse',
  went: 'go', gone: 'go', ran: 'run', took: 'take', taken: 'take', made: 'make', bought: 'buy', brought: 'bring', thought: 'think',
  caught: 'catch', taught: 'teach', got: 'get', gotten: 'get', gave: 'give', given: 'give', came: 'come', saw: 'see', seen: 'see',
  knew: 'know', known: 'know', told: 'tell', said: 'say', found: 'find', felt: 'feel', kept: 'keep', left: 'leave', met: 'meet',
  paid: 'pay', sent: 'send', spent: 'spend', stood: 'stand', understood: 'understand', wrote: 'write', written: 'write',
  better: 'good', best: 'good', worse: 'bad', worst: 'bad', was: 'be', were: 'be', been: 'be', did: 'do', done: 'do', had: 'have', has: 'have' };
export function baseForms(text) {
  const words = String(text).toLowerCase().trim().split(/\s+/);
  const first = words[0], rest = words.slice(1).join(' ');
  const cands = new Set();
  if (IRREG[first]) cands.add(IRREG[first]);
  const rules = [[/ies$/, 'y'], [/ied$/, 'y'], [/([^aeiou])\1(ed|ing)$/, '$1'], [/ing$/, ''], [/ing$/, 'e'], [/ed$/, ''], [/ed$/, 'e'], [/d$/, ''], [/es$/, ''], [/s$/, '']];
  for (const [re, rep] of rules) if (re.test(first)) { const b = first.replace(re, rep); if (b.length >= 2 && b !== first) cands.add(b); }
  return [...cands].map(b => rest ? b + ' ' + rest : b);
}

// Pick the sentence around a selection inside a block of text.
export function sentenceAround(block, selection) {
  const t = String(block || '').replace(/\s+/g, ' ');
  const i = t.indexOf(selection);
  if (i < 0) return '';
  let s = i; while (s > 0 && !/[.!?]/.test(t[s - 1])) s--;
  let e = i + selection.length; while (e < t.length && !/[.!?]/.test(t[e])) e++;
  const out = t.slice(s, Math.min(e + 1, t.length)).trim();
  return out.length > 300 ? '' : out;
}

// Near-identical explanations (used to avoid ambiguous multiple-choice options).
export function similar(a, b) {
  const A = new Set(norm(a).split(' ').filter(w => w.length > 2)), B = new Set(norm(b).split(' ').filter(w => w.length > 2));
  if (!A.size || !B.size) return norm(a) === norm(b);
  let inter = 0; for (const w of A) if (B.has(w)) inter++;
  return inter / Math.min(A.size, B.size) >= 0.75;
}

// CSV / delimited text parser with quotes, escaped quotes and line breaks inside quotes.
export function parseDelimited(text, sep) {
  const rows = []; let row = [], field = '', q = false;
  text = String(text).replace(/^﻿/, '');
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (q) {
      if (ch === '"') { if (text[i + 1] === '"') { field += '"'; i++; } else q = false; }
      else field += ch;
    } else if (ch === '"' && field === '') q = true;
    else if (ch === sep) { row.push(field); field = ''; }
    else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      row.push(field); rows.push(row); row = []; field = '';
    } else field += ch;
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  return rows.map(r => r.map(c => c.trim())).filter(r => r.some(c => c !== ''));
}
