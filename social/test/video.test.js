import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { tmpHome, makeTestDeps, freshToken } from './helpers.js';
import { normalizeConfig } from '../src/config.js';
import { parseWords, buildTimeline, DEMO } from '../src/video/timeline.js';
import { normalizeSpec, writeVideo, SPEC_SCHEMA, MAX_WORDS } from '../src/video/script.js';
import { DEMOS, DEMO_NAMES, loadAssets } from '../src/video/demos.js';
import { findFfmpeg, makeSfx, makeBed, mixAudio, playerHtml, launch } from '../src/video/render.js';
import { makeVideo, SAMPLE, videoHistory } from '../src/video/make.js';
import { saveQueue, loadQueue } from '../src/queue.js';
import { autopilotStep, saveState, loadState } from '../src/autopilot.js';
import * as app from '../src/app.js';

const home = tmpHome();
fs.writeFileSync(path.join(home, 'facts.md'), 'Goldfelty is a free desktop app.');
const sample = JSON.parse(fs.readFileSync(SAMPLE, 'utf8'));
const config = normalizeConfig({});
const ffmpeg = await findFfmpeg(config);
let canPlay = true;
try {
  await (await launch()).close();
} catch {
  canPlay = false;
}

function seconds(file) {
  let err = '';
  try {
    execFileSync(ffmpeg, ['-hide_banner', '-i', file], { stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (e) {
    err = String(e.stderr);
  }
  const m = /Duration: (\d+):(\d+):([\d.]+)/.exec(err);
  return m ? Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]) : 0;
}

test('emphasis: starred words are marked, across two words too', () => {
  assert.deepEqual(parseWords('Every wallet. *One app.*'), [
    { w: 'Every', em: false },
    { w: 'wallet.', em: false },
    { w: 'One', em: true },
    { w: 'app.', em: true },
  ]);
  assert.deepEqual(parseWords('a *b* c').map((x) => x.em), [false, true, false]);
});

test('the timeline runs beats back to back, with sound on the cuts and clicks', () => {
  const spec = normalizeSpec(sample);
  const tl = buildTimeline(spec, DEMOS);
  for (let i = 1; i < tl.beats.length; i++) assert.equal(tl.beats[i].start, tl.beats[i - 1].end);
  assert.ok(tl.duration > 14 && tl.duration < 24, `got ${tl.duration}s`);
  const connect = tl.beats.find((b) => b.demo === 'connect');
  assert.ok(tl.sfx.some((e) => e.sfx === 'click' && Math.abs(e.at - (connect.start + DEMO.click)) < 1e-9));
  assert.ok(tl.sfx.some((e) => e.sfx === 'pop'), 'a swap without a click pops');
  assert.equal(tl.sfx.filter((e) => e.sfx === 'chime').length, 1);
});

test('scripts are tidied: one end card last, demo beats need a real demo', () => {
  const spec = normalizeSpec({
    title: 'T <b>*x*', description: 'D', premise: 'p',
    beats: [
      { kind: 'end', text: 'Early end', demo: 'none' },
      { kind: 'type', text: 'Hook line', demo: 'connect' },
      { kind: 'demo', text: 'No demo', demo: 'none' },
      { kind: 'demo', text: 'Real one', demo: 'send' },
    ],
  });
  assert.deepEqual(spec.beats.map((b) => b.kind), ['type', 'demo', 'end']);
  assert.equal(spec.beats[0].demo, 'none');
  assert.equal(spec.beats.at(-1).text, 'Early end');
  assert.equal(spec.title, 'T bx');
  assert.match(spec.description, /goldfelty\.com/);
  assert.throws(() => normalizeSpec({ beats: [{ kind: 'type', text: 'one', demo: 'none' }] }), /too short/);
  assert.throws(() => normalizeSpec({ beats: [{ kind: 'type', text: 'w '.repeat(MAX_WORDS + 5), demo: 'none' }, { kind: 'type', text: 'b', demo: 'none' }] }), /too long/);
});

test('the script schema only allows real demos, and every demo has its screens', () => {
  const beat = SPEC_SCHEMA.properties.beats.items.properties;
  assert.deepEqual(beat.demo.enum.slice(1).sort(), [...DEMO_NAMES].sort());
  const assets = loadAssets(DEMO_NAMES);
  for (const d of Object.values(DEMOS)) {
    assert.ok(assets.screens[d.from] && assets.screens[d.to]);
    for (const [x, y, w, h] of [d.focus, d.after]) assert.ok(x >= 0 && y >= 0 && x + w <= 1240 && y + h <= 800);
    if (d.click) assert.ok(d.click[0] < 1240 && d.click[1] < 800);
  }
});

function fakeClient(answers) {
  const requests = [];
  return {
    requests,
    beta: { messages: { create: async (req) => { requests.push(req); return { stop_reason: 'end_turn', content: [{ type: 'text', text: JSON.stringify(answers.shift()) }] }; } } },
  };
}

test('a script that isn’t sharp enough is rewritten with the editor’s notes', async () => {
  const client = fakeClient([
    sample,
    { funny: 8, hook: 8, premium: 5, accurate: true, publish: false, notes: 'Line two reads like an ad. Cut "seamless".' },
    sample,
    { funny: 8, hook: 8, premium: 9, accurate: true, publish: true, notes: 'Good.' },
  ]);
  const { spec, review } = await writeVideo(client, { config, facts: 'F' });
  assert.equal(review.premium, 9);
  assert.equal(spec.title, sample.title);
  assert.match(client.requests[2].messages[0].content, /reads like an ad/);
  assert.match(client.requests[0].system, /no voice-over/);
});

test('an inaccurate script is never accepted, however good', async () => {
  const bad = { funny: 10, hook: 10, premium: 10, accurate: false, publish: true, notes: 'Claims an audit.' };
  const client = fakeClient([sample, bad, sample, bad, sample, bad]);
  await assert.rejects(writeVideo(client, { config, facts: 'F' }), /good enough/);
});

test('sound design and the pad mix to the video’s length', async () => {
  const sfx = await makeSfx(ffmpeg, path.join(home, 'sfx'));
  for (const name of ['click', 'pop', 'whoosh', 'chime']) assert.ok(seconds(sfx[name]) > 0.05, name);
  const bed = await makeBed(ffmpeg, 6, path.join(home, 'bed.wav'));
  assert.ok(Math.abs(seconds(bed) - 6) < 0.1);
  const out = path.join(home, 'mix.m4a');
  await mixAudio({ ffmpeg, sfxEvents: [{ sfx: 'click', at: 1 }, { sfx: 'chime', at: 4 }], sfxFiles: sfx, duration: 6, musicDir: null, seed: 's', output: out, bed });
  assert.ok(Math.abs(seconds(out) - 6) < 0.15);
});

test('the player draws every beat of the sample without errors', { skip: !canPlay && 'no browser' }, async () => {
  const spec = normalizeSpec(sample);
  const tl = buildTimeline(spec, DEMOS);
  const browser = await launch();
  const page = await browser.newPage({ viewport: { width: 1080, height: 1920 } });
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.setContent(playerHtml({ timeline: tl, assets: loadAssets([...new Set(spec.beats.map((b) => b.demo))]) }));
  assert.ok(Math.abs((await page.evaluate(() => window.ready())) - tl.duration) < 1e-6);
  for (const b of tl.beats) {
    await page.evaluate((x) => window.renderAt(x), b.start + 1.2);
    const text = await page.locator('#stage').innerText();
    assert.ok(text.includes(b.words[0].w), `${b.kind} shows its line`);
    if (b.kind === 'end') assert.match(text, /goldfelty\.com/);
    if (b.kind === 'demo') assert.match(text, /demo wallets/i);
    if (b.kind === 'demo' && DEMOS[b.demo].click) {
      await page.evaluate((x) => window.renderAt(x), b.start + DEMO.click);
      assert.equal(await page.locator('#cursor').count(), 1);
    }
  }
  await browser.close();
  assert.deepEqual(errors, []);
});

test('a short video renders end to end', { skip: !canPlay && 'no browser', timeout: 120_000 }, async () => {
  const spec = { ...sample, beats: [sample.beats[0], sample.beats[2], sample.beats.at(-1)] };
  const { deps } = makeTestDeps({ now: Date.now() });
  const made = await makeVideo(deps, { spec, outDir: path.join(home, 'out') });
  assert.ok(fs.existsSync(made.file));
  assert.ok(Math.abs(seconds(made.file) - made.duration) < 0.3);
  assert.ok(fs.existsSync(made.file.replace(/\.mp4$/, '.json')));
});

test('video history steers new scripts away from repeats and toward what worked', () => {
  const v = (premise, views) => ({ kind: 'video', status: 'posted', content: { premise, format: 'chat' }, metrics: { views, likes: views / 20, replies: 2, reposts: 0 } });
  const h = videoHistory([v('wallets group chat', 9000), v('tabs nature documentary', 300), v('3am portfolio check', 4000)]);
  assert.deepEqual(h.recentPremises, ['wallets group chat', 'tabs nature documentary', '3am portfolio check']);
  assert.match(h.lessons.split('\n')[0], /9000 views/);
});

test('autopilot makes one Short a day and queues it for YouTube', async () => {
  saveQueue({ items: [] });
  saveState({ paused: false });
  const mp4 = path.join(home, 'made.mp4');
  fs.writeFileSync(mp4, 'x');
  let calls = 0;
  const makeVideoStub = async () => {
    calls++;
    return { file: mp4, duration: 38, spec: { title: 'My 7 wallets have a group chat #Shorts', description: 'd https://goldfelty.com', premise: 'group chat', format: 'chat' } };
  };
  const { deps, clock } = makeTestDeps({ tokens: { youtube: freshToken({ username: 'Goldfelty' }) }, now: Date.now() });
  await autopilotStep(deps, { app, client: {}, makeVideo: makeVideoStub });
  assert.equal(calls, 1);
  const [item] = loadQueue().items;
  assert.equal(item.status, 'approved');
  assert.equal(item.content.premise, 'group chat');
  assert.equal(item.source, 'autopilot');

  // Waiting to go out: no second video.
  clock.t += 25 * 3600_000;
  await autopilotStep(deps, { app, client: {}, makeVideo: makeVideoStub });
  assert.equal(calls, 1);

  // Posted, but less than 20 hours since the last one: still no.
  const q = loadQueue();
  q.items[0].status = 'posted';
  saveQueue(q);
  const s = loadState();
  s.lastVideoAt = new Date(clock.t - 3600_000).toISOString();
  s.lastVideoTryAt = s.lastVideoAt;
  saveState(s);
  await autopilotStep(deps, { app, client: {}, makeVideo: makeVideoStub });
  assert.equal(calls, 1);
  clock.t += 20 * 3600_000;
  await autopilotStep(deps, { app, client: {}, makeVideo: makeVideoStub });
  assert.equal(calls, 2);
});

test('a failed video is retried after three hours, not every tick', async () => {
  saveQueue({ items: [] });
  saveState({ paused: false });
  let calls = 0;
  const failing = async () => {
    calls++;
    throw new Error('no browser');
  };
  const { deps, clock } = makeTestDeps({ tokens: { youtube: freshToken() }, now: Date.now() });
  await assert.rejects(autopilotStep(deps, { app, client: {}, makeVideo: failing }), /no browser/);
  clock.t += 3600_000;
  await autopilotStep(deps, { app, client: {}, makeVideo: failing });
  assert.equal(calls, 1);
  clock.t += 3 * 3600_000;
  await assert.rejects(autopilotStep(deps, { app, client: {}, makeVideo: failing }));
  assert.equal(calls, 2);
});
