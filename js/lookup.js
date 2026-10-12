// Auto-fill: Free Dictionary API for meanings/IPA, Tatoeba for example sentences. 5-second limit, offline-aware.
import { baseForms, containsWord } from './text.js';

const DICT = 'https://api.dictionaryapi.dev/api/v2/entries/en/';
const TATOEBA = 'https://api.tatoeba.org/unstable/sentences';
const TIMEOUT = 5000;

async function getJSON(url, ms = TIMEOUT) {
  const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), ms);
  try {
    const res = await fetch(url, { signal: ctl.signal });
    if (res.status === 404) return { notFound: true };
    if (!res.ok) throw new Error('HTTP ' + res.status);
    return { data: await res.json() };
  } catch (e) {
    if (e.name === 'AbortError') return { slow: true };
    return { error: true };
  } finally { clearTimeout(t); }
}

function parseEntries(entries) {
  const meanings = []; let ipa = '';
  for (const e of entries) {
    const ph = (e.phonetics || []).filter(p => p.text);
    const uk = ph.find(p => /-uk\.mp3$/.test(p.audio || ''));
    ipa = ipa || (uk && uk.text) || e.phonetic || (ph[0] && ph[0].text) || '';
    for (const m of e.meanings || []) for (const d of m.definitions || [])
      meanings.push({ pos: m.partOfSpeech || '', def: d.definition || '', example: d.example || '' });
  }
  return { meanings: meanings.filter(m => m.def).slice(0, 8), ipa: ipa.replace(/ɹ/g, 'r') };
}

const WIKT = 'https://en.wiktionary.org/api/rest_v1/page/definition/';
const stripHtml = h => String(h || '').replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/\s+/g, ' ').trim();
function parseWiktionary(data) {
  const meanings = [];
  for (const e of (data && data.en) || []) for (const d of e.definitions || []) {
    const def = stripHtml(d.definition);
    if (!def || def.length < 3) continue;
    const ex = (d.parsedExamples && d.parsedExamples[0] && d.parsedExamples[0].example) || (d.examples && d.examples[0]) || '';
    meanings.push({ pos: String(e.partOfSpeech || '').toLowerCase(), def, example: stripHtml(ex) });
  }
  return { meanings: meanings.slice(0, 8), ipa: '' };
}

// One word: both dictionaries at once (the Free Dictionary API is often slow); prefer the one with pronunciation.
async function lookupOne(w) {
  const pa = getJSON(DICT + encodeURIComponent(w)), pb = getJSON(WIKT + encodeURIComponent(w.replace(/ /g, '_')));
  let a = null;
  // Wiktionary usually answers fast; give the Free Dictionary API (which has pronunciation) 1.5 s more, not the full 5 s.
  const b = await pb;
  const B0 = b.data ? parseWiktionary(b.data) : null;
  if (B0 && B0.meanings.length) a = await Promise.race([pa, new Promise(r => setTimeout(() => r({ slow: true }), 1500))]);
  else a = await pa;
  const A = a.data && Array.isArray(a.data) && a.data.length ? parseEntries(a.data) : null;
  const B = B0;
  if (A && A.meanings.length) return { found: { ...A, ipa: A.ipa } };
  if (B && B.meanings.length) return { found: B };
  if (a.slow && b.slow) return { slow: true };
  if ((a.notFound || a.slow || a.error) && (b.notFound || (b.data && !(B && B.meanings.length)))) return { notFound: true };
  return { error: true };
}

