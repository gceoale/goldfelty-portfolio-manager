import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import http from 'node:http';
import { makeTestDeps, freshToken } from './helpers.js';
import {
  getAccessToken,
  authed,
  pkcePair,
  authorizeUrl,
  waitForCallback,
  NotConnectedError,
} from '../src/oauth.js';

const NOW = Date.parse('2026-10-27T12:00:00Z');

test('a fresh token is used as is', async () => {
  const { deps, calls } = makeTestDeps({ tokens: { x: freshToken() } });
  assert.equal(await getAccessToken('x', deps), 'AT');
  assert.equal(calls.length, 0);
});

test('an expired X token is refreshed, and the new refresh token kept', async () => {
  const { deps, calls } = makeTestDeps({
    tokens: { x: freshToken({ expires_at: NOW - 1000, username: 'goldfelty' }) },
    routes: [
      {
        method: 'POST',
        match: 'https://api.x.com/2/oauth2/token',
        reply: () => ({ json: { access_token: 'AT2', refresh_token: 'RT2', expires_in: 7200 } }),
      },
    ],
  });
  assert.equal(await getAccessToken('x', deps), 'AT2');
  const body = new URLSearchParams(calls[0].body);
  assert.equal(body.get('grant_type'), 'refresh_token');
  assert.equal(body.get('refresh_token'), 'RT');
  assert.equal(body.get('client_id'), 'xid');
  const saved = deps.tokens.load().x;
  assert.equal(saved.refresh_token, 'RT2');
  assert.equal(saved.username, 'goldfelty');
  assert.equal(saved.expires_at, NOW + 7200 * 1000);
});

test('X confidential clients use Basic auth', async () => {
  const { deps, calls } = makeTestDeps({
    config: { x: { clientId: 'xid', clientSecret: 'shh' } },
    tokens: { x: freshToken({ expires_at: 0 }) },
    routes: [{ method: 'POST', match: 'https://api.x.com/2/oauth2/token', reply: () => ({ json: { access_token: 'A' } }) }],
  });
  await getAccessToken('x', deps);
  assert.equal(calls[0].headers.Authorization, `Basic ${Buffer.from('xid:shh').toString('base64')}`);
  assert.equal(new URLSearchParams(calls[0].body).get('client_id'), null);
});

test('Reddit refresh uses Basic auth, a User-Agent, and keeps its refresh token', async () => {
  const { deps, calls } = makeTestDeps({
    tokens: { reddit: freshToken({ expires_at: 0, username: 'gold' }) },
    routes: [
      { method: 'POST', match: 'https://www.reddit.com/api/v1/access_token', reply: () => ({ json: { access_token: 'R2', expires_in: 86400 } }) },
    ],
  });
  assert.equal(await getAccessToken('reddit', deps), 'R2');
  assert.equal(calls[0].headers.Authorization, `Basic ${Buffer.from('rid:').toString('base64')}`);
  assert.match(calls[0].headers['User-Agent'], /^desktop:goldfelty-social:[\d.]+ \(by \/u\/gold\)$/);
  assert.equal(deps.tokens.load().reddit.refresh_token, 'RT');
});

test('Google refresh sends client id and secret in the body', async () => {
  const { deps, calls } = makeTestDeps({
    tokens: { youtube: freshToken({ expires_at: 0 }) },
    routes: [{ method: 'POST', match: 'https://oauth2.googleapis.com/token', reply: () => ({ json: { access_token: 'G2', expires_in: 3599 } }) }],
  });
  await getAccessToken('youtube', deps);
  const body = new URLSearchParams(calls[0].body);
  assert.equal(body.get('client_id'), 'yid');
  assert.equal(body.get('client_secret'), 'ysecret');
});

test('two refreshes at once make one request', async () => {
  const { deps, calls } = makeTestDeps({
    tokens: { x: freshToken({ expires_at: 0 }) },
    routes: [{ method: 'POST', match: 'https://api.x.com/2/oauth2/token', reply: () => ({ json: { access_token: 'ONE', refresh_token: 'RT2' } }) }],
  });
  const [a, b] = await Promise.all([getAccessToken('x', deps), getAccessToken('x', deps)]);
  assert.equal(a, 'ONE');
  assert.equal(b, 'ONE');
  assert.equal(calls.length, 1);
});

test('a revoked refresh token asks you to reconnect', async () => {
  const { deps } = makeTestDeps({
    tokens: { x: freshToken({ expires_at: 0 }) },
    routes: [{ method: 'POST', match: 'https://api.x.com/2/oauth2/token', reply: () => ({ status: 400, json: { error: 'invalid_request' } }) }],
  });
  await assert.rejects(getAccessToken('x', deps), (e) => e instanceof NotConnectedError && /connect x/.test(e.message));
});

test('not connected is reported clearly', async () => {
  const { deps } = makeTestDeps();
  await assert.rejects(getAccessToken('reddit', deps), NotConnectedError);
});

test('a 401 refreshes the token and repeats the request once', async () => {
  let n = 0;
  const { deps, calls } = makeTestDeps({
    tokens: { x: freshToken() },
    routes: [
      { method: 'GET', match: 'https://api.x.com/2/users/me', reply: (c) => (n++ === 0 ? { status: 401, json: {} } : { json: { auth: c.headers.Authorization } }) },
      { method: 'POST', match: 'https://api.x.com/2/oauth2/token', reply: () => ({ json: { access_token: 'NEW', refresh_token: 'RT2' } }) },
    ],
  });
  const res = await authed('x', 'https://api.x.com/2/users/me', { method: 'GET' }, deps);
  assert.equal(res.json.auth, 'Bearer NEW');
  assert.equal(calls.length, 3);
});

test('PKCE challenge is the SHA-256 of the verifier', () => {
  const { verifier, challenge } = pkcePair();
  assert.equal(challenge, crypto.createHash('sha256').update(verifier).digest('base64url'));
  assert.match(verifier, /^[A-Za-z0-9_-]{43}$/);
});

test('authorize URLs carry the right parameters', () => {
  const { deps } = makeTestDeps();
  const x = new URL(authorizeUrl('x', deps.config, { state: 's', challenge: 'c' }));
  assert.equal(x.searchParams.get('redirect_uri'), 'http://127.0.0.1:8787/callback');
  assert.equal(x.searchParams.get('code_challenge_method'), 'S256');
  assert.match(x.searchParams.get('scope'), /offline\.access/);
  const r = new URL(authorizeUrl('reddit', deps.config, { state: 's', challenge: 'c' }));
  assert.equal(r.searchParams.get('duration'), 'permanent');
  assert.equal(r.searchParams.get('code_challenge'), null);
  const g = new URL(authorizeUrl('youtube', deps.config, { state: 's', challenge: 'c' }));
  assert.equal(g.searchParams.get('access_type'), 'offline');
});

function get(url) {
  return new Promise((resolve, reject) => {
    http.get(url, (res) => {
      res.resume();
      res.on('end', () => resolve(res.statusCode));
    }).on('error', reject);
  });
}

test('the callback ignores the wrong state and accepts the right one', async () => {
  const port = 18000 + Math.floor(Math.random() * 1000);
  const waiting = waitForCallback({ port, state: 'good', timeoutMs: 5000 });
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(await get(`http://127.0.0.1:${port}/callback?state=bad&code=evil`), 400);
  assert.equal(await get(`http://127.0.0.1:${port}/callback?state=good&code=abc`), 200);
  assert.equal(await waiting, 'abc');
});
