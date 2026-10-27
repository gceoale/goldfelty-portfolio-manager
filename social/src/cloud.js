// One autopilot run with its state kept on api.goldfelty.com, for a runner
// that starts empty every time (the scheduled GitHub Actions workflow).
//
// Download state -> run autopilot and the scheduler -> upload state. The
// queue is uploaded after every post too, so a run that dies half way can't
// post the same thing twice. Just before each post the dashboard is asked
// again whether everything is paused or that item was pulled.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { writeJson, dataPath } from './store.js';
import { normalizeConfig, anthropicKey } from './config.js';
import * as queueLib from './queue.js';
import * as app from './app.js';
import { autopilotStep, loadState, saveState } from './autopilot.js';
import { makeClient, loadFacts } from './generate.js';
import { REFRESH_MS } from './metrics.js';

export const DEFAULT_API = 'https://api.goldfelty.com/v1/admin/social';
const KEEP_FINISHED = 300;
const FINISHED = ['posted', 'rejected', 'failed', 'done'];

export function remote({ api = DEFAULT_API, token, fetchImpl = globalThis.fetch }) {
  const call = async (method, p, body) => {
    let res;
    try {
      res = await fetchImpl(api + p, {
        method,
        headers: { authorization: `Bearer ${token}`, ...(body ? { 'content-type': 'application/json' } : {}) },
        body: body ? JSON.stringify(body) : undefined,
      });
    } catch (err) {
      throw new Error(`Couldn't reach ${new URL(api).host}: ${err.message}`);
    }
    const text = await res.text();
    let data = null;
    try {
      data = JSON.parse(text);
    } catch {
      /* not JSON */
    }
    if (!res.ok) throw new Error(`${new URL(api).host} answered ${res.status}: ${data?.message || text.slice(0, 200)}`);
    return data;
  };
  return {
    state: () => call('GET', '/state'),
    control: () => call('GET', '/control'),
    put: (body) => call('PUT', '/state', body),
  };
}

// Keeps everything still to come, and the most recent finished items.
export function trimQueue(items) {
  const open = items.filter((i) => !FINISHED.includes(i.status));
  const done = items
    .filter((i) => FINISHED.includes(i.status))
    .sort((a, b) => String(a.updatedAt || a.postedAt).localeCompare(String(b.updatedAt || b.postedAt)))
    .slice(-KEEP_FINISHED);
  const keep = new Set([...open, ...done]);
  return items.filter((i) => keep.has(i));
}

// Values that must never show up in a (public) Actions log.
export function secretsIn(state) {
  const c = state.config || {};
  const out = [c.anthropicApiKey, c.x?.clientSecret, c.reddit?.clientSecret, c.youtube?.clientSecret];
  for (const t of Object.values(state.tokens || {})) out.push(t.access_token, t.refresh_token);
  return out.filter((v) => typeof v === 'string' && v.length >= 6);
}

export function applyRemovals(queue, blocked = [], now = new Date()) {
  let n = 0;
  for (const item of queue.items) {
    if (blocked.includes(item.id) && !['posted', 'posting', 'rejected', 'done'].includes(item.status)) {
      item.status = 'rejected';
      item.note = 'Removed from the dashboard.';
      item.updatedAt = now.toISOString();
      n++;
    }
  }
  return n;
}

