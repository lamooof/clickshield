import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import test from 'node:test';

// Exercise the recorder's private sanitizer without starting DOM recording.
const source = readFileSync(new URL('../internal/httpapi/assets/replay-recorder.js', import.meta.url), 'utf8');
const prefix = source.slice(0, source.indexOf('let activeStop ='));
const context = {};
runInNewContext(prefix + 'globalThis.sanitize = sanitize; })();', context);
const sanitize = event => context.sanitize(event, value => value);

test('SVG geometry survives while human-readable attributes and text are masked', () => {
  const path = 'M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2';
  const event = { data: { node: { tagName: 'path', attributes: {
    d: path, points: '12 3 16 8 21 16', 'aria-label': 'Call +7 (999) 760-24-41',
    onclick: 'send()', 'data-user-email': 'private@example.com',
  }, textContent: 'Contact private@example.com' } } };
  sanitize(event);
  assert.equal(event.data.node.attributes.d, path);
  assert.equal(event.data.node.attributes.points, '12 3 16 8 21 16');
  assert.equal(event.data.node.attributes['aria-label'], 'Call [number]');
  assert.equal(event.data.node.textContent, 'Contact [email]');
  assert.equal(event.data.node.attributes.onclick, undefined);
  assert.equal(event.data.node.attributes['data-user-email'], undefined);
});

test('personal identifiers in incremental text mutations are masked', () => {
  const event = { type: 3, data: { texts: [{ id: 42, value: 'private@example.com +7 (999) 760-24-41' }] } };
  sanitize(event);
  assert.equal(event.data.texts[0].value, '[email] [number]');
});
