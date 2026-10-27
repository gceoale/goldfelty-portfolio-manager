// The cloud runner against the real Worker code (api/src), on SQLite, with
// X and Claude mocked: connect from the dashboard, run, post, look.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { trimQueue, secretsIn, applyRemovals } from '../src/cloud.js';

const ADMIN = 'owner-admin-token-for-tests-123';
let worker;
let DatabaseSync;
try {
  ({ default: worker } = await import('../../api/src/worker.js'));
  ({ DatabaseSync } = await import('node:sqlite'));
} catch {
  worker = null;
}

function fakeD1() {
  const db = new DatabaseSync(':memory:');
  db.exec(fs.readFileSync(new URL('../../api/schema.sql', import.meta.url), 'utf8'));
  return {
    raw: db,
    prepare(sql) {
      let args = [];
      const stmt = db.prepare(sql);
      return {
        bind(...v) { args = v; return this; },
        async first() { return stmt.get(...args) ?? null; },
        async run() { stmt.run(...args); return { success: true }; },
        async all() { return { results: stmt.all(...args) }; },
      };
    },
  };
}

function claude() {
  let n = 0;
  return {
    beta: {
      messages: {
        create: async (req) => {
          const required = req.output_config.format.schema.required;
          let body;
          if (required.includes('reviews')) {
            const drafts = JSON.parse(/<drafts>\n([\s\S]*)\n<\/drafts>/.exec(req.messages[0].content)[1]);
            body = { reviews: drafts.map((d) => ({ id: d.id, publish: true, choice: 0, reason: 'clear' })) };
          } else {
            const texts = [
              'Your keys never leave your wallet.',
              'Every release ships with SHA-256 checksums.',
              'Frame connects Ledger and Trezor too.',
              'Solana wallets join through the Wallet Standard.',
              'Tron balances count in the total.',
              'Exodus can be tracked read-only by address.',
              'The send review lists both fees first.',
              'It locks itself when your screen locks.',
            ];
            body = {
              x_posts: texts.map((t) => ({ text: `${t} (${++n})`, alternatives: [], basis: 'facts' })),
              x_threads: [{ tweets: ['How locking works:', 'After idle time.', 'On sleep.'], basis: 'locking' }],
              reddit_posts: [],
              video_scripts: [],
            };
          }
          return { stop_reason: 'end_turn', content: [{ type: 'text', text: JSON.stringify(body) }] };
        },
      },
    },
  };
}

test('cloud helpers', () => {
  const items = Array.from({ length: 320 }, (_, i) => ({ id: `p${i}`, status: 'posted', updatedAt: new Date(2026, 0, 1, 0, i).toISOString() }));
  items.push({ id: 'next', status: 'approved' });
  const kept = trimQueue(items);
  assert.equal(kept.length, 301);
  assert.ok(kept.some((i) => i.id === 'next'));
  assert.ok(!kept.some((i) => i.id === 'p0'));
  assert.deepEqual(secretsIn({ config: { anthropicApiKey: 'sk-ant-123456', x: { clientSecret: 'shh' } }, tokens: { x: { access_token: 'AAAAAAA' } } }), ['sk-ant-123456', 'AAAAAAA']);
  const q = { items: [{ id: 'a', status: 'approved' }, { id: 'b', status: 'posted' }] };
  assert.equal(applyRemovals(q, ['a', 'b']), 1);
  assert.equal(q.items[0].status, 'rejected');
});

