import fs from 'node:fs';
import path from 'node:path';
import { authed } from '../oauth.js';
import { HttpError, failure } from '../http.js';

const API = 'https://www.googleapis.com/youtube/v3';
const UPLOAD = 'https://www.googleapis.com/upload/youtube/v3/videos?uploadType=resumable&part=snippet,status';

const TYPES = {
  '.mp4': 'video/mp4',
  '.mov': 'video/quicktime',
  '.m4v': 'video/x-m4v',
  '.webm': 'video/webm',
  '.mkv': 'video/x-matroska',
  '.avi': 'video/x-msvideo',
};

export function videoType(file) {
  return TYPES[path.extname(file).toLowerCase()];
}

export async function whoami(deps) {
  const res = await authed('youtube', `${API}/channels?part=snippet&mine=true`, { method: 'GET' }, deps);
  if (!res.ok) throw failure('Reading your YouTube channel', res);
  const ch = res.json?.items?.[0];
  if (!ch) throw new HttpError('This Google account has no YouTube channel yet.');
  return { username: ch.snippet.title, channelId: ch.id };
}

// Views, likes and comments for your own videos.
export async function metrics(ids, deps) {
  const out = {};
  for (let i = 0; i < ids.length; i += 50) {
    const batch = ids.slice(i, i + 50);
    const res = await authed('youtube', `${API}/videos?part=statistics&id=${batch.join(',')}`, { method: 'GET' }, deps);
    if (!res.ok) throw failure('Reading YouTube numbers', res);
    for (const v of res.json?.items || []) {
      const s = v.statistics || {};
      out[v.id] = { likes: Number(s.likeCount || 0), replies: Number(s.commentCount || 0), reposts: 0, views: Number(s.viewCount || 0) };
    }
  }
  return out;
}

// Resumable upload: one request to start the session, one with the file.
export async function publish(item, deps) {
  const { file, title, description = '', privacyStatus } = item.content;
  const type = videoType(file);
  if (!type) throw new HttpError(`${path.basename(file)} isn't a video type YouTube takes.`);
  const stat = await fs.promises.stat(file).catch(() => null);
  if (!stat?.isFile()) throw new HttpError(`Can't find ${file}.`);

  const meta = {
    snippet: { title, description, categoryId: '28' },
    status: {
      privacyStatus: privacyStatus || deps.config.youtube.privacyStatus,
      selfDeclaredMadeForKids: false,
    },
  };
  const start = await authed(
    'youtube',
    UPLOAD,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json; charset=UTF-8',
        'X-Upload-Content-Length': String(stat.size),
        'X-Upload-Content-Type': type,
      },
      body: JSON.stringify(meta),
    },
    deps,
  );
  const location = start.headers?.get?.('location');
  if (!start.ok || !location) throw failure('Starting the YouTube upload', start);

  const blob = await fs.openAsBlob(file, { type });
  const done = await authed(
    'youtube',
    location,
    { method: 'PUT', headers: { 'Content-Type': type }, body: blob },
    deps,
  );
  if (!done.ok || !done.json?.id) throw failure('Uploading to YouTube', done);
  return { id: done.json.id, url: `https://youtu.be/${done.json.id}` };
}
