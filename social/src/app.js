// What the command line and the review page both use.
import fs from 'node:fs';
import path from 'node:path';
import { loadConfig, anthropicKey } from './config.js';
import { appendLog, dataPath } from './store.js';
import { fileTokenStore, NotConnectedError, connect, disconnect } from './oauth.js';
import * as queueLib from './queue.js';
import { nextDue, capCheck, historyFrom } from './schedule.js';
import { generate, loadFacts, makeClient, DEFAULT_COUNTS } from './generate.js';
import { refreshMetrics } from './metrics.js';
import * as x from './platforms/x.js';
import * as reddit from './platforms/reddit.js';
import * as youtube from './platforms/youtube.js';

export const PUBLISHERS = { x, reddit, youtube };
export const PLATFORM_IDS = ['x', 'reddit', 'youtube'];
const MAX_ATTEMPTS = 3;
const RETRY_AFTER_MS = 30 * 60_000;

export function makeDeps(overrides = {}) {
  return {
    config: loadConfig(),
    tokens: fileTokenStore,
    fetch: globalThis.fetch,
    now: () => Date.now(),
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    log: (msg) => console.log(msg),
    ...overrides,
  };
}

export function connections(deps) {
  const t = deps.tokens.load();
  return Object.fromEntries(
    PLATFORM_IDS.map((p) => [p, { connected: Boolean(t[p]?.access_token), username: t[p]?.username || '' }]),
  );
}

export function allowedReddit(tokens) {
  return reddit.allowedTargets(tokens);
}

export async function connectPlatform(platform, deps, { openBrowser }) {
  if (!PLATFORM_IDS.includes(platform)) throw new Error(`Unknown platform "${platform}". Use x, reddit or youtube.`);
  await connect(platform, deps, { openBrowser, log: deps.log });
  const info = await PUBLISHERS[platform].whoami(deps);
  const all = deps.tokens.load();
  all[platform] = { ...all[platform], ...info };
  deps.tokens.save(all);
  appendLog(`connected ${platform} as ${info.username}`);
  return info;
}

export function disconnectPlatform(platform, deps) {
  disconnect(platform, deps);
  appendLog(`disconnected ${platform}`);
}

export function withQueue(fn) {
  const q = queueLib.loadQueue();
  const out = fn(q);
  queueLib.saveQueue(q);
  return out;
}

export async function generateDrafts(deps, { counts = DEFAULT_COUNTS, focus = '', client, source = 'manual' } = {}) {
  const c = client || makeClient(anthropicKey(deps.config));
  const facts = loadFacts();
  const redditUser = deps.tokens.load().reddit?.username;
  const { drafts, dropped } = await generate({
    client: c,
    config: deps.config,
    facts,
    queue: queueLib.loadQueue(),
    counts,
    focus,
    redditUser,
  });
  const tagged = drafts.map((d) => ({ ...d, source }));
  const { added, skipped } = withQueue((q) => queueLib.addItems(q, tagged, new Date(deps.now())));
  appendLog(`generated ${added.length} drafts (${dropped.length + skipped.length} dropped)`);
  return { added, dropped: [...dropped, ...skipped] };
}

export function approveItem(id, deps) {
  const tokens = deps.tokens.load();
  return withQueue((q) => {
    const item = queueLib.findItem(q, id);
    if (item.platform === 'reddit' && item.content.subreddit === 'u_YOUR_USERNAME' && tokens.reddit?.username) {
      item.content.subreddit = `u_${tokens.reddit.username}`;
    }
    queueLib.approve(item, { allowedReddit: reddit.allowedTargets(tokens), now: new Date(deps.now()) });
    appendLog(`approved ${item.id} (${item.platform} ${item.kind}) -> ${item.status}`);
    return item;
  });
}

export function rejectItem(id, deps) {
  return withQueue((q) => queueLib.reject(queueLib.findItem(q, id), new Date(deps.now())));
}

export function restoreItem(id, deps) {
  return withQueue((q) => queueLib.restore(queueLib.findItem(q, id), new Date(deps.now())));
}

export function editItem(id, content, deps) {
  return withQueue((q) => queueLib.edit(queueLib.findItem(q, id), content, new Date(deps.now())));
}

export function markDoneItem(id, url, deps) {
  return withQueue((q) => queueLib.markDone(queueLib.findItem(q, id), url, new Date(deps.now())));
}

export function useAlternativeItem(id, index, deps) {
  return withQueue((q) => queueLib.useAlternative(queueLib.findItem(q, id), Number(index), new Date(deps.now())));
}

export function attachImages(id, files, deps) {
  const abs = files.map((f) => path.resolve(f));
  for (const f of abs) {
    if (!fs.existsSync(f)) throw new Error(`Can't find ${f}.`);
    if (!x.imageType(f)) throw new Error(`${path.basename(f)} isn't a PNG, JPEG, WebP or GIF.`);
    if (fs.statSync(f).size > 5 * 1024 * 1024) throw new Error(`${path.basename(f)} is over 5 MB.`);
  }
  return withQueue((q) => queueLib.setImages(queueLib.findItem(q, id), abs, new Date(deps.now())));
}

export function refreshNumbers(deps, opts) {
  return refreshMetrics(deps, PUBLISHERS, opts);
}

