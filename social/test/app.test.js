import test from 'node:test';
import assert from 'node:assert/strict';
import { tmpHome, makeTestDeps, freshToken } from './helpers.js';
import { saveQueue, loadQueue, addItems } from '../src/queue.js';
import * as app from '../src/app.js';

tmpHome();

function seed(items) {
  const q = { items: [] };
  const { added } = addItems(q, items, new Date('2026-10-27T08:00:00Z'));
  saveQueue(q);
  return added;
}

const xRoute = (reply) => ({ method: 'POST', match: 'https://api.x.com/2/tweets', reply });

test('approve then post marks the item posted with its link', async () => {
  const [item] = seed([{ platform: 'x', kind: 'post', content: { text: 'Version 1.2.2 is out.' } }]);
  const { deps } = makeTestDeps({ tokens: { x: freshToken() }, routes: [xRoute(() => ({ status: 201, json: { data: { id: '42' } } }))] });
  app.approveItem(item.id, deps);
  const out = await app.postNow(item.id, deps);
  assert.equal(out.status, 'posted');
  assert.equal(out.result.url, 'https://x.com/i/web/status/42');
  assert.equal(loadQueue().items[0].status, 'posted');
});

test('drafts cannot be posted, approved or not', async () => {
  const [item] = seed([{ platform: 'x', kind: 'post', content: { text: 'Not approved yet.' } }]);
  const { deps } = makeTestDeps({ tokens: { x: freshToken() } });
  await assert.rejects(app.postNow(item.id, deps), /Only approved/);
});

test('a temporary failure stays approved for a later retry; a third failure gives up', async () => {
  const [item] = seed([{ platform: 'x', kind: 'post', content: { text: 'Retry me.' } }]);
  const { deps } = makeTestDeps({ tokens: { x: freshToken() }, routes: [xRoute(() => ({ status: 503, json: {} }))] });
  app.approveItem(item.id, deps);
  let out = await app.publishOne(item.id, deps);
  assert.equal(out.status, 'approved');
  assert.ok(out.notBefore);
  out = await app.publishOne(item.id, deps);
  out = await app.publishOne(item.id, deps);
  assert.equal(out.status, 'failed');
  assert.equal(out.attempts, 3);
});

test('a lost sign-in keeps the item approved and says how to fix it', async () => {
  const [item] = seed([{ platform: 'x', kind: 'post', content: { text: 'Waiting for a sign-in.' } }]);
  const { deps } = makeTestDeps({ tokens: {} });
  app.approveItem(item.id, deps);
  const out = await app.publishOne(item.id, deps);
  assert.equal(out.status, 'approved');
  assert.match(out.error, /connect x/);
});

test('the daily cap holds for "post now" too', async () => {
  const items = seed(
    [
      'Goldfelty never holds keys.',
      'Checksums ship with every release.',
      'Track Exodus balances read-only.',
      'Sending shows both fees first.',
    ].map((text) => ({ platform: 'x', kind: 'post', content: { text } })),
  );
  assert.equal(items.length, 4);
  let id = 0;
  const { deps } = makeTestDeps({ tokens: { x: freshToken() }, routes: [xRoute(() => ({ status: 201, json: { data: { id: String(++id) } } }))] });
  for (const i of items) app.approveItem(i.id, deps);
  for (const i of items.slice(0, 3)) await app.postNow(i.id, deps);
  await assert.rejects(app.postNow(items[3].id, deps), /cap \(3\) is used up/);
});

test('a dry run posts nothing but respects caps as if it had', async () => {
  const items = seed(
    ['Frame works with Ledger and Trezor.', 'Solana wallets connect through the Wallet Standard.'].map((text) => ({
      platform: 'x',
      kind: 'post',
      content: { text },
    })),
  );
  assert.equal(items.length, 2);
  // 10:55 local time is inside the first window, after its target minute.
  const local = new Date(2026, 9, 27, 10, 55).getTime();
  const { deps, calls, logs } = makeTestDeps({ tokens: {}, now: local });
  for (const i of items) app.approveItem(i.id, deps);
  const dryHistory = [];
  await app.tick(deps, { live: false, dryHistory });
  await app.tick(deps, { live: false, dryHistory });
  assert.equal(calls.length, 0);
  assert.equal(dryHistory.length, 1);
  assert.match(logs.join('\n'), /\[dry run\] Would post/);
  assert.ok(loadQueue().items.every((i) => i.status === 'approved'));
});

test('Reddit drafts written before connecting get your profile on approval', () => {
  const [item] = seed([{ platform: 'reddit', kind: 'self', content: { subreddit: 'u_YOUR_USERNAME', title: 'T', body: 'Body text here.' } }]);
  const { deps } = makeTestDeps({ tokens: { reddit: freshToken({ username: 'gold', moderated: [] }) } });
  const out = app.approveItem(item.id, deps);
  assert.equal(out.content.subreddit, 'u_gold');
  assert.equal(out.status, 'approved');
});
