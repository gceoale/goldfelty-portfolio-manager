// The review page, served on this computer only.
//
// The page itself is static. Every API call needs the session token from
// the link the app prints (it's in the #fragment, so it never reaches a
// server log), comes from the page's own origin, and is sent as JSON, which
// other websites can't do without permission. A request with the wrong Host
// header is refused, which stops DNS rebinding.
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import * as app from '../app.js';
import { loadQueue } from '../queue.js';
import { X_MAX } from '../text.js';
import { byWindow } from '../metrics.js';
import { loadState as loadAutopilot, setPaused } from '../autopilot.js';

const STATIC = {
  '/': ['index.html', 'text/html; charset=utf-8'],
  '/app.js': ['app.js', 'text/javascript; charset=utf-8'],
  '/style.css': ['style.css', 'text/css; charset=utf-8'],
};
const HEADERS = {
  'Content-Security-Policy':
    "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'Cache-Control': 'no-store',
};

function readBody(req, limit = 256 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) {
        reject(Object.assign(new Error('Too large'), { status: 413 }));
        req.destroy();
      } else chunks.push(c);
    });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch {
        reject(Object.assign(new Error('Bad JSON'), { status: 400 }));
      }
    });
    req.on('error', reject);
  });
}

function sameToken(a, b) {
  const x = Buffer.from(String(a || ''));
  const y = Buffer.from(String(b || ''));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

export function createServer({ deps, port, token = crypto.randomBytes(24).toString('base64url'), live = false, auto = false }) {
  const hosts = new Set([`127.0.0.1:${port}`, `localhost:${port}`]);
  const origins = new Set([...hosts].map((h) => `http://${h}`));
  let generating = false;

  const send = (res, status, body, type = 'application/json; charset=utf-8') => {
    res.writeHead(status, { ...HEADERS, 'Content-Type': type });
    res.end(type.startsWith('application/json') ? JSON.stringify(body) : body);
  };

  const state = () => ({
    live,
    auto,
    autopilot: loadAutopilot(),
    xMax: X_MAX,
    items: [...loadQueue().items].reverse(),
    summary: app.summary(deps),
    byWindow: byWindow(loadQueue().items, deps.config),
    limits: Object.fromEntries(
      app.PLATFORM_IDS.map((p) => [
        p,
        { dailyCap: deps.config[p].dailyCap, threadsPerDay: deps.config[p].threadsPerDay, windows: deps.config[p].windows },
      ]),
    ),
  });

  const server = http.createServer(async (req, res) => {
    try {
      if (!hosts.has(req.headers.host)) return send(res, 421, { error: 'Wrong host' });
      const url = new URL(req.url, `http://${req.headers.host}`);

      if (req.method === 'GET' && STATIC[url.pathname]) {
        const [file, type] = STATIC[url.pathname];
        const body = fs.readFileSync(fileURLToPath(new URL(`./${file}`, import.meta.url)));
        return send(res, 200, body, type);
      }
      if (!url.pathname.startsWith('/api/')) return send(res, 404, { error: 'Not found' });

      if (!sameToken(req.headers['x-token'], token)) return send(res, 401, { error: 'Open the link the app printed.' });
      if (req.headers.origin && !origins.has(req.headers.origin)) return send(res, 403, { error: 'Wrong origin' });

      if (req.method === 'GET' && url.pathname === '/api/state') return send(res, 200, state());

      if (req.method !== 'POST') return send(res, 405, { error: 'Method not allowed' });
      if (!String(req.headers['content-type'] || '').startsWith('application/json')) {
        return send(res, 415, { error: 'Send JSON' });
      }
      const body = await readBody(req);

      if (url.pathname === '/api/generate') {
        if (generating) return send(res, 409, { error: 'Already writing a batch.' });
        generating = true;
        try {
          const out = await app.generateDrafts(deps, { focus: String(body.focus || '').slice(0, 300) });
          return send(res, 200, {
            added: out.added.length,
            dropped: out.dropped.map((d) => d.reason),
            state: state(),
          });
        } finally {
          generating = false;
        }
      }

      if (url.pathname === '/api/pause' || url.pathname === '/api/resume') {
        setPaused(url.pathname === '/api/pause');
        return send(res, 200, state());
      }

      if (url.pathname === '/api/metrics') {
        const out = await app.refreshNumbers(deps, { force: true });
        if (out.errors.length) return send(res, 502, { error: out.errors.join(' '), state: state() });
        return send(res, 200, state());
      }

      const m = /^\/api\/items\/([a-f0-9]{4,20})\/(approve|reject|restore|edit|done|post|alt)$/.exec(url.pathname);
      if (!m) return send(res, 404, { error: 'Not found' });
      const [, id, action] = m;
      if (action === 'alt') app.useAlternativeItem(id, body.index, deps);
      else if (action === 'approve') app.approveItem(id, deps);
      else if (action === 'reject') app.rejectItem(id, deps);
      else if (action === 'restore') app.restoreItem(id, deps);
      else if (action === 'edit') app.editItem(id, body.content || {}, deps);
      else if (action === 'done') app.markDoneItem(id, String(body.url || '').slice(0, 500), deps);
      else if (action === 'post') {
        if (!live) return send(res, 409, { error: 'Posting is off. Start with --live to post.' });
        const item = await app.postNow(id, deps);
        if (item.status !== 'posted') return send(res, 502, { error: item.error, state: state() });
      }
      return send(res, 200, state());
    } catch (err) {
      return send(res, err.status || 400, { error: err.message });
    }
  });

  return {
    server,
    token,
    url: `http://127.0.0.1:${port}/#t=${token}`,
    listen: () =>
      new Promise((resolve, reject) => {
        server.once('error', (err) =>
          reject(err.code === 'EADDRINUSE' ? new Error(`Port ${port} is busy. Change ports.ui in config.json.`) : err),
        );
        server.listen(port, '127.0.0.1', resolve);
      }),
    close: () => new Promise((r) => server.close(r)),
  };
}