const FORM_OF = /^(?:.*?\b)?(?:plural|simple past|past participle|present participle|third-person singular|comparative|superlative|alternative (?:form|spelling)|obsolete spelling)\b.*?\bof ([a-z][a-z' -]{0,40})\.?$/i;

// → {status:'ok'|'notfound'|'slow'|'offline'|'error', word, meanings, ipa, base}
export async function lookupWord(word) {
  if (!navigator.onLine) return { status: 'offline', word, meanings: [], ipa: '' };
  const w0 = word.trim().replace(/\s+/g, ' ');
  // Wiktionary is case-sensitive ("Get up" fails, "get up" works): try lower case first, then as typed.
  const tries = [...new Set([w0.toLowerCase(), w0, ...baseForms(w0)])];
  let sawError = false;
  for (let i = 0; i < tries.length && i < 4; i++) {
    const r = await lookupOne(tries[i]);
    if (r.found) {
      // "simple past of follow up", "plural of child" → look up the base form instead.
      const m = r.found.meanings.every(x => FORM_OF.test(x.def)) && FORM_OF.exec(r.found.meanings[0].def);
      if (m && i === 0) {
        const base = m[1].trim().replace(/[.;,]+$/, '');
        const rb = await lookupOne(base);
        if (rb.found) return { status: 'ok', word: base, base: true, ...rb.found };
      }
      return { status: 'ok', word: tries[i], base: i > 0, ...r.found };
    }
    if (r.slow) return { status: 'slow', word, meanings: [], ipa: '' };
    if (r.error) sawError = true;
  }
  if (sawError && !navigator.onLine) return { status: 'offline', word, meanings: [], ipa: '' };
  return { status: sawError ? 'error' : 'notfound', word, meanings: [], ipa: '' };
}

// Up to `max` English sentences containing the word, preferring exact matches.
export async function exampleSentences(word, max = 4) {
  if (!navigator.onLine) return [];
  const url = `${TATOEBA}?lang=eng&q=${encodeURIComponent('"' + word + '"')}&sort=random&limit=20`;
  const r = await getJSON(url, TIMEOUT);
  if (!r.data || !Array.isArray(r.data.data)) return [];
  const texts = r.data.data.map(s => s.text).filter(t => t && t.length <= 160);
  const exact = texts.filter(t => containsWord(t, word));
  const rest = texts.filter(t => !containsWord(t, word));
  return [...exact, ...rest].slice(0, max);
}

// Pronunciation from Wiktionary's page source: prefers the British (RP/UK) line. Phrases without their own entry
// are built from each word ("get up" → /ɡet ʌp/).
const WIKI_API = 'https://en.wiktionary.org/w/api.php?action=parse&prop=wikitext&format=json&origin=*&redirects=1&page=';
async function ipaOf(w) {
  const r = await getJSON(WIKI_API + encodeURIComponent(w.replace(/ /g, '_')), 5000);
  const text = r.data && r.data.parse && r.data.parse.wikitext && r.data.parse.wikitext['*'];
  if (!text) return '';
  const english = text.split(/\n==(?!=)/).find(s => /^\s*English\s*==/.test(s)) || text;
  const lines = (english.match(/.*\{\{IPA\|en\|.*$/gm) || []);
  if (!lines.length) return '';
  const pick = lines.find(l => /a=[^|}]*(RP|UK)/.test(l)) || lines.find(l => !/a=|q1?=/.test(l)) || lines[0];
  const m = /\{\{IPA\|en\|([^}]*)\}\}/.exec(pick); if (!m) return '';
  const first = m[1].split('|').find(p => /^\/.+\/$/.test(p.trim())) || m[1].split('|').find(p => /^\[.+\]$/.test(p.trim())) || '';
  return first.trim().replace(/ɹ/g, 'r').replace(/ɛ/g, 'e').replace(/ɝ/g, 'ɜː').replace(/ɚ/g, 'ə');
}
export async function pronunciation(word) {
  if (!navigator.onLine) return '';
  const w = word.trim().toLowerCase().replace(/\s+/g, ' ');
  const whole = await ipaOf(w);
  if (whole || !w.includes(' ')) return whole;
  const parts = await Promise.all(w.split(' ').map(ipaOf));
  if (parts.some(p => !p)) return '';
  return '/' + parts.map(p => p.replace(/^[\/\[]|[\/\]]$/g, '')).join(' ') + '/';
}
