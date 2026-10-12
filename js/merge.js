// Shared by the browser and the sync function: decides whether an incoming record replaces the stored one.
// Records: {id, type, updatedAt, deleted?, ...}. Reviews never change except to be deleted (undo).
export function wins(incoming, existing) {
  if (!existing) return true;
  if (existing.type === 'review' && incoming.type === 'review') return !!incoming.deleted && !existing.deleted;
  // A deleted card or deck never comes back, even from a later edit made offline on another device.
  if (existing.deleted && !incoming.deleted) return false;
  if (incoming.deleted && !existing.deleted) return true;
  if (incoming.updatedAt !== existing.updatedAt) return incoming.updatedAt > existing.updatedAt;
  return String(incoming.device || '') > String(existing.device || '');
}

// Server-side merge into a user document {rev, records:{id:rec}}. Returns accepted ids.
export function mergeInto(doc, changes) {
  const accepted = [];
  for (const ch of changes || []) {
    if (!ch || typeof ch.id !== 'string' || typeof ch.type !== 'string' || typeof ch.updatedAt !== 'number') continue;
    if (wins(ch, doc.records[ch.id])) {
      doc.rev += 1;
      doc.records[ch.id] = { ...ch, rev: doc.rev };
      accepted.push(ch.id);
    }
  }
  return accepted;
}

export function changesSince(doc, since) {
  return Object.values(doc.records).filter(r => r.rev > (since || 0));
}