export function addVideo(file, { title, description = '', privacyStatus, premise, format, source = 'manual' }, deps) {
  const abs = path.resolve(file);
  if (!fs.existsSync(abs)) throw new Error(`Can't find ${abs}.`);
  if (!youtube.videoType(abs)) throw new Error(`${path.basename(abs)} isn't a video type YouTube takes.`);
  const item = {
    platform: 'youtube',
    kind: 'video',
    content: {
      file: abs,
      title: title || path.basename(abs, path.extname(abs)),
      description,
      privacyStatus: privacyStatus || deps.config.youtube.privacyStatus,
      ...(premise ? { premise, format } : {}),
    },
    basis: premise ? `Made by goldfelty-social: ${premise}` : 'Your own video',
    source,
  };
  return withQueue((q) => queueLib.addItems(q, [item], new Date(deps.now())).added[0]);
}

// Posts one approved item now. Caps still apply; posting windows don't.
export async function postNow(id, deps) {
  const q = queueLib.loadQueue();
  const item = queueLib.findItem(q, id);
  if (item.status !== 'approved') throw new Error(`Only approved items can be posted; this one is ${item.status}.`);
  const blocked = capCheck({ item, history: historyFrom(q.items), config: deps.config, now: new Date(deps.now()) });
  if (blocked) throw new Error(blocked);
  return publishOne(item.id, deps);
}

export async function publishOne(id, deps) {
  let q = queueLib.loadQueue();
  let item = queueLib.findItem(q, id);
  if (item.status !== 'approved') throw new Error(`Item ${id} isn't approved.`);
  if (!PUBLISHERS[item.platform] || item.kind === 'script') throw new Error('Scripts are recorded by hand.');
  // Last word from the dashboard: paused, or this item pulled?
  if (deps.beforePost) {
    const verdict = await deps.beforePost(item);
    if (verdict !== 'go') {
      if (verdict === 'removed') {
        item.status = 'rejected';
        item.note = 'Removed from the dashboard.';
        queueLib.saveQueue(q);
        await deps.sync?.();
      }
      return item;
    }
  }
  item.status = 'posting';
  item.attempts = (item.attempts || 0) + 1;
  queueLib.saveQueue(q);
  await deps.sync?.();

  let result;
  let error;
  try {
    result = await PUBLISHERS[item.platform].publish(item, deps);
  } catch (err) {
    error = err;
  }

  const now = new Date(deps.now());
  q = queueLib.loadQueue();
  item = queueLib.findItem(q, id);
  item.updatedAt = now.toISOString();
  if (!error) {
    item.status = 'posted';
    item.postedAt = now.toISOString();
    item.result = result;
    item.error = undefined;
    item.notBefore = undefined;
    appendLog(`posted ${item.id} (${item.platform}) ${result.url || ''}`);
    deps.log(`Posted to ${item.platform}: ${result.url || item.id}`);
  } else {
    if (error.partial) {
      item.result = error.partial;
      item.postedAt = item.postedAt || now.toISOString();
    }
    item.error = error.message;
    if (error instanceof NotConnectedError) {
      item.status = 'approved';
      item.attempts -= 1;
      item.notBefore = new Date(now.getTime() + RETRY_AFTER_MS).toISOString();
    } else if (error.retryable && item.attempts < MAX_ATTEMPTS) {
      item.status = 'approved';
      item.notBefore = new Date(now.getTime() + RETRY_AFTER_MS).toISOString();
    } else {
      item.status = 'failed';
    }
    appendLog(`failed ${item.id} (${item.platform}): ${error.message}`);
    deps.log(`Couldn't post ${item.id} to ${item.platform}: ${error.message}`);
  }
  queueLib.saveQueue(q);
  await deps.sync?.();
  return item;
}

// One pass of the scheduler. In a dry run nothing is sent: it logs what
// would go out and remembers it in dryHistory, so caps behave the same.
export async function tick(deps, { live, dryHistory, early = 0 }) {
  const conns = connections(deps);
  for (const platform of PLATFORM_IDS) {
    if (live && !conns[platform].connected) continue;
    const q = queueLib.loadQueue();
    const history = [...historyFrom(q.items), ...dryHistory];
    const now = new Date(deps.now());
    const { item } = nextDue({ platform, items: q.items, history, config: deps.config, now, early });
    if (!item) continue;
    if (!live) {
      dryHistory.push({ platform, kind: item.kind, at: now });
      deps.log(`[dry run] Would post ${item.id} to ${platform}: ${queueLib.itemText(item).slice(0, 80).replace(/\s+/g, ' ')}…`);
      continue;
    }
    await publishOne(item.id, deps);
  }
}

// Only one scheduler at a time, or two could post the same item.
export function takeRunLock() {
  const file = dataPath('run.lock');
  try {
    const pid = Number(fs.readFileSync(file, 'utf8'));
    if (pid && pid !== process.pid) {
      try {
        process.kill(pid, 0);
        throw new Error(`Already running (process ${pid}). Stop that one first.`);
      } catch (err) {
        if (err.code !== 'ESRCH') throw err;
      }
    }
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
  }
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  fs.writeFileSync(file, String(process.pid), { mode: 0o600 });
  return () => {
    try {
      if (fs.readFileSync(file, 'utf8') === String(process.pid)) fs.unlinkSync(file);
    } catch {
      /* already gone */
    }
  };
}

export function summary(deps) {
  const q = queueLib.loadQueue();
  const counts = {};
  for (const i of q.items) counts[i.status] = (counts[i.status] || 0) + 1;
  const history = historyFrom(q.items);
  const today = new Date(deps.now()).toDateString();
  const postedToday = Object.fromEntries(
    PLATFORM_IDS.map((p) => [p, history.filter((h) => h.platform === p && h.at.toDateString() === today).length]),
  );
  return { counts, postedToday, connections: connections(deps) };
}
