import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { tmpHome, makeTestDeps } from './helpers.js';
import { saveQueue, addItems, loadQueue } from '../src/queue.js';
import { createServer } from '../src/ui/server.js';

tmpHome();
const port = 19000 + Math.floor(Math.random() * 1000);

function call(path, { method = 'GET', headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path, method, headers: { Host: `127.0.0.1:${port}`, ...headers } }, (res) => {
      let data = '';
      res.on('data', (c) => (data += c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: data }));
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

test('review page API', async (t) => {
  const q = { items: [] };
  const [item] = addItems(q, [{ platform: 'x', kind: 'post', content: { text: 'A post to review.' } }]).added;
  saveQueue(q);
  const { deps } = makeTestDeps();
  const ui = createServer({ deps, port, token: 'secret-token-123' });
  await ui.listen();
  t.after(() => ui.close());
  const auth = { 'X-Token': 'secret-token-123' };
  const json = { ...auth, 'Content-Type': 'application/json' };

  await t.test('the page loads with a strict CSP', async () => {
    const res = await call('/');
    assert.equal(res.status, 200);
    assert.match(res.headers['content-security-policy'], /script-src 'self'/);
  });

  await t.test('no token, no data', async () => {
    assert.equal((await call('/api/state')).status, 401);
    assert.equal((await call('/api/state', { headers: { 'X-Token': 'wrong-token-1234' } })).status, 401);
  });

  await t.test('a wrong Host is refused (DNS rebinding)', async () => {
    assert.equal((await call('/api/state', { headers: { ...auth, Host: `evil.example:${port}` } })).status, 421);
  });

  await t.test('other origins are refused', async () => {
    const res = await call(`/api/items/${item.id}/approve`, { method: 'POST', headers: { ...json, Origin: 'https://evil.example' }, body: '{}' });
    assert.equal(res.status, 403);
  });

  await t.test('form posts are refused', async () => {
    const res = await call(`/api/items/${item.id}/approve`, { method: 'POST', headers: { ...auth, 'Content-Type': 'text/plain' }, body: '{}' });
    assert.equal(res.status, 415);
  });

  await t.test('state, edit and approve work with the token', async () => {
    const state = JSON.parse((await call('/api/state', { headers: auth })).body);
    assert.equal(state.items[0].id, item.id);
    assert.equal(state.live, false);
    let res = await call(`/api/items/${item.id}/edit`, { method: 'POST', headers: json, body: JSON.stringify({ content: { text: 'An edited post.' } }) });
    assert.equal(res.status, 200);
    res = await call(`/api/items/${item.id}/approve`, { method: 'POST', headers: json, body: '{}' });
    assert.equal(res.status, 200);
    assert.equal(loadQueue().items[0].status, 'approved');
    assert.equal(loadQueue().items[0].content.text, 'An edited post.');
  });

  await t.test('post now is off in a dry run', async () => {
    const res = await call(`/api/items/${item.id}/post`, { method: 'POST', headers: json, body: '{}' });
    assert.equal(res.status, 409);
  });

  await t.test('bad approvals explain why', async () => {
    const res = await call(`/api/items/${item.id}/edit`, { method: 'POST', headers: json, body: JSON.stringify({ content: { text: 'hello @you' } }) });
    assert.equal(res.status, 200);
    const bad = await call(`/api/items/${item.id}/approve`, { method: 'POST', headers: json, body: '{}' });
    assert.equal(bad.status, 400);
    assert.match(JSON.parse(bad.body).error, /mentions someone/);
  });
});
