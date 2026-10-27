// How your posts did, and what the next batch learns from it.
//
// Numbers are read from each platform for posts from the last 30 days and
// stored on the queue item. The best and worst performers go into the next
// prompt, so Claude writes more of what your audience responds to.
import { loadQueue, saveQueue, itemText } from './queue.js';
import { appendLog } from './store.js';
import { parseWindow, minuteOfDay } from './schedule.js';

const WINDOW_DAYS = 30;
export const REFRESH_MS = 6 * 60 * 60_000;

// Replies and reposts count more than likes: they're what spreads a post.
export function score(m) {
  if (!m) return 0;
  return (m.likes || 0) + 3 * (m.reposts || 0) + 2 * (m.replies || 0) + (m.views || 0) / 200;
}

function platformId(item) {
  if (item.platform === 'x') return item.result?.ids?.[0];
  return item.result?.id;
}

export async function refreshMetrics(deps, publishers, { force = false } = {}) {
  const now = deps.now();
  const tokens = deps.tokens.load();
  const q = loadQueue();
  const recent = q.items.filter(
    (i) =>
      i.status === 'posted' &&
      platformId(i) &&
      now - Date.parse(i.postedAt) < WINDOW_DAYS * 86_400_000 &&
      (force || !i.metrics || now - Date.parse(i.metrics.fetchedAt) > REFRESH_MS),
  );
  const found = {};
  const errors = [];
  for (const platform of ['x', 'reddit', 'youtube']) {
    const ids = recent.filter((i) => i.platform === platform).map(platformId);
    if (!ids.length || !tokens[platform]?.access_token) continue;
    try {
      found[platform] = await publishers[platform].metrics(ids, deps);
    } catch (err) {
      errors.push(`${platform}: ${err.message}`);
    }
  }
  // Re-read: the queue may have changed while we were waiting.
  const fresh = loadQueue();
  let updated = 0;
  for (const item of fresh.items) {
    const m = found[item.platform]?.[platformId(item)];
    if (m) {
      item.metrics = { ...m, fetchedAt: new Date(now).toISOString() };
      updated++;
    }
  }
  saveQueue(fresh);
  if (updated) appendLog(`read numbers for ${updated} posts`);
  return { updated, errors };
}

// The posts that did best and worst, for the prompt. Needs a few posts on a
// platform before it says anything, or it would learn from noise.
export function learnings(items, { minPosts = 4, top = 4, bottom = 2 } = {}) {
  const out = [];
  for (const platform of ['x', 'reddit', 'youtube']) {
    const measured = items
      .filter((i) => i.platform === platform && i.status === 'posted' && i.metrics)
      .sort((a, b) => score(b.metrics) - score(a.metrics));
    if (measured.length < minPosts) continue;
    const describe = (i) => {
      const m = i.metrics;
      const nums = `${m.likes} likes, ${m.reposts} reposts, ${m.replies} replies${m.views ? `, ${m.views} views` : ''}`;
      return `- [${platform} ${i.kind}; ${nums}] ${itemText(i).replace(/\s+/g, ' ').slice(0, 300)}`;
    };
    out.push({
      platform,
      best: measured.slice(0, top).map(describe),
      worst: measured.slice(-bottom).filter((i) => !measured.slice(0, top).includes(i)).map(describe),
    });
  }
  return out;
}

// Average score per posting window, so you can see which times work.
export function byWindow(items, config) {
  const out = {};
  for (const platform of ['x', 'reddit', 'youtube']) {
    const windows = config[platform].windows.map((w) => ({ spec: w, ...parseWindow(w), total: 0, n: 0 }));
    for (const i of items) {
      if (i.platform !== platform || i.status !== 'posted' || !i.metrics) continue;
      const m = minuteOfDay(new Date(i.postedAt));
      const w = windows.find((w) => m >= w.start && m < w.end);
      if (w) {
        w.total += score(i.metrics);
        w.n++;
      }
    }
    out[platform] = windows.map((w) => ({ window: w.spec, posts: w.n, average: w.n ? Math.round((w.total / w.n) * 10) / 10 : null }));
  }
  return out;
}
