// Images, alternative openings, and learning from how posts did.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { tmpHome, makeTestDeps, freshToken } from './helpers.js';
import { normalizeConfig } from '../src/config.js';
import { saveQueue, loadQueue, addItems, useAlternative, setImages, approve } from '../src/queue.js';
import { score, learnings, byWindow } from '../src/metrics.js';
import { toDrafts, buildPrompt } from '../src/generate.js';
import * as x from '../src/platforms/x.js';
import * as app from '../src/app.js';

const home = tmpHome();

test('images are uploaded and attached to the first post of a thread', async () => {
  const img = path.join(home, 'shot.png');
  fs.writeFileSync(img, Buffer.alloc(1000, 7));
  let tweet = 0;
  const { deps, calls } = makeTestDeps({
    tokens: { x: freshToken() },
    routes: [
      { method: 'POST', match: 'https://api.x.com/2/media/upload/initialize', reply: () => ({ json: { data: { id: 'M1' } } }) },
      { method: 'POST', match: 'https://api.x.com/2/media/upload/M1/append', reply: () => ({ status: 204, text: '' }) },
      { method: 'POST', match: 'https://api.x.com/2/media/upload/M1/finalize', reply: () => ({ json: { data: { id: 'M1' } } }) },
      { method: 'POST', match: 'https://api.x.com/2/tweets', reply: () => ({ status: 201, json: { data: { id: `T${++tweet}` } } }) },
    ],
  });
  await x.publish({ kind: 'thread', content: { tweets: ['first', 'second'], images: [img] } }, deps);
  const init = JSON.parse(calls[0].body);
  assert.deepEqual(init, { media_type: 'image/png', total_bytes: 1000, media_category: 'tweet_image' });
  assert.ok(calls[1].body instanceof FormData);
  assert.equal(calls[1].body.get('segment_index'), '0');
  assert.equal(calls[1].body.get('media').size, 1000);
  const posts = calls.filter((c) => c.url.endsWith('/2/tweets')).map((c) => JSON.parse(c.body));
  assert.deepEqual(posts[0].media, { media_ids: ['M1'] });
  assert.equal(posts[1].media, undefined);
});

