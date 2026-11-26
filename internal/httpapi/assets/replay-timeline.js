// Merges per-page rrweb recordings into one timeline with page marks.
(root => {
  'use strict';
  // A page is playable only from its first full snapshot (with preceding Meta).
  function playable(page) {
    const list = Array.isArray(page?.events) ? page.events : [];
    let start = list.findIndex(e => e?.type === 2);
    if (start < 0) return null;
    if (start > 0 && list[start - 1]?.type === 4) start--;
    return { index: page.index, url: page.url, events: list.slice(start) };
  }
  function merge(pages) {
    const all = (pages || []).map(playable);
    const list = all.filter(Boolean).sort((a, b) => a.events[0].timestamp - b.events[0].timestamp);
    const events = [], marks = [];
    let skipped = all.length - list.length;
    for (const page of list) {
      // Overlapping pages (e.g. two tabs) cannot share one DOM timeline.
      if (events.length && page.events[0].timestamp < events[events.length - 1].timestamp) { skipped++; continue; }
      marks.push({ at: page.events[0].timestamp, index: page.index, url: page.url });
      events.push(...page.events);
    }
    const first = events[0]?.timestamp || 0;
    for (const m of marks) m.offset = m.at - first;
    return { events, marks, skipped };
  }
  const api = { merge };
  if (typeof module === 'object' && module.exports) module.exports = api; else root.ReplayTimeline = api;
})(this);
