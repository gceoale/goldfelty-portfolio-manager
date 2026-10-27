// Autopilot: keeps the queue stocked, checks drafts, and approves the good
// ones, so `run --live --auto` needs nobody.
//
// - When fewer than two days' worth of posts are approved, it writes a batch
//   (at most once every 12 hours).
// - A second Claude pass checks every draft against the facts sheet and the
//   posting rules, picks the strongest opening, and approves or rejects it.
//   The rule checks in queue.js still apply on top.
// - Once a day it writes, voices and renders a funny Short about Goldfelty
//   (see src/video/) and queues it for YouTube.
// - Videos dropped into ~/.goldfelty-social/videos/ get a title and
//   description and are queued for YouTube too.
// - `pause` stops all of it, including posting, until `resume`.
import fs from 'node:fs';
import path from 'node:path';
import { readJson, writeJson, dataPath, appendLog, ensureDataDir } from './store.js';
import * as queueLib from './queue.js';
import { SYSTEM, callClaude, loadFacts } from './generate.js';
import { videoType } from './platforms/youtube.js';
import { makeVideo as defaultMakeVideo } from './video/make.js';
import { parseWindow, minuteOfDay, historyFrom, capCheck } from './schedule.js';

const STATE = 'autopilot.json';
export const GENERATE_EVERY_MS = 12 * 60 * 60_000;
const SETTLE_MS = 2 * 60_000;
export const STOCK_DAYS = 2;
export const VIDEO_EVERY_MS = 20 * 60 * 60_000;
const VIDEO_RETRY_MS = 3 * 60 * 60_000;

export function loadState() {
  return readJson(STATE, { paused: false, lastGeneratedAt: null, lastError: null, lastErrorAt: null });
}

export function saveState(s) {
  writeJson(STATE, s);
}

export function setPaused(paused) {
  const s = loadState();
  s.paused = paused;
  saveState(s);
  appendLog(paused ? 'autopilot paused' : 'autopilot resumed');
  return s;
}

// How many drafts to ask for, per platform, to have STOCK_DAYS of posts ready.
export function stockNeeds(items, config, connected) {
  const approved = (platform, kind) =>
    items.filter((i) => i.platform === platform && i.status === 'approved' && (!kind || i.kind === kind)).length;
  const xTarget = config.x.dailyCap * STOCK_DAYS;
  const threadWanted = connected.x && config.x.threadsPerDay > 0 && approved('x', 'thread') < 1 ? 1 : 0;
  return {
    xPosts: connected.x ? Math.max(0, xTarget - threadWanted - approved('x')) : 0,
    xThreads: threadWanted,
    redditPosts: connected.reddit ? Math.max(0, config.reddit.dailyCap * STOCK_DAYS - approved('reddit')) : 0,
    videoScripts: 0,
  };
}

const REVIEW_SYSTEM = `You are the last check before posts go out automatically on Goldfelty's own X and Reddit accounts. Nobody else reads them first.

Approve a draft only if all of these hold:
- Every claim about Goldfelty is supported by the facts sheet. Numbers, wallet names, networks, features, prices and safety claims must match it exactly.
- No financial advice, price predictions, return promises, urgency or fear.
- It doesn't tag, mention or reply to anyone, and uses at most two hashtags.
- It isn't hype, clickbait or a vague announcement, and it says something specific that a reader would find useful or interesting. A weak post does more harm than no post.
- It wouldn't embarrass the maker if a sceptical reader quoted it.
- It isn't a near-repeat of a recent post.

For an X post with alternatives, choose the strongest version: 0 for the main text, 1 or 2 for an alternative. For anything else choose 0.
Give a short reason for every verdict.`;

const REVIEW_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['reviews'],
  properties: {
    reviews: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['id', 'publish', 'choice', 'reason'],
        properties: {
          id: { type: 'string' },
          publish: { type: 'boolean' },
          choice: { type: 'integer' },
          reason: { type: 'string' },
        },
      },
    },
  },
};

