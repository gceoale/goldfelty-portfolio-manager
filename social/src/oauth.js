// Signing in to X, Reddit and YouTube, and keeping those sign-ins alive.
//
// Each platform uses OAuth 2 with a redirect to this computer
// (http://127.0.0.1:<port>/callback). Access tokens are refreshed before they
// expire, and again if a platform answers 401, so posting keeps working for
// as long as the refresh token is valid.
import crypto from 'node:crypto';
import http from 'node:http';
import { readJson, writeJson, dataPath } from './store.js';
import { request, failure } from './http.js';

export const VERSION = '0.1.0';

export const PLATFORMS = {
  x: {
    label: 'X',
    authorizeUrl: 'https://x.com/i/oauth2/authorize',
    tokenUrl: 'https://api.x.com/2/oauth2/token',
    scope: 'tweet.read tweet.write users.read media.write offline.access',
    pkce: true,
    authParams: {},
  },
  reddit: {
    label: 'Reddit',
    authorizeUrl: 'https://www.reddit.com/api/v1/authorize',
    tokenUrl: 'https://www.reddit.com/api/v1/access_token',
    scope: 'identity submit read mysubreddits',
    pkce: false,
    authParams: { duration: 'permanent' },
  },
  youtube: {
    label: 'YouTube',
    authorizeUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
    tokenUrl: 'https://oauth2.googleapis.com/token',
    scope: 'https://www.googleapis.com/auth/youtube.upload https://www.googleapis.com/auth/youtube.readonly',
    pkce: true,
    authParams: { access_type: 'offline', prompt: 'consent' },
  },
};

export class NotConnectedError extends Error {
  constructor(platform, why = 'not connected') {
    super(`${PLATFORMS[platform].label}: ${why}. Run: goldfelty-social connect ${platform}`);
    this.name = 'NotConnectedError';
    this.platform = platform;
  }
}

export const fileTokenStore = {
  load: () => readJson('tokens.json', {}),
  save: (tokens) => writeJson('tokens.json', tokens),
};

export function memoryTokenStore(initial = {}) {
  let data = structuredClone(initial);
  return {
    load: () => structuredClone(data),
    save: (t) => {
      data = structuredClone(t);
    },
  };
}

export function base64url(buf) {
  return Buffer.from(buf).toString('base64url');
}

export function pkcePair() {
  const verifier = base64url(crypto.randomBytes(32));
  const challenge = base64url(crypto.createHash('sha256').update(verifier).digest());
  return { verifier, challenge };
}

export function redditUserAgent(deps) {
  const name = deps.tokens.load().reddit?.username || 'unknown';
  return `desktop:goldfelty-social:${VERSION} (by /u/${name})`;
}

export function redirectUri(config) {
  return `http://127.0.0.1:${config.ports.oauth}/callback`;
}

async function tokenRequest(platform, params, deps) {
  const def = PLATFORMS[platform];
  const pc = deps.config[platform];
  const headers = {
    'Content-Type': 'application/x-www-form-urlencoded',
    Accept: 'application/json',
  };
  const body = new URLSearchParams(params);
  // Reddit always wants HTTP Basic (empty password for installed apps). X
  // wants it for confidential clients and client_id in the body otherwise.
  // Google takes both in the body.
  if (platform === 'reddit' || (platform === 'x' && pc.clientSecret)) {
    headers.Authorization =
      'Basic ' + Buffer.from(`${pc.clientId}:${pc.clientSecret || ''}`).toString('base64');
  } else {
    body.set('client_id', pc.clientId);
    if (pc.clientSecret) body.set('client_secret', pc.clientSecret);
  }
  if (platform === 'reddit') headers['User-Agent'] = redditUserAgent(deps);
  const res = await request(deps.fetch, def.tokenUrl, { method: 'POST', headers, body: body.toString() });
  if (!res.ok || !res.json?.access_token) throw failure(`${def.label} sign-in`, res);
  return res.json;
}

function fromTokenResponse(json, prev, nowMs) {
  return {
    ...prev,
    access_token: json.access_token,
    // X hands out a new refresh token every time and the old one stops
    // working; Google and Reddit keep the old one.
    refresh_token: json.refresh_token || prev?.refresh_token,
    expires_at: nowMs + (Number(json.expires_in) || 3600) * 1000,
    scope: json.scope || prev?.scope,
  };
}

const refreshing = new Map();

export async function getAccessToken(platform, deps, { force = false } = {}) {
  const t = deps.tokens.load()[platform];
  if (!t?.access_token) throw new NotConnectedError(platform);
  if (!force && t.expires_at - deps.now() > 60_000) return t.access_token;
  if (!t.refresh_token) throw new NotConnectedError(platform, 'the sign-in expired');

  // One refresh at a time per platform: two at once would make X revoke both.
  const key = `${platform}:${t.refresh_token}`;
  if (!refreshing.has(key)) {
    refreshing.set(
      key,
      (async () => {
        try {
          let json;
          try {
            json = await tokenRequest(
              platform,
              { grant_type: 'refresh_token', refresh_token: t.refresh_token },
              deps,
            );
          } catch (err) {
            if (err.status === 400 || err.status === 401) {
              throw new NotConnectedError(platform, 'the sign-in expired or was revoked');
            }
            throw err;
          }
          const all = deps.tokens.load();
          all[platform] = fromTokenResponse(json, all[platform], deps.now());
          deps.tokens.save(all);
          return all[platform].access_token;
        } finally {
          refreshing.delete(key);
        }
      })(),
    );
  }
  return refreshing.get(key);
}

