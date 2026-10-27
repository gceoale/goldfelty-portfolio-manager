import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { normalizeConfig } from '../src/config.js';
import { memoryTokenStore } from '../src/oauth.js';

export function tmpHome() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gs-test-'));
  process.env.GOLDFELTY_SOCIAL_HOME = dir;
  return dir;
}

// routes: [[method, urlPrefixOrRegex, handler(call) -> {status, json, text, headers}]]
// Handlers run in order of matching; a route with `once: true` is used once.
export function mockFetch(routes) {
  const calls = [];
  const fetch = async (url, init = {}) => {
    const call = {
      url: String(url),
      method: init.method || 'GET',
      headers: init.headers || {},
      body: init.body,
    };
    calls.push(call);
    const idx = routes.findIndex(
      (r) =>
        r.method === call.method &&
        (r.match instanceof RegExp ? r.match.test(call.url) : call.url.startsWith(r.match)),
    );
    if (idx === -1) throw new Error(`No mock for ${call.method} ${call.url}`);
    const route = routes[idx];
    if (route.once) routes.splice(idx, 1);
    const out = await route.reply(call);
    if (out.throw) throw new Error(out.throw);
    const body = out.json !== undefined ? JSON.stringify(out.json) : out.text || '';
    const status = out.status || 200;
    return new Response(status === 204 ? null : body, { status, headers: out.headers || {} });
  };
  return { fetch, calls };
}

export function makeTestDeps({ config = {}, tokens = {}, routes = [], now = Date.parse('2026-10-27T12:00:00Z') } = {}) {
  const { fetch, calls } = mockFetch(routes);
  const clock = { t: now };
  const logs = [];
  return {
    deps: {
      config: normalizeConfig({
        x: { clientId: 'xid' },
        reddit: { clientId: 'rid' },
        youtube: { clientId: 'yid', clientSecret: 'ysecret' },
        ...config,
      }),
      tokens: memoryTokenStore(tokens),
      fetch,
      now: () => clock.t,
      sleep: async () => {},
      log: (m) => logs.push(m),
    },
    calls,
    clock,
    logs,
  };
}

export const freshToken = (extra = {}) => ({
  access_token: 'AT',
  refresh_token: 'RT',
  expires_at: Date.parse('2026-10-27T14:00:00Z'),
  ...extra,
});