export async function reviewDrafts(client, { config, facts, drafts, recent }) {
  if (!drafts.length) return [];
  const payload = drafts.map((d) => ({
    id: d.id,
    platform: d.platform,
    kind: d.kind,
    content: d.content,
    alternatives: d.alternatives || [],
    basis: d.basis,
  }));
  const prompt = `<facts>
${facts}
</facts>

<recent_posts>
${recent.map((t) => `- ${t.replace(/\s+/g, ' ').slice(0, 280)}`).join('\n') || '(none)'}
</recent_posts>

<drafts>
${JSON.stringify(payload, null, 2)}
</drafts>

Review every draft above. Return one review per draft id.`;
  const out = await callClaude(client, {
    model: config.model,
    effort: 'high',
    system: REVIEW_SYSTEM,
    prompt,
    schema: REVIEW_SCHEMA,
  });
  return out.reviews || [];
}

// Applies the reviews: picks the chosen opening, approves or rejects. Items
// the reviewer skipped stay as drafts.
export function applyReviews(queue, reviews, { allowedReddit, now }) {
  const result = { approved: [], rejected: [] };
  for (const r of reviews) {
    const item = queue.items.find((i) => i.id === r.id && i.status === 'draft');
    if (!item) continue;
    try {
      if (!r.publish) throw new Error(r.reason);
      if (item.kind === 'post' && r.choice > 0 && item.alternatives?.[r.choice - 1]) {
        queueLib.useAlternative(item, r.choice - 1, now);
      }
      queueLib.approve(item, { allowedReddit, now });
      if (item.status !== 'approved') throw new Error(item.note || 'Not something autopilot can post.');
      item.note = `Auto-approved: ${r.reason}`;
      result.approved.push(item);
    } catch (err) {
      item.status = 'rejected';
      item.note = `Auto-review: ${err.message}`;
      item.updatedAt = now.toISOString();
      result.rejected.push(item);
    }
  }
  return result;
}

const VIDEO_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['title', 'description'],
  properties: { title: { type: 'string' }, description: { type: 'string' } },
};

export function videoInbox() {
  const dir = dataPath('videos');
  ensureDataDir();
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  return dir;
}

// New, fully copied video files in the inbox that aren't queued yet.
export function newVideos(items, nowMs) {
  const dir = videoInbox();
  const known = new Set(items.filter((i) => i.kind === 'video').map((i) => i.content.file));
  return fs
    .readdirSync(dir)
    .map((name) => path.join(dir, name))
    .filter((file) => videoType(file) && !known.has(file))
    .filter((file) => nowMs - fs.statSync(file).mtimeMs > SETTLE_MS);
}

export async function describeVideo(client, { config, facts, file }) {
  const notesFile = file.replace(/\.[^.]+$/, '.txt');
  const notes = fs.existsSync(notesFile) ? fs.readFileSync(notesFile, 'utf8').slice(0, 4000) : '';
  const prompt = `<facts>
${facts}
</facts>

Write the YouTube title (at most 90 characters, no < or >) and description (2 to 4 sentences, ending with https://goldfelty.com, no < or >) for a video the maker recorded.
File name: ${path.basename(file)}
${notes ? `Maker's notes about the video:\n${notes}` : 'No notes; go by the file name, and keep the description general enough to be true.'}`;
  return callClaude(client, { model: config.model, effort: config.effort, system: SYSTEM, prompt, schema: VIDEO_SCHEMA });
}

// In the cloud: is now inside a YouTube window, with today's upload unused?
export function videoSlotOpen(deps, now) {
  const minute = minuteOfDay(now);
  const open = deps.config.youtube.windows.map(parseWindow).some((w) => minute >= w.start && minute < w.end);
  if (!open) return false;
  const history = historyFrom(queueLib.loadQueue().items);
  return !capCheck({ item: { platform: 'youtube', kind: 'video' }, history, config: deps.config, now });
}

