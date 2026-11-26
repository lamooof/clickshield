import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import test from 'node:test';

const { merge } = createRequire(import.meta.url)('../internal/httpapi/assets/replay-timeline.js');
const ev = (type, timestamp) => ({ type, timestamp });

test('pages are joined into one timeline starting at each full snapshot', () => {
  const { events, marks, skipped } = merge([
    { index: 2, url: 'b', events: [ev(4, 5000), ev(2, 5001), ev(3, 9000)] },
    { index: 1, url: 'a', events: [ev(3, 900), ev(4, 1000), ev(2, 1001), ev(3, 2000)] },
  ]);
  assert.deepEqual(events.map(e => e.timestamp), [1000, 1001, 2000, 5000, 5001, 9000]);
  assert.deepEqual(marks.map(m => [m.index, m.url, m.offset]), [[1, 'a', 0], [2, 'b', 4000]]);
  assert.equal(skipped, 0);
});

test('pages without a snapshot or overlapping in time are skipped', () => {
  const { events, marks, skipped } = merge([
    { index: 1, url: 'a', events: [ev(4, 1000), ev(2, 1001), ev(3, 5000)] },
    { index: 2, url: 'b', events: [ev(3, 6000)] },
    { index: 3, url: 'c', events: [ev(4, 3000), ev(2, 3001)] },
  ]);
  assert.equal(events.length, 3);
  assert.equal(marks.length, 1);
  assert.equal(skipped, 2);
});