export async function cloudRun({ api, token, fetchImpl = globalThis.fetch, log = console.log, now = () => Date.now(), client: injectedClient, makeVideo, home, mask = Boolean(process.env.GITHUB_ACTIONS) } = {}) {
  if (!token) throw new Error('Set GOLDFELTY_ADMIN_TOKEN.');
  const r = remote({ api, token, fetchImpl });
  const state = await r.state();
  if (mask) for (const s of secretsIn(state)) process.stdout.write(`::add-mask::${s}\n`);

  const config = normalizeConfig(state.config);
  // Posting windows are in the owner's time, not the runner's.
  if (config.timezone) process.env.TZ = config.timezone;
  process.env.GOLDFELTY_SOCIAL_HOME = home || fs.mkdtempSync(path.join(os.tmpdir(), 'goldfelty-social-'));
  writeJson('config.json', state.config || {});
  writeJson('tokens.json', state.tokens || {});
  writeJson('queue.json', state.queue || { items: [] });
  writeJson('autopilot.json', { ...(state.autopilot || {}), paused: false });
  if (state.facts) fs.writeFileSync(dataPath('facts.md'), state.facts, { mode: 0o600 });

  const lines = [];
  const say = (m) => {
    lines.push(m);
    log(m);
  };
  const deps = app.makeDeps({ config, fetch: fetchImpl, now, log: say, cloud: true });

  // What the runner started with, to upload only sign-ins it refreshed.
  let sent = Object.fromEntries(Object.entries(state.tokens || {}).map(([p, t]) => [p, JSON.stringify(t)]));
  const upload = async (extra = {}) => {
    const tokens = deps.tokens.load();
    const changed = {};
    for (const [p, t] of Object.entries(tokens)) if (JSON.stringify(t) !== sent[p]) changed[p] = t;
    const res = await r.put({ queue: { items: trimQueue(queueLib.loadQueue().items) }, autopilot: loadState(), tokens: changed, ...extra });
    sent = { ...sent, ...Object.fromEntries(Object.entries(changed).map(([p, t]) => [p, JSON.stringify(t)])) };
    for (const p of res?.skipped || []) say(`The ${p} sign-in changed on the dashboard during this run; kept the dashboard's.`);
  };
  deps.sync = () => upload();
  deps.beforePost = async (item) => {
    const c = await r.control();
    if ((c.blocked || []).includes(item.id)) return 'removed';
    return c.paused ? 'paused' : 'go';
  };

  const q = queueLib.loadQueue();
  const removed = applyRemovals(q, state.control?.blocked, new Date(now()));
  const interrupted = queueLib.recoverInterrupted(q, new Date(now()));
  queueLib.saveQueue(q);
  if (interrupted) say(`${interrupted} item(s) were cut off mid-post last run; check the account before retrying them.`);

  const postedBefore = new Set(q.items.filter((i) => i.status === 'posted').map((i) => i.id));
  const summary = [];
  let ok = true;
  try {
    if (state.control?.paused) {
      say('Paused from the dashboard.');
      summary.push('paused');
    } else if (!Object.values(app.connections(deps)).some((c) => c.connected)) {
      say('No accounts connected yet. Connect them at goldfelty.com/admin/social/.');
      summary.push('waiting for accounts');
    } else {
      const key = anthropicKey(config);
      const client = injectedClient || (key ? makeClient(key) : null);
      if (client) {
        // A writing or video problem shouldn't stop what's already approved.
        try {
          const report = await autopilotStep(deps, { app, client, ...(makeVideo ? { makeVideo } : {}) });
          if (report.generated) summary.push(`wrote ${report.generated}, approved ${report.approved}`);
          if (report.made) summary.push('made a Short');
        } catch (err) {
          ok = false;
          say(`Autopilot: ${err.message}`);
          const s = loadState();
          s.lastError = err.message;
          s.lastErrorAt = new Date(now()).toISOString();
          saveState(s);
        }
      } else {
        say('No Anthropic API key yet, so nothing new is written. Add it at goldfelty.com/admin/social/.');
        summary.push('no Anthropic key');
      }
      await app.tick(deps, { live: true, dryHistory: [], early: 30 });
      const s = loadState();
      if (!s.lastNumbersAt || now() - Date.parse(s.lastNumbersAt) > REFRESH_MS) {
        const { updated, errors } = await app.refreshNumbers(deps);
        for (const e of errors) say(`Numbers: ${e}`);
        const after = loadState();
        after.lastNumbersAt = new Date(now()).toISOString();
        saveState(after);
        if (updated) summary.push(`read numbers for ${updated}`);
      }
    }
  } catch (err) {
    ok = false;
    say(`Problem: ${err.message}`);
    const s = loadState();
    s.lastError = err.message;
    s.lastErrorAt = new Date(now()).toISOString();
    saveState(s);
  }
  const posted = queueLib.loadQueue().items.filter((i) => i.status === 'posted' && !postedBefore.has(i.id));
  if (posted.length) summary.unshift(`posted ${posted.map((i) => i.platform).join(', ')}`);
  if (removed) summary.push(`${removed} removed`);
  if (ok) {
    const s = loadState();
    if (s.lastError) {
      s.lastError = null;
      saveState(s);
    }
  }
  await upload({
    log: lines,
    run: { ok, summary: summary.join('; ') || 'nothing due' },
    ...(state.facts ? {} : { facts: loadFacts() }),
  });
  return { ok, lines, summary };
}
