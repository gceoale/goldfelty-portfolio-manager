import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeConfig } from '../src/config.js';
import { nextDue, capCheck, parseWindow, targetMinute, dayKey, historyFrom } from '../src/schedule.js';

const config = normalizeConfig({ x: { windows: ['09:00-11:00', '13:00-15:00', '18:00-20:00'] } });
const at = (h, m = 0, day = 27) => new Date(2026, 9, day, h, m);
const approved = (id, kind = 'post', approvedAt = '2026-10-26T10:00:00Z') => ({
  id,
  platform: 'x',
  kind,
  status: 'approved',
  approvedAt,
});

test('the config can lower caps but never raise them', () => {
  const c = normalizeConfig({ x: { dailyCap: 50, threadsPerDay: 9 }, reddit: { dailyCap: 10 } });
  assert.equal(c.x.dailyCap, 3);
  assert.equal(c.x.threadsPerDay, 1);
  assert.equal(c.reddit.dailyCap, 1);
  assert.equal(normalizeConfig({ x: { dailyCap: 2 } }).x.dailyCap, 2);
});

test('windows parse and reject nonsense', () => {
  assert.deepEqual(parseWindow('09:30-11:00'), { start: 570, end: 660 });
  assert.throws(() => parseWindow('11:00-09:00'));
  assert.throws(() => parseWindow('noon'));
});

test('the target minute is stable for a day and inside the window', () => {
  const win = parseWindow('09:00-11:00');
  const a = targetMinute('2026-10-27', 'x', 0, win);
  assert.equal(a, targetMinute('2026-10-27', 'x', 0, win));
  assert.ok(a >= win.start && a < win.end - 10);
});

test('nothing goes out outside the windows', () => {
  const r = nextDue({ platform: 'x', items: [approved('a')], history: [], config, now: at(7) });
  assert.equal(r.item, null);
  assert.equal(r.why, 'outside posting windows');
});

test('an approved item goes out once the window time is reached', () => {
  const win = parseWindow('09:00-11:00');
  const t = targetMinute(dayKey(at(9)), 'x', 0, win);
  const before = at(Math.floor((t - 1) / 60), (t - 1) % 60);
  const after = at(Math.floor(t / 60), t % 60);
  if (t > win.start) {
    assert.equal(nextDue({ platform: 'x', items: [approved('a')], history: [], config, now: before }).item, null);
  }
  assert.equal(nextDue({ platform: 'x', items: [approved('a')], history: [], config, now: after }).item.id, 'a');
});

test('one post per window, a minimum gap, and the daily cap', () => {
  const items = [approved('a'), approved('b')];
  const late = at(10, 55);
  const history = [{ platform: 'x', kind: 'post', at: at(9, 5) }];
  const noGap = normalizeConfig({ x: { ...config.x, minGapMinutes: 0 } });
  assert.equal(nextDue({ platform: 'x', items, history, config: noGap, now: late }).why, 'already posted in this window');

  const soon = [{ platform: 'x', kind: 'post', at: at(12, 59) }];
  assert.equal(nextDue({ platform: 'x', items, history: soon, config, now: at(14, 30) }).why, 'too soon after the last post');

  const three = [9, 13, 16].map((h) => ({ platform: 'x', kind: 'post', at: at(h, 1) }));
  assert.equal(nextDue({ platform: 'x', items, history: three, config, now: at(19, 55) }).why, 'daily cap reached');
});

test('at most one thread a day', () => {
  const items = [approved('t2', 'thread')];
  const history = [{ platform: 'x', kind: 'thread', at: at(9, 5) }];
  assert.equal(nextDue({ platform: 'x', items, history, config, now: at(19, 55) }).item, null);
  assert.match(capCheck({ item: items[0], history, config, now: at(19, 55) }), /thread/);
});

test('oldest approval goes first; retries wait for notBefore', () => {
  const items = [
    approved('new', 'post', '2026-10-27T08:00:00Z'),
    { ...approved('old', 'post', '2026-10-25T08:00:00Z'), notBefore: '2026-10-28T00:00:00Z' },
  ];
  assert.equal(nextDue({ platform: 'x', items, history: [], config, now: at(10, 55) }).item.id, 'new');
});

test('history counts posted items and partly-posted threads', () => {
  const h = historyFrom([
    { platform: 'x', kind: 'post', status: 'posted', postedAt: '2026-10-27T09:00:00Z' },
    { platform: 'x', kind: 'thread', status: 'approved', postedAt: '2026-10-27T10:00:00Z', result: { ids: ['1'] } },
    { platform: 'x', kind: 'post', status: 'failed' },
  ]);
  assert.equal(h.length, 2);
});
