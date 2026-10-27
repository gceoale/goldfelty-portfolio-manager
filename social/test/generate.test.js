import test from 'node:test';
import assert from 'node:assert/strict';
import Anthropic from '@anthropic-ai/sdk';
import { normalizeConfig } from '../src/config.js';
import { callClaude, generate, toDrafts, buildPrompt, GenerationError } from '../src/generate.js';

const config = normalizeConfig({});
const counts = { xPosts: 3, xThreads: 1, redditPosts: 1, videoScripts: 1 };

function fakeClient(reply) {
  const requests = [];
  return {
    requests,
    beta: {
      messages: {
        create: async (req) => {
          requests.push(req);
          if (reply instanceof Error) throw reply;
          return reply;
        },
      },
    },
  };
}

const plan = {
  x_posts: [
    { text: 'Goldfelty never holds your keys. Your wallet approves every transfer and signature.', basis: 'Safety' },
    { text: 'Thanks @someone for the idea!', basis: 'none' },
    { text: 'x'.repeat(300), basis: 'none' },
    { text: 'An extra fourth post that should be cut by the count.', basis: 'none' },
  ],
  x_threads: [{ tweets: ['How to check a Goldfelty download, step by step:', 'Every release has SHA256SUMS.txt.', 'Run shasum -a 256 -c.'], basis: 'Safety: checksums' }],
  reddit_posts: [{ title: 'Tracking a wallet that can’t connect', body: 'Some wallets, like Exodus desktop, don’t let other apps ask them to sign...', basis: 'Wallets' }],
  video_scripts: [{ title: 'Connect MetaMask to Goldfelty', script: '[Open the app] ...', description: 'How to connect. https://goldfelty.com', basis: 'Wallets' }],
};

const ok = (obj) => ({ stop_reason: 'end_turn', content: [{ type: 'text', text: JSON.stringify(obj) }] });

test('the request uses the current model, structured output and refusal fallbacks', async () => {
  const client = fakeClient(ok(plan));
  await callClaude(client, { model: config.model, effort: config.effort, system: 'S', prompt: 'P' });
  const req = client.requests[0];
  assert.equal(req.model, 'claude-opus-5-5');
  assert.deepEqual(req.betas, ['server-side-fallback-2026-07-01']);
  assert.equal(req.fallbacks, 'default');
  assert.equal(req.output_config.effort, 'medium');
  assert.equal(req.output_config.format.type, 'json_schema');
  assert.equal(req.thinking, undefined);
  assert.equal(req.messages.at(-1).role, 'user');
});

test('rule-breaking drafts are dropped with a reason, the rest queued', async () => {
  const client = fakeClient(ok(plan));
  const { drafts, dropped } = await generate({ client, config, facts: 'F', queue: { items: [] }, counts, redditUser: 'gold' });
  assert.deepEqual(
    drafts.map((d) => `${d.platform}/${d.kind}`),
    ['x/post', 'x/thread', 'reddit/self', 'youtube/script'],
  );
  assert.equal(drafts[2].content.subreddit, 'u_gold');
  assert.equal(dropped.length, 2);
  assert.match(dropped.map((d) => d.reason).join(' '), /mentions someone/);
  assert.match(dropped.map((d) => d.reason).join(' '), /characters/);
});

test('drafts that repeat recent posts are dropped', () => {
  const recent = ['Goldfelty never holds your keys. Your wallet approves every transfer and signature.'];
  const { drafts, dropped } = toDrafts({ x_posts: [plan.x_posts[0]], x_threads: [], reddit_posts: [], video_scripts: [] }, { recent, counts, redditTarget: 'u_gold' });
  assert.equal(drafts.length, 0);
  assert.match(dropped[0].reason, /recent/);
});

test('recent posts are passed to Claude so it covers new ground', () => {
  const p = buildPrompt({ facts: 'FACTS', recent: ['old post'], counts, focus: 'the 1.2.2 release' });
  assert.match(p, /<facts>\nFACTS\n<\/facts>/);
  assert.match(p, /- old post/);
  assert.match(p, /Focus this batch on: the 1.2.2 release/);
});

test('a refusal is reported, not parsed', async () => {
  const client = fakeClient({ stop_reason: 'refusal', stop_details: { explanation: 'no' }, content: [] });
  await assert.rejects(callClaude(client, { model: 'm', effort: 'medium', system: 'S', prompt: 'P' }), (e) => e instanceof GenerationError && /declined/.test(e.message));
});

test('a cut-off reply is reported', async () => {
  const client = fakeClient({ stop_reason: 'max_tokens', content: [{ type: 'text', text: '{"x_po' }] });
  await assert.rejects(callClaude(client, { model: 'm', effort: 'medium', system: 'S', prompt: 'P' }), /cut off/);
});

test('API errors become plain messages', async () => {
  const err = new Anthropic.RateLimitError(429, { type: 'error', error: { type: 'rate_limit_error', message: 'slow down' } }, 'slow down', new Headers());
  const client = fakeClient(err);
  await assert.rejects(callClaude(client, { model: 'm', effort: 'medium', system: 'S', prompt: 'P' }), /rate limit/);
});
