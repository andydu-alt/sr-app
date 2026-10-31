// Scheduling: replays each card's review log through FSRS, builds study queues, computes progress.
import { fsrs, createEmptyCard, generatorParameters, Rating, State } from '../vendor/ts-fsrs.mjs';

export const RATING = { again: Rating.Again, hard: Rating.Hard, good: Rating.Good, easy: Rating.Easy };
export const RATING_NAME = { 1: 'again', 2: 'hard', 3: 'good', 4: 'easy' };
export const LEECH_LAPSES = 8;
export const MASTERED_DAYS = 21;
const DAY = 86400000;

export function makeScheduler(retention = 0.9) {
  return fsrs(generatorParameters({
    request_retention: retention, enable_fuzz: false, enable_short_term: true,
    learning_steps: ['1m', '10m'], relearning_steps: ['10m'], maximum_interval: 36500,
  }));
}

// Study day runs 4:00 → 4:00 local time.
export function dayStart(t = Date.now()) {
  const d = new Date(t); d.setHours(4, 0, 0, 0);
  if (t < d.getTime()) d.setDate(d.getDate() - 1);
  return d.getTime();
}
export const nextDayStart = (t = Date.now()) => { const d = new Date(dayStart(t)); d.setDate(d.getDate() + 1); return d.getTime(); };
export const dayKey = t => { const d = new Date(dayStart(t)); return d.getFullYear() + '-' + (d.getMonth() + 1) + '-' + d.getDate(); };

// After a mistake (relearning), the next correct answer restarts small: Hard 1d, Good 2d, Easy 4d.
const AFTER_MISS_DAYS = { 2: 1, 3: 2, 4: 4 };
function step(f, c, at, rating) {
  const n = f.next(c, at, rating).card;
  const d = c.state === State.Relearning && AFTER_MISS_DAYS[rating];
  if (!d) return n;
  return { ...n, state: State.Review, scheduled_days: d, stability: Math.min(n.stability, d), due: new Date(at.getTime() + d * DAY) };
}

// Replay one card's reviews (sorted by time). A rating of 0 is a reset.
export function replay(f, card, reviews) {
  let c = createEmptyCard(new Date(card.createdAt || 0));
  const log = [];
  let firstReview = null;
  for (const r of reviews) {
    if (r.rating === 0) { c = createEmptyCard(new Date(r.time)); firstReview = null; log.length = 0; continue; }
    const prev = c.state;
    const at = new Date(Math.max(r.time, c.last_review ? c.last_review.getTime() : 0));
    c = step(f, c, at, r.rating);
    if (firstReview === null) firstReview = r.time;
    log.push({ time: r.time, rating: r.rating, prev });
  }
  return { fc: c, log, firstReview };
}

export function cardInfo(fc) {
  const isNew = fc.state === State.New;
  const learning = fc.state === State.Learning || fc.state === State.Relearning;
  const mastered = fc.state === State.Review && fc.scheduled_days >= MASTERED_DAYS;
  return { isNew, learning, mastered, due: fc.due.getTime(), lapses: fc.lapses, reps: fc.reps,
    stateName: isNew ? 'New' : learning ? 'Learning' : mastered ? 'Mastered' : 'Review' };
}

// Interval labels for the four buttons, e.g. {again:'1m', hard:'6m', good:'10m', easy:'4d'}.
export function previewIntervals(f, fc, now = Date.now()) {
  const out = {};
  for (const [k, g] of Object.entries(RATING)) out[k] = fmtInterval(step(f, fc, new Date(now), g).due.getTime() - now);
  return out;
}
export function fmtInterval(ms) {
  const m = Math.max(1, Math.round(ms / 60000));
  if (m < 60) return m + 'm';
  const h = Math.round(m / 60); if (h < 24) return h + 'h';
  const d = Math.round(ms / DAY); if (d < 31) return d + 'd';
  const mo = Math.round(d / 30.4); if (mo < 12) return mo + 'mo';
  return (d / 365).toFixed(1).replace(/\.0$/, '') + 'y';
}

// Build today's queue. cards: [{card, info, firstReview}], settings, reviewsToday, newToday
export function buildQueue(items, { newLimit, reviewLimit, newDoneToday, reviewsDoneToday, deckId = null, extraNew = 0, now = Date.now() }) {
  const end = nextDayStart(now);
  const pool = items.filter(x => !x.card.suspended && !x.card.deleted && (!deckId || x.card.deckId === deckId));
  const learning = pool.filter(x => x.info.learning && x.info.due < end).sort((a, b) => a.info.due - b.info.due);
  const reviewsAll = pool.filter(x => !x.info.isNew && !x.info.learning && x.info.due < end).sort((a, b) => a.info.due - b.info.due);
  const reviews = reviewsAll.slice(0, Math.max(0, reviewLimit - reviewsDoneToday));
  const newCards = pool.filter(x => x.info.isNew).sort((a, b) => (a.card.order ?? a.card.createdAt) - (b.card.order ?? b.card.createdAt))
    .slice(0, Math.max(0, newLimit - newDoneToday) + extraNew);
  return { learning, reviews, newCards, reviewsCapped: reviewsAll.length - reviews.length };
}

// Pick the next card id to show. queue holds ids; learning cards come back when due (learn-ahead 20 min when nothing else).
export function pickNext(state, infoOf, now = Date.now()) {
  const learnDue = state.learning.filter(id => infoOf(id).due <= now).sort((a, b) => infoOf(a).due - infoOf(b).due);
  if (learnDue.length) return learnDue[0];
  if (state.reviews.length) return state.reviews[0];
  if (state.newCards.length) return state.newCards[0];
  const ahead = state.learning.filter(id => infoOf(id).due <= now + 20 * 60000).sort((a, b) => infoOf(a).due - infoOf(b).due);
  return ahead[0] || null;
}

export function progress(items, reviews, now = Date.now()) {
  const counts = { New: 0, Learning: 0, Review: 0, Mastered: 0 };
  for (const x of items) if (!x.card.suspended) counts[x.info.stateName]++;
  // Streak: consecutive study days with at least one review, ending today or yesterday.
  const days = new Set(reviews.filter(r => r.rating > 0).map(r => dayKey(r.time)));
  let streak = 0; let t = dayStart(now);
  if (!days.has(dayKey(t))) t -= DAY;
  while (days.has(dayKey(t + 3600000))) { streak++; t -= DAY; }
  const today = reviews.filter(r => r.rating > 0 && r.time >= dayStart(now)).length;
  // Retention: reviews of learned cards (previous state Review) in the last 30 days not rated Again.
  let n = 0, ok = 0;
  for (const x of items) for (const l of x.log) if (l.prev === State.Review && l.time >= now - 30 * DAY) { n++; if (l.rating > 1) ok++; }
  const forecast = [];
  const end0 = nextDayStart(now);
  for (let i = 0; i < 7; i++) {
    const from = i === 0 ? -Infinity : end0 + (i - 1) * DAY, to = end0 + i * DAY;
    forecast.push({ t: to - DAY, n: items.filter(x => !x.card.suspended && !x.info.isNew && x.info.due >= from && x.info.due < to).length });
  }
  return { counts, streak, today, retention: n ? Math.round(ok / n * 100) : null, retentionN: n, forecast };
}
