import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { tmpHome, makeTestDeps, freshToken } from './helpers.js';
import { normalizeConfig } from '../src/config.js';
import { saveQueue, loadQueue, addItems } from '../src/queue.js';
import { stockNeeds, applyReviews, autopilotStep, loadState, saveState, setPaused, videoInbox } from '../src/autopilot.js';
import { launchdPlist, systemdUnit, command } from '../src/service.js';
import * as app from '../src/app.js';

const home = tmpHome();
fs.writeFileSync(path.join(home, 'facts.md'), 'Goldfelty is a free desktop app.');

const reset = (items = []) => {
  saveQueue({ items });
  saveState({ paused: false, lastGeneratedAt: null, lastError: null });
};

// A stand-in for the Anthropic client that answers each kind of request.
function fakeClient({ reviews = (drafts) => drafts.map((d) => ({ id: d.id, publish: true, choice: 0, reason: 'fine' })) } = {}) {
  const requests = [];
  let n = 0;
  return {
    requests,
    beta: {
      messages: {
        create: async (req) => {
          requests.push(req);
          const required = req.output_config.format.schema.required;
          let body;
          if (required.includes('reviews')) {
            const drafts = JSON.parse(/<drafts>\n([\s\S]*)\n<\/drafts>/.exec(req.messages[0].content)[1]);
            body = { reviews: reviews(drafts) };
          } else if (required.includes('title')) {
            body = { title: 'Checking a download, start to finish', description: 'A walkthrough. https://goldfelty.com' };
          } else {
            const topics = ['keys', 'checksums', 'Frame', 'Ledger', 'Solana', 'Tron', 'Bitcoin', 'Exodus', 'fees', 'locking'];
            body = {
              x_posts: topics.map((t) => ({ text: `Unique point number ${++n} about ${t} handling in Goldfelty.`, alternatives: [`Sharper take ${n} on ${t}.`], basis: t })),
              x_threads: [{ tweets: ['How Goldfelty locks itself:', 'After idle time.', 'On sleep and screen lock.'], basis: 'locking' }],
              reddit_posts: [{ title: 'Why the app never asks for a seed phrase', body: 'Long explanation of wallet approvals.', basis: 'safety' }, { title: 'Tracking Exodus read-only', body: 'How read-only address tracking works.', basis: 'wallets' }, { title: 'Checking release checksums', body: 'Steps to verify SHA256SUMS.', basis: 'safety' }],
              video_scripts: [],
            };
          }
          return { stop_reason: 'end_turn', content: [{ type: 'text', text: JSON.stringify(body) }] };
        },
      },
    },
  };
}

const connectedTokens = { x: freshToken({ username: 'goldfelty' }), reddit: freshToken({ username: 'gold', moderated: [] }) };

test('stock needs: two days of posts per connected platform', () => {
  const config = normalizeConfig({});
  const none = stockNeeds([], config, { x: true, reddit: true, youtube: false });
  assert.deepEqual(none, { xPosts: 5, xThreads: 1, redditPosts: 2, videoScripts: 0 });
  const items = [
    ...Array.from({ length: 6 }, (_, i) => ({ platform: 'x', kind: i ? 'post' : 'thread', status: 'approved' })),
    { platform: 'reddit', kind: 'self', status: 'approved' },
  ];
  assert.deepEqual(stockNeeds(items, config, { x: true, reddit: true }), { xPosts: 0, xThreads: 0, redditPosts: 1, videoScripts: 0 });
  assert.deepEqual(stockNeeds([], config, { x: false, reddit: false }), { xPosts: 0, xThreads: 0, redditPosts: 0, videoScripts: 0 });
});

test('reviews pick the stronger opening, approve, and reject with a reason', () => {
  const q = { items: [] };
  const [a, b, c] = addItems(q, [
    { platform: 'x', kind: 'post', content: { text: 'Main text here.' }, alternatives: ['Better opening here.'] },
    { platform: 'x', kind: 'post', content: { text: 'Claims an audit happened.' } },
    { platform: 'reddit', kind: 'self', content: { subreddit: 'CryptoCurrency', title: 'T', body: 'Body text.' } },
  ]).added;
  const out = applyReviews(
    q,
    [
      { id: a.id, publish: true, choice: 1, reason: 'clear and specific' },
      { id: b.id, publish: false, choice: 0, reason: 'claims an audit; the facts say none' },
      { id: c.id, publish: true, choice: 0, reason: 'fine' },
    ],
    { allowedReddit: ['u_gold'], now: new Date() },
  );
  assert.equal(a.status, 'approved');
  assert.equal(a.content.text, 'Better opening here.');
  assert.equal(b.status, 'rejected');
  assert.match(b.note, /audit/);
  // Someone else's subreddit is never auto-posted, whatever the review says.
  assert.equal(c.status, 'rejected');
  assert.equal(out.approved.length, 1);
});

