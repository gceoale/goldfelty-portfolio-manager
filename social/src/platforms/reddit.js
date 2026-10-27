import { authed } from '../oauth.js';
import { HttpError, failure } from '../http.js';
import { redditTarget } from '../queue.js';

const API = 'https://oauth.reddit.com';

export async function whoami(deps) {
  const me = await authed('reddit', `${API}/api/v1/me`, { method: 'GET' }, deps);
  if (!me.ok) throw failure('Reading your Reddit account', me);
  return { username: me.json.name, moderated: await moderated(deps) };
}

async function moderated(deps) {
  const names = [];
  let after = '';
  for (let page = 0; page < 10; page++) {
    const url = `${API}/subreddits/mine/moderator?limit=100${after ? `&after=${after}` : ''}`;
    const res = await authed('reddit', url, { method: 'GET' }, deps);
    if (!res.ok) throw failure('Reading the subreddits you moderate', res);
    for (const child of res.json?.data?.children || []) names.push(child.data.display_name);
    after = res.json?.data?.after;
    if (!after) break;
  }
  // Your own profile shows up here as u_<name> too; that's fine.
  return names;
}

// Where this app may post by itself: your profile and subreddits you moderate.
export function allowedTargets(tokens) {
  const r = tokens.reddit;
  if (!r?.username) return [];
  return [...new Set([`u_${r.username}`, ...(r.moderated || [])])];
}

// Score and comment count for your own posts (ids like t3_abc).
export async function metrics(ids, deps) {
  const out = {};
  for (let i = 0; i < ids.length; i += 100) {
    const batch = ids.slice(i, i + 100);
    const res = await authed('reddit', `${API}/api/info?id=${batch.join(',')}`, { method: 'GET' }, deps);
    if (!res.ok) throw failure('Reading Reddit post numbers', res);
    for (const child of res.json?.data?.children || []) {
      const d = child.data;
      out[d.name] = { likes: d.score || 0, replies: d.num_comments || 0, reposts: d.num_crossposts || 0, views: 0 };
    }
  }
  return out;
}

export async function publish(item, deps) {
  const target = redditTarget(item.content.subreddit);
  // Check against a fresh list, in case you've stepped down as a moderator.
  const info = await whoami(deps);
  const all = deps.tokens.load();
  all.reddit = { ...all.reddit, ...info };
  deps.tokens.save(all);
  const allowed = allowedTargets(all).map((s) => s.toLowerCase());
  if (!allowed.includes(target.toLowerCase())) {
    throw new HttpError(
      `r/${target} isn't your profile or a subreddit you moderate, so this app won't post there.`,
    );
  }
  const form = new URLSearchParams({
    api_type: 'json',
    kind: 'self',
    sr: target,
    title: item.content.title,
    text: item.content.body,
  });
  const res = await authed(
    'reddit',
    `${API}/api/submit`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: form.toString(),
    },
    deps,
  );
  if (!res.ok) throw failure('Posting to Reddit', res);
  const errors = res.json?.json?.errors || [];
  if (errors.length) {
    const rateLimited = errors.some((e) => e[0] === 'RATELIMIT');
    throw new HttpError(`Reddit said: ${errors.map((e) => e[1]).join('; ')}`, {
      status: res.status,
      retryable: rateLimited,
    });
  }
  const data = res.json?.json?.data || {};
  return { id: data.name, url: data.url };
}