test('more than 4 images, or non-images, are refused', () => {
  const q = { items: [] };
  const [item] = addItems(q, [{ platform: 'x', kind: 'post', content: { text: 'A post with pictures.' } }]).added;
  assert.throws(() => setImages(item, ['a', 'b', 'c', 'd', 'e']), /at most 4/);
  const { deps } = makeTestDeps();
  saveQueue(q);
  fs.writeFileSync(path.join(home, 'notes.txt'), 'x');
  assert.throws(() => app.attachImages(item.id, [path.join(home, 'notes.txt')], deps), /isn't a PNG/);
});

test('changing images sends an approved post back to review', () => {
  const q = { items: [] };
  const [item] = addItems(q, [{ platform: 'x', kind: 'post', content: { text: 'Approved, then given a picture.' } }]).added;
  approve(item);
  setImages(item, ['/tmp/a.png']);
  assert.equal(item.status, 'draft');
});

test('picking another opening keeps the old one as an option', () => {
  const q = { items: [] };
  const [item] = addItems(q, [
    { platform: 'x', kind: 'post', content: { text: 'Original opening.' }, alternatives: ['Sharper opening.', 'Another angle.'] },
  ]).added;
  useAlternative(item, 0);
  assert.equal(item.content.text, 'Sharper opening.');
  assert.deepEqual(item.alternatives, ['Another angle.', 'Original opening.']);
  assert.throws(() => useAlternative(item, 5), /No such/);
});

test('alternatives that break the rules are dropped from drafts', () => {
  const plan = {
    x_posts: [{ text: 'Main version of a post.', alternatives: ['Good alternative.', 'Bad one @someone', 'y'.repeat(300)], basis: 'b' }],
    x_threads: [],
    reddit_posts: [],
    video_scripts: [],
  };
  const { drafts } = toDrafts(plan, { recent: [], counts: { xPosts: 1, xThreads: 0, redditPosts: 0, videoScripts: 0 }, redditTarget: 'u_g' });
  assert.deepEqual(drafts[0].alternatives, ['Good alternative.']);
});

const posted = (id, text, metrics, postedAt = '2026-10-20T10:00:00') => ({
  id,
  platform: 'x',
  kind: 'post',
  status: 'posted',
  postedAt: new Date(postedAt).toISOString(),
  content: { text },
  result: { ids: [`tw${id}`] },
  metrics,
});

test('reposts and replies count more than likes', () => {
  assert.ok(score({ likes: 0, reposts: 2, replies: 0 }) > score({ likes: 5, reposts: 0, replies: 0 }));
  assert.equal(score(undefined), 0);
});

test('the prompt learns from the best and weakest posts once there are enough', () => {
  const few = [posted('1', 'a', { likes: 1, reposts: 0, replies: 0 })];
  assert.deepEqual(learnings(few), []);
  const many = [
    posted('1', 'How to check a download in 3 commands', { likes: 40, reposts: 12, replies: 6 }),
    posted('2', 'We shipped 1.2.2', { likes: 3, reposts: 0, replies: 0 }),
    posted('3', 'Myth: a portfolio app needs your seed phrase', { likes: 25, reposts: 8, replies: 9 }),
    posted('4', 'New version available', { likes: 1, reposts: 0, replies: 0 }),
    posted('5', 'Goldfelty is free', { likes: 2, reposts: 0, replies: 1 }),
  ];
  const [l] = learnings(many);
  assert.match(l.best[0], /check a download/);
  assert.match(l.worst.join('\n'), /New version available/);
  const prompt = buildPrompt({ facts: 'F', recent: [], counts: { xPosts: 1, xThreads: 0, redditPosts: 0, videoScripts: 0 }, lessons: [l] });
  assert.match(prompt, /<how_recent_posts_did>/);
  assert.match(prompt, /12 reposts/);
});

test('numbers are read from X and Reddit and stored on the posts', async () => {
  saveQueue({
    items: [
      posted('a', 'An X post', undefined, '2026-10-26T10:00:00'),
      { ...posted('b', 'A Reddit post', undefined, '2026-10-26T10:30:00'), platform: 'reddit', kind: 'self', content: { title: 'T', body: 'B' }, result: { id: 't3_b' } },
      posted('old', 'Too old to check', undefined, '2026-08-01T10:00:00'),
    ],
  });
  const { deps, calls } = makeTestDeps({
    tokens: { x: freshToken(), reddit: freshToken({ username: 'gold' }) },
    routes: [
      { method: 'GET', match: 'https://api.x.com/2/tweets?ids=twa', reply: () => ({ json: { data: [{ id: 'twa', public_metrics: { like_count: 9, retweet_count: 2, quote_count: 1, reply_count: 3, impression_count: 800 } }] } }) },
      { method: 'GET', match: 'https://oauth.reddit.com/api/info?id=t3_b', reply: () => ({ json: { data: { children: [{ data: { name: 't3_b', score: 14, num_comments: 5 } }] } } }) },
    ],
  });
  const out = await app.refreshNumbers(deps);
  assert.equal(out.updated, 2);
  assert.deepEqual(out.errors, []);
  assert.equal(calls.length, 2);
  const items = loadQueue().items;
  assert.deepEqual({ ...items[0].metrics, fetchedAt: undefined }, { likes: 9, reposts: 3, replies: 3, views: 800, fetchedAt: undefined });
  assert.equal(items[1].metrics.likes, 14);
  assert.equal(items[2].metrics, undefined);

  // A second refresh within six hours reads nothing.
  const again = await app.refreshNumbers(deps);
  assert.equal(again.updated, 0);
});

test('scores are averaged per posting window', () => {
  const config = normalizeConfig({});
  const items = [
    posted('1', 'a', { likes: 10, reposts: 0, replies: 0 }, '2026-10-20T09:30:00'),
    posted('2', 'b', { likes: 20, reposts: 0, replies: 0 }, '2026-10-21T09:45:00'),
    posted('3', 'c', { likes: 2, reposts: 0, replies: 0 }, '2026-10-21T18:30:00'),
  ];
  const w = byWindow(items, config).x;
  assert.deepEqual(w[0], { window: '09:00-11:00', posts: 2, average: 15 });
  assert.deepEqual(w[2], { window: '18:00-20:00', posts: 1, average: 2 });
  assert.equal(w[1].average, null);
});