test('autopilot writes, reviews and approves a batch by itself', async () => {
  reset();
  const { deps } = makeTestDeps({ tokens: connectedTokens });
  const client = fakeClient();
  const report = await autopilotStep(deps, { app, client });
  assert.ok(report.generated > 0);
  assert.equal(report.approved, report.generated);
  const items = loadQueue().items;
  assert.ok(items.every((i) => i.status === 'approved' && i.source === 'autopilot'));
  assert.ok(items.some((i) => i.kind === 'thread'));
  assert.ok(items.filter((i) => i.platform === 'reddit').every((i) => i.content.subreddit === 'u_gold'));
  // Generation, then review at high effort.
  assert.equal(client.requests.length, 2);
  assert.equal(client.requests[1].output_config.effort, 'high');
});

test('autopilot writes at most every 12 hours, and not when stocked', async () => {
  reset();
  const { deps, clock } = makeTestDeps({ tokens: connectedTokens });
  const client = fakeClient({ reviews: (drafts) => drafts.map((d) => ({ id: d.id, publish: false, choice: 0, reason: 'dull' })) });
  await autopilotStep(deps, { app, client });
  assert.equal(client.requests.length, 2);
  clock.t += 60 * 60_000;
  await autopilotStep(deps, { app, client });
  assert.equal(client.requests.length, 2);
  clock.t += 12 * 60 * 60_000;
  await autopilotStep(deps, { app, client });
  assert.equal(client.requests.length, 4);
  assert.ok(loadQueue().items.every((i) => i.status === 'rejected'));
});

test('pausing stops autopilot', async () => {
  reset();
  setPaused(true);
  const { deps } = makeTestDeps({ tokens: connectedTokens });
  const client = fakeClient();
  assert.deepEqual(await autopilotStep(deps, { app, client }), { paused: true });
  assert.equal(client.requests.length, 0);
  setPaused(false);
  assert.equal(loadState().paused, false);
});

test('videos dropped in the inbox are titled and queued for YouTube', async () => {
  reset();
  const file = path.join(videoInbox(), 'check-download.mp4');
  fs.writeFileSync(file, Buffer.alloc(100));
  fs.writeFileSync(file.replace('.mp4', '.txt'), 'Shows shasum -a 256 -c on the 1.2.2 release.');
  const old = new Date(Date.now() - 10 * 60_000);
  fs.utimesSync(file, old, old);
  const { deps } = makeTestDeps({ tokens: { youtube: freshToken({ username: 'Goldfelty' }) }, now: Date.now() });
  const client = fakeClient();
  const report = await autopilotStep(deps, { app, client });
  assert.equal(report.videos, 1);
  const [item] = loadQueue().items;
  assert.equal(item.kind, 'video');
  assert.equal(item.status, 'approved');
  assert.equal(item.content.title, 'Checking a download, start to finish');
  assert.match(client.requests[0].messages[0].content, /shasum -a 256/);
  // Not queued twice.
  await autopilotStep(deps, { app, client });
  assert.equal(loadQueue().items.length, 1);
});

test('a video still being copied is left alone', async () => {
  reset();
  fs.writeFileSync(path.join(videoInbox(), 'fresh.mov'), Buffer.alloc(10));
  const { deps } = makeTestDeps({ tokens: { youtube: freshToken() }, now: Date.now(), config: { video: { auto: false } } });
  const report = await autopilotStep(deps, { app, client: fakeClient() });
  assert.ok(!loadQueue().items.some((i) => i.content.file?.endsWith('fresh.mov')));
  assert.ok(report.videos <= 1);
});

test('background service files run autopilot live and restart it', () => {
  const args = command();
  assert.deepEqual(args.slice(-4), ['run', '--live', '--auto', '--no-ui']);
  const plist = launchdPlist({ args: ['/usr/bin/node', '/a b/bin.js', 'run'], home: '/h' });
  assert.match(plist, /<key>KeepAlive<\/key><true\/>/);
  assert.match(plist, /<key>RunAtLoad<\/key><true\/>/);
  assert.match(plist, /<string>\/a b\/bin.js<\/string>/);
  assert.match(plist, /<key>GOLDFELTY_SOCIAL_HOME<\/key><string>\/h<\/string>/);
  const unit = systemdUnit({ args: ['/usr/bin/node', '/a b/bin.js', 'run'], home: '/h' });
  assert.match(unit, /ExecStart="\/usr\/bin\/node" "\/a b\/bin.js" "run"/);
  assert.match(unit, /Restart=always/);
});