// A request with the platform's token. On 401 the token is refreshed once and
// the request repeated.
export async function authed(platform, url, init, deps) {
  const send = (token) => {
    const headers = { ...(init.headers || {}), Authorization: `Bearer ${token}` };
    if (platform === 'reddit') headers['User-Agent'] = redditUserAgent(deps);
    return request(deps.fetch, url, { ...init, headers });
  };
  let res = await send(await getAccessToken(platform, deps));
  if (res.status === 401) res = await send(await getAccessToken(platform, deps, { force: true }));
  return res;
}

// Waits for the browser to come back to http://127.0.0.1:<port>/callback.
export function waitForCallback({ port, state, timeoutMs = 5 * 60_000 }) {
  return new Promise((resolve, reject) => {
    const page = (msg) =>
      `<!doctype html><meta charset="utf-8"><title>goldfelty-social</title>` +
      `<body style="font:16px system-ui;margin:3rem">${msg}</body>`;
    const server = http.createServer((req, res) => {
      const url = new URL(req.url, `http://127.0.0.1:${port}`);
      if (url.pathname !== '/callback') {
        res.writeHead(404).end();
        return;
      }
      const finish = (status, msg, err, code) => {
        res.writeHead(status, {
          'Content-Type': 'text/html; charset=utf-8',
          'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'",
        });
        res.end(page(msg));
        clearTimeout(timer);
        server.close();
        err ? reject(err) : resolve(code);
      };
      if (url.searchParams.get('state') !== state) {
        // Not ours (an old tab, or another site). Keep waiting.
        res.writeHead(400, { 'Content-Type': 'text/plain' }).end('This sign-in link is out of date.');
        return;
      }
      const error = url.searchParams.get('error');
      if (error) return finish(400, 'Sign-in was cancelled. You can close this tab.', new Error(`Sign-in cancelled: ${error}`));
      const code = url.searchParams.get('code');
      if (!code) return finish(400, 'No code came back. You can close this tab.', new Error('No code came back'));
      finish(200, 'Connected. You can close this tab.', null, code);
    });
    const timer = setTimeout(() => {
      server.close();
      reject(new Error('Gave up waiting for the sign-in after 5 minutes.'));
    }, timeoutMs);
    server.on('error', (err) => {
      clearTimeout(timer);
      reject(err.code === 'EADDRINUSE' ? new Error(`Port ${port} is busy. Change ports.oauth in config.json.`) : err);
    });
    server.listen(port, '127.0.0.1');
  });
}

export function authorizeUrl(platform, config, { state, challenge }) {
  const def = PLATFORMS[platform];
  const url = new URL(def.authorizeUrl);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('client_id', config[platform].clientId);
  url.searchParams.set('redirect_uri', redirectUri(config));
  url.searchParams.set('scope', def.scope);
  url.searchParams.set('state', state);
  if (def.pkce) {
    url.searchParams.set('code_challenge', challenge);
    url.searchParams.set('code_challenge_method', 'S256');
  }
  for (const [k, v] of Object.entries(def.authParams)) url.searchParams.set(k, v);
  return url.toString();
}

export async function connect(platform, deps, { openBrowser, log }) {
  const pc = deps.config[platform];
  if (!pc?.clientId) {
    throw new Error(`Set ${platform}.clientId in ${dataPath('config.json')} first (see README).`);
  }
  if (platform === 'youtube' && !pc.clientSecret) {
    throw new Error(`Set youtube.clientSecret in ${dataPath('config.json')} first (see README).`);
  }
  const state = base64url(crypto.randomBytes(16));
  const { verifier, challenge } = pkcePair();
  const url = authorizeUrl(platform, deps.config, { state, challenge });
  const waiting = waitForCallback({ port: deps.config.ports.oauth, state });
  log(`Opening ${PLATFORMS[platform].label} in your browser. If it doesn't open, go to:\n${url}`);
  openBrowser(url);
  const code = await waiting;
  const params = { grant_type: 'authorization_code', code, redirect_uri: redirectUri(deps.config) };
  if (PLATFORMS[platform].pkce) params.code_verifier = verifier;
  const json = await tokenRequest(platform, params, deps);
  const all = deps.tokens.load();
  all[platform] = fromTokenResponse(json, {}, deps.now());
  deps.tokens.save(all);
}

export function disconnect(platform, deps) {
  const all = deps.tokens.load();
  delete all[platform];
  deps.tokens.save(all);
}