// One autopilot pass. `app` is passed in to avoid an import cycle.
export async function autopilotStep(deps, { app, client, makeVideo = defaultMakeVideo }) {
  const state = loadState();
  if (state.paused) return { paused: true };
  const now = new Date(deps.now());
  const connected = Object.fromEntries(Object.entries(app.connections(deps)).map(([p, c]) => [p, c.connected]));
  const tokens = deps.tokens.load();
  const report = { generated: 0, approved: 0, rejected: 0, videos: 0 };

  // 1. Keep two days of posts ready.
  const needs = stockNeeds(queueLib.loadQueue().items, deps.config, connected);
  const wanted = needs.xPosts + needs.xThreads + needs.redditPosts;
  const due = !state.lastGeneratedAt || now - new Date(state.lastGeneratedAt) >= GENERATE_EVERY_MS;
  if (wanted > 0 && due) {
    state.lastGeneratedAt = now.toISOString();
    saveState(state);
    // Ask for a few extra: the review will turn some down.
    const counts = {
      xPosts: needs.xPosts ? Math.min(needs.xPosts + 2, 10) : 0,
      xThreads: needs.xThreads,
      redditPosts: needs.redditPosts ? needs.redditPosts + 1 : 0,
      videoScripts: 0,
    };
    const { added } = await app.generateDrafts(deps, { counts, client, source: 'autopilot' });
    report.generated = added.length;
    const q = queueLib.loadQueue();
    const drafts = q.items.filter((i) => i.status === 'draft' && i.source === 'autopilot');
    const recent = q.items.filter((i) => i.status === 'posted').slice(-30).map(queueLib.itemText);
    const reviews = await reviewDrafts(client, { config: deps.config, facts: loadFacts(), drafts, recent });
    const fresh = queueLib.loadQueue();
    const { approved, rejected } = applyReviews(fresh, reviews, {
      allowedReddit: app.allowedReddit(tokens),
      now: new Date(deps.now()),
    });
    queueLib.saveQueue(fresh);
    report.approved = approved.length;
    report.rejected = rejected.length;
    appendLog(`autopilot: wrote ${added.length}, approved ${approved.length}, rejected ${rejected.length}`);
    deps.log(`Autopilot wrote ${added.length} drafts: ${approved.length} approved, ${rejected.length} turned down.`);
  }

  // 2. Videos you dropped in the inbox.
  if (connected.youtube) {
    for (const file of newVideos(queueLib.loadQueue().items, deps.now())) {
      const meta = await describeVideo(client, { config: deps.config, facts: loadFacts(), file });
      const item = app.addVideo(file, { title: meta.title.slice(0, 100), description: meta.description }, deps);
      try {
        app.approveItem(item.id, deps);
        report.videos++;
        deps.log(`Autopilot queued ${path.basename(file)} for YouTube: "${meta.title}"`);
      } catch (err) {
        deps.log(`Autopilot couldn't queue ${path.basename(file)}: ${err.message}`);
      }
    }
  }
  // 3. A Short of our own, once a day, when none is waiting to go out.
  if (connected.youtube && deps.config.video.auto) {
    const s = loadState();
    const waiting = queueLib
      .loadQueue()
      .items.some((i) => i.platform === 'youtube' && i.kind === 'video' && ['approved', 'posting'].includes(i.status));
    const sinceMade = s.lastVideoAt ? now - new Date(s.lastVideoAt) : Infinity;
    const sinceTried = s.lastVideoTryAt ? now - new Date(s.lastVideoTryAt) : Infinity;
    const inWindow = !deps.cloud || videoSlotOpen(deps, now);
    if (!waiting && inWindow && sinceMade >= VIDEO_EVERY_MS && sinceTried >= VIDEO_RETRY_MS) {
      s.lastVideoTryAt = now.toISOString();
      saveState(s);
      deps.log('Autopilot is making today’s Short…');
      const made = await makeVideo(deps, { client, log: deps.log });
      const item = app.addVideo(
        made.file,
        { title: made.spec.title, description: made.spec.description, premise: made.spec.premise, format: made.spec.format, source: 'autopilot' },
        deps,
      );
      app.approveItem(item.id, deps);
      const after = loadState();
      after.lastVideoAt = new Date(deps.now()).toISOString();
      saveState(after);
      report.made = 1;
      deps.log(`Autopilot made "${made.spec.title}" (${made.duration.toFixed(0)}s) and queued it for YouTube.`);
      // The file won't outlive a cloud run, so it goes out now.
      if (deps.cloud) await app.publishOne(item.id, deps);
    }
  }
  return report;
}
