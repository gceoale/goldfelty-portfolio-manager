// The review queue. Nothing is posted unless it's in here with status
// "approved", and only a person approves.
//
// Statuses:
//   draft     written, waiting for review
//   approved  will be posted in the next free slot
//   posting   being posted right now
//   posted    live; result has the link
//   failed    posting failed; error says why. Approve again to retry.
//   rejected  won't be posted
//   manual    yours to post or record by hand (scripts, other people's subreddits)
//   done      you've marked a manual item as done
import crypto from 'node:crypto';
import { readJson, writeJson } from './store.js';
import { X_MAX, xLength, hasMention, hashtagCount, isNearDuplicate } from './text.js';

const FILE = 'queue.json';

export function loadQueue() {
  return readJson(FILE, { items: [] });
}

export function saveQueue(queue) {
  writeJson(FILE, queue);
}

export function newId() {
  return crypto.randomBytes(5).toString('hex');
}

export function itemText(item) {
  const c = item.content || {};
  switch (item.kind) {
    case 'post':
      return c.text || '';
    case 'thread':
      return (c.tweets || []).join('\n\n');
    case 'self':
      return `${c.title || ''}\n\n${c.body || ''}`;
    case 'video':
      return `${c.title || ''}\n\n${c.description || ''}`;
    case 'script':
      return `${c.title || ''}\n\n${c.script || ''}`;
    default:
      return '';
  }
}

