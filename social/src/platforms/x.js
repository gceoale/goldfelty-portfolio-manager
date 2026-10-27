import fs from 'node:fs';
import path from 'node:path';
import { authed } from '../oauth.js';
import { HttpError, failure } from '../http.js';

const API = 'https://api.x.com/2';

export async function whoami(deps) {
  const res = await authed('x', `${API}/users/me`, { method: 'GET' }, deps);
  if (!res.ok) throw failure('Reading your X account', res);
  return { username: res.json.data.username };
}

const IMAGE_TYPES = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif' };
export const MAX_IMAGES = 4;
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;

export function imageType(file) {
  return IMAGE_TYPES[path.extname(file).toLowerCase()];
}

// Uploads one image: initialize, append the bytes, finalize. Returns its id.
export async function uploadImage(file, deps) {
  const type = imageType(file);
  if (!type) throw new HttpError(`${path.basename(file)} isn't a PNG, JPEG, WebP or GIF.`);
  const data = await fs.promises.readFile(file).catch(() => null);
  if (!data) throw new HttpError(`Can't find ${file}.`);
  if (data.length > MAX_IMAGE_BYTES) throw new HttpError(`${path.basename(file)} is over 5 MB.`);

  const init = await authed(
    'x',
    `${API}/media/upload/initialize`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ media_type: type, total_bytes: data.length, media_category: 'tweet_image' }),
    },
    deps,
  );
  const id = init.json?.data?.id;
  if (!init.ok || !id) throw failure('Starting an image upload to X', init);

  const form = new FormData();
  form.set('segment_index', '0');
  form.set('media', new Blob([data], { type }), path.basename(file));
  const append = await authed('x', `${API}/media/upload/${id}/append`, { method: 'POST', body: form }, deps);
  if (!append.ok) throw failure('Uploading an image to X', append);

  const fin = await authed('x', `${API}/media/upload/${id}/finalize`, { method: 'POST' }, deps);
  if (!fin.ok) throw failure('Finishing an image upload to X', fin);
  return id;
}

// Posts a single post or a thread. Images go on the first post. A thread
// that fails partway keeps the ids already posted (err.partial), so a retry
// carries on from there instead of posting the start again.
export async function publish(item, deps) {
  const tweets = item.kind === 'thread' ? item.content.tweets : [item.content.text];
  const ids = [...(item.result?.ids || [])];
  for (let i = ids.length; i < tweets.length; i++) {
    const body = { text: tweets[i] };
    if (ids.length) body.reply = { in_reply_to_tweet_id: ids[ids.length - 1] };
    if (i === 0 && item.content.images?.length) {
      const mediaIds = [];
      for (const file of item.content.images.slice(0, MAX_IMAGES)) mediaIds.push(await uploadImage(file, deps));
      body.media = { media_ids: mediaIds };
    }
    const res = await authed(
      'x',
      `${API}/tweets`,
      { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) },
      deps,
    );
    if (!res.ok || !res.json?.data?.id) {
      const err = failure(`Posting to X (${i + 1} of ${tweets.length})`, res);
      err.partial = ids.length ? { ids: [...ids], url: statusUrl(ids[0]) } : undefined;
      throw err;
    }
    ids.push(res.json.data.id);
    if (i < tweets.length - 1) await deps.sleep(1500);
  }
  return { ids, url: statusUrl(ids[0]) };
}

function statusUrl(id) {
  return `https://x.com/i/web/status/${id}`;
}

// Public numbers for your own posts, up to 100 per request.
export async function metrics(ids, deps) {
  const out = {};
  for (let i = 0; i < ids.length; i += 100) {
    const batch = ids.slice(i, i + 100);
    const res = await authed('x', `${API}/tweets?ids=${batch.join(',')}&tweet.fields=public_metrics`, { method: 'GET' }, deps);
    if (!res.ok) throw failure('Reading X post numbers', res);
    for (const t of res.json?.data || []) {
      const m = t.public_metrics || {};
      out[t.id] = {
        likes: m.like_count || 0,
        reposts: (m.retweet_count || 0) + (m.quote_count || 0),
        replies: m.reply_count || 0,
        views: m.impression_count || 0,
      };
    }
  }
  return out;
}