test('end to end: connect on the dashboard, the cloud run writes, checks and posts', { skip: !worker && 'api dependencies not installed' }, async (t) => {
  const { cloudRun } = await import('../src/cloud.js');
  const env = { DB: fakeD1(), ADMIN_TOKEN: ADMIN };
  const tweets = [];
  let tokenCalls = 0;
  const NOW = Date.parse('2026-10-27T10:55:00Z');
  const fetchImpl = async (url, init = {}) => {
    const u = String(url);
    if (u.startsWith('https://api.goldfelty.com/')) {
      return worker.fetch(new Request(u, { ...init, headers: { 'cf-connecting-ip': '9.9.9.9', ...(init.headers || {}) } }), env);
    }
    if (u === 'https://api.x.com/2/oauth2/token') {
      tokenCalls++;
      return Response.json({ access_token: `AT${tokenCalls}`, refresh_token: `RT${tokenCalls}`, expires_in: 7200 });
    }
    if (u === 'https://api.x.com/2/users/me') return Response.json({ data: { username: 'goldfelty' } });
    if (u === 'https://api.x.com/2/tweets' && init.method === 'POST') {
      tweets.push(JSON.parse(init.body));
      return Response.json({ data: { id: String(1000 + tweets.length) } }, { status: 201 });
    }
    throw new Error(`unexpected ${init.method || 'GET'} ${u}`);
  };
  // The Worker calls the platforms with the global fetch.
  const realFetch = globalThis.fetch;
  globalThis.fetch = fetchImpl;
  t.after(() => {
    globalThis.fetch = realFetch;
  });
  const dash = async (method, p, body) => {
    const res = await fetchImpl(`https://api.goldfelty.com/v1/admin/social${p}`, {
      method,
      headers: { authorization: `Bearer ${ADMIN}`, ...(body ? { 'content-type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    return res.json();
  };

  // Nothing set up yet: the run says so and does nothing.
  const home = () => fs.mkdtempSync(path.join(os.tmpdir(), 'gs-cloud-'));
  let out = await cloudRun({ token: ADMIN, fetchImpl, log: () => {}, now: () => NOW, home: home(), mask: false });
  assert.deepEqual(out.summary, ['waiting for accounts']);

  // The owner sets keys and connects X from the dashboard.
  await dash('PUT', '/config', { set: { anthropicApiKey: 'sk-ant-test-key', 'x.clientId': 'cid', timezone: 'UTC' } });
  const link = new URL((await dash('POST', '/connect/x')).url);
  const cb = await fetchImpl(`https://api.goldfelty.com/v1/social/callback/x?state=${link.searchParams.get('state')}&code=abc`);
  assert.match(cb.headers.get('location'), /connected=goldfelty/);

  out = await cloudRun({ token: ADMIN, fetchImpl, log: () => {}, now: () => NOW, home: home(), client: claude(), mask: false });
  assert.equal(out.ok, true, out.lines.join('\n'));
  assert.match(out.summary.join(' '), /posted x/);
  assert.match(out.summary.join(' '), /wrote \d+, approved \d+/);
  assert.equal(tweets.length >= 1, true);

  let view = await dash('GET', '');
  assert.equal(view.connections.x.username, 'goldfelty');
  assert.equal(view.queue.posted.length, 1);
  assert.match(view.queue.posted[0].url, /x\.com\/i\/web\/status\/1001/);
  assert.ok(view.queue.upcoming.length >= 4);
  assert.equal(view.runs.at(-1).ok, true);
  assert.ok(view.facts.includes('Goldfelty'), 'default facts were uploaded for the owner to edit');

  // Same window again: one post per window, nothing more goes out.
  out = await cloudRun({ token: ADMIN, fetchImpl, log: () => {}, now: () => NOW + 60_000, home: home(), client: claude(), mask: false });
  assert.equal(tweets.length, 1);

  // The owner pulls the next item and pauses; the next window posts nothing.
  const next = view.queue.upcoming[0];
  await dash('POST', `/items/${next.id}/remove`);
  await dash('POST', '/pause');
  const LATER = Date.parse('2026-10-27T14:55:00Z');
  out = await cloudRun({ token: ADMIN, fetchImpl, log: () => {}, now: () => LATER, home: home(), client: claude(), mask: false });
  assert.deepEqual(out.summary.filter((s) => s !== '1 removed'), ['paused']);
  assert.equal(tweets.length, 1);
  view = await dash('GET', '');
  assert.ok(view.queue.turnedDown.some((i) => i.id === next.id && /Removed/.test(i.note)));

  // Resumed: the following item goes out, not the pulled one.
  await dash('POST', '/resume');
  out = await cloudRun({ token: ADMIN, fetchImpl, log: () => {}, now: () => LATER, home: home(), client: claude(), mask: false });
  assert.equal(tweets.length > 1, true);
  assert.ok(!tweets.some((t) => t.text === next.text));

  // An expired sign-in is refreshed in the run and the new one is stored.
  const before = tokenCalls;
  const EVEN_LATER = Date.parse('2026-10-27T18:55:00Z');
  out = await cloudRun({ token: ADMIN, fetchImpl, log: () => {}, now: () => EVEN_LATER, home: home(), client: claude(), mask: false });
  assert.equal(tokenCalls, before + 1, 'the X token was refreshed');
  const state = await dash('GET', '/state');
  assert.equal(state.tokens.x.access_token, `AT${tokenCalls}`);
});