export function redditTarget(name) {
  return String(name || '')
    .trim()
    .replace(/^\/?r\//i, '')
    .replace(/^\/?u(ser)?\//i, 'u_');
}

// Problems that stop an item being approved. An empty list means it's fine.
export function problems(item) {
  const out = [];
  const c = item.content || {};
  if (item.platform === 'x') {
    const tweets = item.kind === 'thread' ? c.tweets || [] : [c.text || ''];
    if (item.kind === 'thread' && (tweets.length < 2 || tweets.length > 8)) {
      out.push('A thread needs 2 to 8 posts.');
    }
    tweets.forEach((t, i) => {
      const label = item.kind === 'thread' ? `Post ${i + 1}` : 'The post';
      if (!t.trim()) out.push(`${label} is empty.`);
      if (xLength(t) > X_MAX) out.push(`${label} is ${xLength(t)} characters; X allows ${X_MAX}.`);
      if (hasMention(t)) out.push(`${label} mentions someone (@). Posts don't tag people.`);
      if (hashtagCount(t) > 2) out.push(`${label} has more than 2 hashtags.`);
    });
    if ((c.images || []).length > 4) out.push('X allows at most 4 images.');
  } else if (item.platform === 'reddit') {
    if (!c.title?.trim()) out.push('The title is empty.');
    if ((c.title || '').length > 300) out.push('Reddit titles are at most 300 characters.');
    if (!c.body?.trim()) out.push('The body is empty.');
    if (!redditTarget(c.subreddit)) out.push('Choose where it goes.');
    if (hasMention(c.body || '')) out.push("The body mentions someone (@). Posts don't tag people.");
  } else if (item.platform === 'youtube' && item.kind === 'video') {
    if (!c.file) out.push('No video file.');
    if (!c.title?.trim()) out.push('The title is empty.');
    if ((c.title || '').length > 100) out.push('YouTube titles are at most 100 characters.');
    if ((c.description || '').length > 5000) out.push('YouTube descriptions are at most 5000 characters.');
    if (/[<>]/.test(`${c.title}${c.description}`)) out.push("YouTube doesn't allow < or > in titles and descriptions.");
  }
  return out;
}

// Adds new drafts, leaving out any that repeat something already queued.
export function addItems(queue, items, now = new Date()) {
  const existing = queue.items
    .filter((i) => i.status !== 'rejected')
    .map(itemText);
  const added = [];
  const skipped = [];
  for (const raw of items) {
    const item = {
      id: newId(),
      status: 'draft',
      attempts: 0,
      createdAt: now.toISOString(),
      updatedAt: now.toISOString(),
      ...raw,
    };
    const text = itemText(item);
    if (item.kind !== 'video' && isNearDuplicate(text, existing)) {
      skipped.push({ item, reason: 'too close to something already in the queue' });
      continue;
    }
    existing.push(text);
    queue.items.push(item);
    added.push(item);
  }
  return { added, skipped };
}

export function findItem(queue, id) {
  const matches = queue.items.filter((i) => i.id === id || i.id.startsWith(id));
  if (matches.length !== 1) {
    throw new Error(matches.length ? `"${id}" matches more than one item.` : `No item "${id}".`);
  }
  return matches[0];
}

function touch(item, now) {
  item.updatedAt = now.toISOString();
}

// allowedReddit: subreddits this app may post to by itself (your profile and
// subreddits you moderate). Anything else becomes "manual".
export function approve(item, { allowedReddit = [], now = new Date() } = {}) {
  if (!['draft', 'failed', 'rejected', 'manual'].includes(item.status)) {
    throw new Error(`Can't approve an item that is ${item.status}.`);
  }
  const issues = problems(item);
  if (issues.length) throw new Error(issues.join(' '));
  item.error = undefined;
  item.note = undefined;
  if (item.kind === 'script') {
    item.status = 'manual';
    item.note = 'Record this yourself, then upload the video.';
  } else if (item.platform === 'reddit') {
    const target = redditTarget(item.content.subreddit);
    item.content.subreddit = target;
    const allowed = allowedReddit.map((s) => s.toLowerCase());
    if (allowed.includes(target.toLowerCase())) {
      item.status = 'approved';
    } else {
      item.status = 'manual';
      item.note =
        `r/${target} isn't your profile or a subreddit you moderate, so this app won't post there. ` +
        "If you post it yourself, check that community's rules on self-promotion first.";
    }
  } else {
    item.status = 'approved';
  }
  item.approvedAt = now.toISOString();
  touch(item, now);
  return item;
}

export function reject(item, now = new Date()) {
  if (['posting', 'posted', 'done'].includes(item.status)) {
    throw new Error(`Can't reject an item that is ${item.status}.`);
  }
  item.status = 'rejected';
  touch(item, now);
  return item;
}

export function restore(item, now = new Date()) {
  if (item.status !== 'rejected') throw new Error('Only rejected items can be restored.');
  item.status = 'draft';
  touch(item, now);
  return item;
}

export function markDone(item, url, now = new Date()) {
  if (item.status !== 'manual') throw new Error('Only manual items can be marked done.');
  item.status = 'done';
  item.result = url ? { url } : undefined;
  item.postedAt = now.toISOString();
  touch(item, now);
  return item;
}

// Editing sends an item back to draft, so it gets reviewed again.
export function edit(item, content, now = new Date()) {
  if (!['draft', 'approved', 'failed', 'manual'].includes(item.status)) {
    throw new Error(`Can't edit an item that is ${item.status}.`);
  }
  const allowed = {
    post: ['text'],
    thread: ['tweets'],
    self: ['subreddit', 'title', 'body'],
    video: ['title', 'description', 'privacyStatus'],
    script: ['title', 'script', 'description'],
  }[item.kind];
  for (const key of allowed) {
    if (content[key] === undefined) continue;
    if (key === 'tweets') {
      if (!Array.isArray(content.tweets)) throw new Error('tweets must be a list.');
      item.content.tweets = content.tweets.map(String).filter((t) => t.trim());
    } else if (key === 'privacyStatus') {
      if (!['public', 'unlisted', 'private'].includes(content.privacyStatus)) {
        throw new Error('privacyStatus must be public, unlisted or private.');
      }
      item.content.privacyStatus = content.privacyStatus;
    } else {
      item.content[key] = String(content[key]);
    }
  }
  if (item.status !== 'draft') {
    item.status = 'draft';
    item.note = 'Edited; approve again to post.';
  }
  touch(item, now);
  return item;
}

// Swaps an X post for one of the other openings Claude offered. The old
// text becomes an alternative, so nothing is lost.
export function useAlternative(item, index, now = new Date()) {
  const alts = item.alternatives || [];
  if (item.kind !== 'post' || !alts[index]) throw new Error('No such alternative.');
  const previous = item.content.text;
  edit(item, { text: alts[index] }, now);
  item.alternatives = [...alts.filter((_, i) => i !== index), previous];
  return item;
}

// Images go on the post, or the first post of a thread.
export function setImages(item, files, now = new Date()) {
  if (item.platform !== 'x') throw new Error('Images can only be added to X posts.');
  if (files.length > 4) throw new Error('X allows at most 4 images.');
  if (!['draft', 'approved', 'failed'].includes(item.status)) throw new Error(`Can't change an item that is ${item.status}.`);
  item.content.images = files;
  if (item.status !== 'draft') {
    item.status = 'draft';
    item.note = 'Images changed; approve again to post.';
  }
  touch(item, now);
  return item;
}

// A crash mid-post leaves an item in "posting". Don't retry it blindly: it
// may already be live.
export function recoverInterrupted(queue, now = new Date()) {
  let n = 0;
  for (const item of queue.items) {
    if (item.status === 'posting') {
      item.status = 'failed';
      item.error = 'Interrupted while posting. Check the account before approving it again.';
      touch(item, now);
      n++;
    }
  }
  return n;
}
