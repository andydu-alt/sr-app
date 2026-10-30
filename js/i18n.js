// Interface language. The app is written in English; when French is chosen, visible text is swapped after each render.
// Card content (words, explanations, examples, deck names) is never translated: it is marked with data-notr.
import { FR, FR_PATTERNS } from './i18n-fr.js';

let lang = 'en';
try { lang = localStorage.getItem('sr-ui-lang') || 'en'; } catch {}
export const uiLang = () => lang;
export function setUiLang(l) { lang = l; try { localStorage.setItem('sr-ui-lang', l); } catch {} document.documentElement.lang = l; }
document.documentElement.lang = lang;

export const missing = new Set(); // English strings with no French yet (for checking)

// Translate one string. Keeps leading/trailing spaces; tries exact match, then patterns with numbers or names.
export function t(text) {
  if (lang === 'en' || !text) return text;
  const m = /^(\s*)([\s\S]*?)(\s*)$/.exec(text); const core = m[2];
  if (!core || !/[A-Za-z]/.test(core)) return text;
  if (FR[core] !== undefined) return m[1] + FR[core] + m[3];
  for (const [re, rep] of FR_PATTERNS) { if (re.test(core)) return m[1] + core.replace(re, rep) + m[3]; }
  missing.add(core);
  return text;
}

const ATTRS = ['placeholder', 'aria-label', 'title'];
export function translate(root) {
  if (lang === 'en' || !root) return;
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode: n => {
      const p = n.parentElement; if (!p) return NodeFilter.FILTER_ACCEPT;
      if (p.closest('[data-notr]') || /^(SCRIPT|STYLE|TEXTAREA)$/.test(p.tagName)) return NodeFilter.FILTER_REJECT;
      // Inside a study card only the labels (mode line, small hints) are interface text; the rest is the card itself.
      if (p.closest('[data-notr-content]') && !p.closest('.mode, .small')) return NodeFilter.FILTER_REJECT;
      return NodeFilter.FILTER_ACCEPT;
    },
  });
  const nodes = []; while (walker.nextNode()) nodes.push(walker.currentNode);
  for (const n of nodes) { const v = t(n.nodeValue); if (v !== n.nodeValue) n.nodeValue = v; }
  for (const el of root.querySelectorAll(ATTRS.map(a => `[${a}]`).join(','))) {
    if (el.closest('[data-notr]')) continue;
    for (const a of ATTRS) if (el.hasAttribute(a)) { const v = t(el.getAttribute(a)); if (v !== el.getAttribute(a)) el.setAttribute(a, v); }
  }
}
