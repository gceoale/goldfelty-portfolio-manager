import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { makeTestDeps, freshToken, tmpHome } from './helpers.js';
import * as x from '../src/platforms/x.js';
import * as reddit from '../src/platforms/reddit.js';
import * as youtube from '../src/platforms/youtube.js';

test('X threads chain each post as a reply to the one before', async () => {
  let id = 100;
  const { deps, calls } = makeTestDeps({
    tokens: { x: freshToken() },
    routes: [{ method: 'POST', match: 'https://api.x.com/2/tweets', reply: () => ({ status: 201, json: { data: { id: String(id++) } } }) }],
  });
  const item = { platform: 'x', kind: 'thread', content: { tweets: ['one', 'two', 'three'] } };
  const out = await x.publish(item, deps);
  assert.deepEqual(out.ids, ['100', '101', '102']);
  assert.equal(out.url, 'https://x.com/i/web/status/100');
  const bodies = calls.map((c) => JSON.parse(c.body));
  assert.equal(bodies[0].reply, undefined);
  assert.equal(bodies[1].reply.in_reply_to_tweet_id, '100');
  assert.equal(bodies[2].reply.in_reply_to_tweet_id, '101');
  assert.equal(calls[0].headers.Authorization, 'Bearer AT');
});

test('a thread that fails partway keeps what posted, and a retry carries on', async () => {
  let n = 0;
  const { deps, calls } = makeTestDeps({
    tokens: { x: freshToken() },
    routes: [
      {
        method: 'POST',
        match: 'https://api.x.com/2/tweets',
        reply: () => (++n === 2 ? { status: 503, json: { detail: 'busy' } } : { status: 201, json: { data: { id: `id${n}` } } }),
      },
    ],
  });
  const item = { platform: 'x', kind: 'thread', content: { tweets: ['one', 'two', 'three'] } };
  const err = await x.publish(item, deps).catch((e) => e);
  assert.equal(err.retryable, true);
  assert.deepEqual(err.partial.ids, ['id1']);
  item.result = err.partial;
  const out = await x.publish(item, deps);
  assert.deepEqual(out.ids, ['id1', 'id3', 'id4']);
  assert.equal(JSON.parse(calls[2].body).text, 'two');
  assert.equal(JSON.parse(calls[2].body).reply.in_reply_to_tweet_id, 'id1');
});

test('an X duplicate-content refusal is not retried', async () => {
  const { deps } = makeTestDeps({
    tokens: { x: freshToken() },
    routes: [{ method: 'POST', match: 'https://api.x.com/2/tweets', reply: () => ({ status: 403, json: { detail: 'You are not allowed to create a Tweet with duplicate content.' } }) }],
  });
  const err = await x.publish({ kind: 'post', content: { text: 'hi' } }, deps).catch((e) => e);
  assert.equal(err.retryable, false);
  assert.match(err.message, /duplicate content/);
});

const redditRoutes = (submitReply) => [
  { method: 'GET', match: 'https://oauth.reddit.com/api/v1/me', reply: () => ({ json: { name: 'gold' } }) },
  {
    method: 'GET',
    match: 'https://oauth.reddit.com/subreddits/mine/moderator',
    reply: () => ({ json: { data: { children: [{ data: { display_name: 'goldfelty' } }], after: null } } }),
  },
  { method: 'POST', match: 'https://oauth.reddit.com/api/submit', reply: submitReply },
];

test('Reddit posts a self post to your profile', async () => {
  const { deps, calls } = makeTestDeps({
    tokens: { reddit: freshToken({ username: 'gold' }) },
    routes: redditRoutes(() => ({ json: { json: { errors: [], data: { name: 't3_abc', url: 'https://www.reddit.com/user/gold/comments/abc/' } } } })),
  });
  const out = await reddit.publish({ kind: 'self', content: { subreddit: 'u_gold', title: 'T', body: 'B' } }, deps);
  assert.equal(out.id, 't3_abc');
  const submit = calls.find((c) => c.url.endsWith('/api/submit'));
  const form = new URLSearchParams(submit.body);
  assert.equal(form.get('sr'), 'u_gold');
  assert.equal(form.get('kind'), 'self');
  assert.equal(form.get('resubmit'), null);
  assert.match(submit.headers['User-Agent'], /by \/u\/gold/);
});

test('Reddit refuses subreddits you do not moderate, even if approved', async () => {
  const { deps, calls } = makeTestDeps({
    tokens: { reddit: freshToken({ username: 'gold' }) },
    routes: redditRoutes(() => ({ json: {} })),
  });
  await assert.rejects(
    reddit.publish({ kind: 'self', content: { subreddit: 'CryptoCurrency', title: 'T', body: 'B' } }, deps),
    /won't post there/,
  );
  assert.ok(!calls.some((c) => c.url.endsWith('/api/submit')));
});

test('Reddit rate limits are retryable, other errors are not', async () => {
  const { deps } = makeTestDeps({
    tokens: { reddit: freshToken({ username: 'gold' }) },
    routes: redditRoutes(() => ({ json: { json: { errors: [['RATELIMIT', 'Take a break for 9 minutes', 'ratelimit']] } } })),
  });
  const err = await reddit.publish({ kind: 'self', content: { subreddit: 'goldfelty', title: 'T', body: 'B' } }, deps).catch((e) => e);
  assert.equal(err.retryable, true);
  assert.match(err.message, /Take a break/);
});

test('YouTube uploads in two steps: start a session, then send the file', async () => {
  const home = tmpHome();
  const file = path.join(home, 'demo.mp4');
  fs.writeFileSync(file, Buffer.alloc(2048, 1));
  const { deps, calls } = makeTestDeps({
    tokens: { youtube: freshToken() },
    routes: [
      {
        method: 'POST',
        match: 'https://www.googleapis.com/upload/youtube/v3/videos',
        reply: () => ({ headers: { Location: 'https://www.googleapis.com/upload/youtube/v3/videos?upload_id=XYZ' }, json: {} }),
      },
      { method: 'PUT', match: 'https://www.googleapis.com/upload/youtube/v3/videos?upload_id=XYZ', reply: () => ({ json: { id: 'vid123' } }) },
    ],
  });
  const out = await youtube.publish(
    { kind: 'video', content: { file, title: 'How to check a download', description: 'Steps.', privacyStatus: 'unlisted' } },
    deps,
  );
  assert.equal(out.url, 'https://youtu.be/vid123');
  assert.equal(calls[0].headers['X-Upload-Content-Length'], '2048');
  assert.equal(calls[0].headers['X-Upload-Content-Type'], 'video/mp4');
  const meta = JSON.parse(calls[0].body);
  assert.equal(meta.status.privacyStatus, 'unlisted');
  assert.equal(meta.status.selfDeclaredMadeForKids, false);
  assert.equal(calls[1].body.size, 2048);
});

test('YouTube refuses files that are not videos', async () => {
  const { deps } = makeTestDeps({ tokens: { youtube: freshToken() } });
  await assert.rejects(youtube.publish({ kind: 'video', content: { file: '/tmp/notes.txt', title: 'T' } }, deps), /isn't a video/);
});
