import test from 'node:test';
import assert from 'node:assert/strict';
import {
  addItems,
  approve,
  reject,
  restore,
  edit,
  markDone,
  problems,
  findItem,
  recoverInterrupted,
  redditTarget,
} from '../src/queue.js';

const post = (text) => ({ platform: 'x', kind: 'post', content: { text } });

test('new items arrive as drafts', () => {
  const q = { items: [] };
  const { added } = addItems(q, [post('One thing about wallets.')]);
  assert.equal(added[0].status, 'draft');
  assert.equal(q.items.length, 1);
});

test('repeats of queued items are skipped', () => {
  const q = { items: [] };
  addItems(q, [post('Goldfelty shows every wallet you use in one place, free.')]);
  const { added, skipped } = addItems(q, [post('Goldfelty shows every wallet you use in one place, for free.')]);
  assert.equal(added.length, 0);
  assert.equal(skipped.length, 1);
});

test('rule-breaking X posts cannot be approved', () => {
  assert.match(problems(post('x'.repeat(281))).join(), /281 characters/);
  assert.match(problems(post('hi @friend')).join(), /mentions someone/);
  assert.match(problems(post('#a #b #c')).join(), /more than 2 hashtags/);
  assert.match(problems({ platform: 'x', kind: 'thread', content: { tweets: ['only one'] } }).join(), /2 to 8/);
  const q = { items: [] };
  const [item] = addItems(q, [post('hi @friend')]).added;
  assert.throws(() => approve(item), /mentions someone/);
  assert.equal(item.status, 'draft');
});

test('Reddit posts go out only to your profile or subreddits you moderate', () => {
  const q = { items: [] };
  const [own, other] = addItems(q, [
    { platform: 'reddit', kind: 'self', content: { subreddit: 'u_gold', title: 'How tracking works', body: 'A body about tracking addresses read-only.' } },
    { platform: 'reddit', kind: 'self', content: { subreddit: 'r/CryptoCurrency', title: 'Release notes', body: 'Something else entirely about checksums.' } },
  ]).added;
  approve(own, { allowedReddit: ['u_gold', 'goldfelty'] });
  approve(other, { allowedReddit: ['u_gold', 'goldfelty'] });
  assert.equal(own.status, 'approved');
  assert.equal(other.status, 'manual');
  assert.equal(other.content.subreddit, 'CryptoCurrency');
  assert.match(other.note, /won't post there/);
});

test('scripts become manual work, never auto-posted', () => {
  const q = { items: [] };
  const [s] = addItems(q, [{ platform: 'youtube', kind: 'script', content: { title: 'T', script: 'S', description: 'D' } }]).added;
  approve(s);
  assert.equal(s.status, 'manual');
  markDone(s, 'https://youtu.be/abc');
  assert.equal(s.status, 'done');
});

test('editing an approved item sends it back to review', () => {
  const q = { items: [] };
  const [item] = addItems(q, [post('Version 1.2.2 is out.')]).added;
  approve(item);
  edit(item, { text: 'Version 1.2.2 is out, with wallet fixes.' });
  assert.equal(item.status, 'draft');
  assert.equal(item.content.text, 'Version 1.2.2 is out, with wallet fixes.');
});

test('reject and restore', () => {
  const q = { items: [] };
  const [item] = addItems(q, [post('A post.')]).added;
  reject(item);
  assert.equal(item.status, 'rejected');
  restore(item);
  assert.equal(item.status, 'draft');
  item.status = 'posted';
  assert.throws(() => reject(item));
});

test('items found by id prefix', () => {
  const q = { items: [{ id: 'abc123' }, { id: 'abd456' }] };
  assert.equal(findItem(q, 'abc').id, 'abc123');
  assert.throws(() => findItem(q, 'ab'), /more than one/);
  assert.throws(() => findItem(q, 'zz'), /No item/);
});

test('interrupted posts become failed, not retried blindly', () => {
  const q = { items: [{ id: 'a', status: 'posting' }, { id: 'b', status: 'approved' }] };
  assert.equal(recoverInterrupted(q), 1);
  assert.equal(q.items[0].status, 'failed');
  assert.equal(q.items[1].status, 'approved');
});

test('subreddit names are normalised', () => {
  assert.equal(redditTarget('r/goldfelty'), 'goldfelty');
  assert.equal(redditTarget('/u/someone'), 'u_someone');
  assert.equal(redditTarget(' u_x '), 'u_x');
});
