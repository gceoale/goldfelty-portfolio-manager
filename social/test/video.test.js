import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { tmpHome, makeTestDeps, freshToken } from './helpers.js';
import { normalizeConfig } from '../src/config.js';
import { wordTimes, buildTimeline } from '../src/video/timeline.js';
import { normalizeSpec, writeVideo, SPEC_SCHEMA } from '../src/video/script.js';
import { chooseProvider, castVoices, speak, wavDuration, silence } from '../src/video/tts.js';
import { findFfmpeg, makeSfx, mixAudio, playerHtml, launch } from '../src/video/render.js';
import { loadAssets, SCREENS } from '../src/video/screens.js';
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

test('words share a line’s time, longer words taking longer', () => {
  const w = wordTimes('Hi extraordinary', 1, 3);
  assert.equal(w[0].start, 1);
  assert.ok(Math.abs(w.at(-1).end - 3) < 1e-9);
  assert.ok(w[1].end - w[1].start > w[0].end - w[0].start);
});

test('the timeline runs scenes back to back with sound effects', () => {
  const spec = normalizeSpec(sample);
  const durations = spec.scenes.map((s) => s.lines.map(() => 1.5));
  const tl = buildTimeline(spec, durations);
  for (let i = 1; i < tl.scenes.length; i++) assert.equal(tl.scenes[i].start, tl.scenes[i - 1].end);
  assert.ok(tl.duration > tl.scenes.at(-1).end - 0.01);
  const chat = tl.scenes.find((s) => s.kind === 'chat');
  assert.equal(tl.sfx.filter((e) => e.sfx === 'pop' && e.at >= chat.start && e.at < chat.end).length, chat.lines.length);
  assert.ok(tl.sfx.some((e) => e.sfx === 'boom'));
  assert.ok(tl.sfx.some((e) => e.sfx === 'fail'));
  assert.ok(tl.scenes.find((s) => s.kind === 'outro').end - tl.scenes.find((s) => s.kind === 'outro').start >= 2.8);
});

test('scripts are tidied: unknown speakers, missing screens, no outro', () => {
  const spec = normalizeSpec({
    title: 'T <b>', description: 'D', premise: 'p', format: 'f',
    cast: [{ id: 'a', name: 'A', voice: 'anxious', look: 'person', color: 'blue' }],
    scenes: [
      { kind: 'hook', caption: 'Hi', screen: 'none', hotspot: 'none', chaos_items: [], lines: [{ speaker: 'zzz', text: 'Hello', sfx: 'none' }] },
      { kind: 'app', caption: '', screen: 'nope', hotspot: 'none', chaos_items: [], lines: [{ speaker: 'a', text: 'Look', sfx: 'laser' }] },
      { kind: 'dialogue', caption: '', screen: 'none', hotspot: 'none', chaos_items: [], lines: [{ speaker: 'a', text: 'Yes', sfx: 'none' }] },
    ],
  });
  assert.equal(spec.scenes[0].lines[0].speaker, 'a');
  assert.equal(spec.scenes[1].screen, 'overview');
  assert.equal(spec.scenes[1].lines[0].sfx, 'none');
  assert.equal(spec.scenes.at(-1).kind, 'outro');
  assert.equal(spec.title, 'T b');
  assert.match(spec.description, /goldfelty\.com/);
  assert.throws(() => normalizeSpec({ cast: [], scenes: [] }), /no cast/);
});

test('the script schema only allows real screens and hotspots', () => {
  const scene = SPEC_SCHEMA.properties.scenes.items.properties;
  assert.deepEqual(scene.screen.enum.slice(1).sort(), Object.keys(SCREENS).sort());
  for (const s of Object.values(SCREENS)) {
    for (const h of Object.keys(s.hotspots)) assert.ok(scene.hotspot.enum.includes(h));
  }
});

function fakeClient(answers) {
  const requests = [];
  return {
    requests,
    beta: {
      messages: {
        create: async (req) => {
          requests.push(req);
          const body = answers.shift();
          return { stop_reason: 'end_turn', content: [{ type: 'text', text: JSON.stringify(body) }] };
        },
      },
    },
  };
}

test('a script that isn’t funny enough is rewritten with the editor’s notes', async () => {
  const client = fakeClient([
    sample,
    { funny: 5, hook: 8, accurate: true, publish: false, notes: 'The chat joke needs a sharper turn.' },
    sample,
    { funny: 8, hook: 8, accurate: true, publish: true, notes: 'Good.' },
  ]);
  const { spec, review } = await writeVideo(client, { config, facts: 'F' });
  assert.equal(review.funny, 8);
  assert.equal(spec.title, sample.title);
  assert.equal(client.requests.length, 4);
  assert.match(client.requests[2].messages[0].content, /sharper turn/);
  assert.equal(client.requests[1].output_config.effort, 'high');
});

test('an inaccurate script is never accepted, however funny', async () => {
  const bad = { funny: 10, hook: 10, accurate: false, publish: true, notes: 'Claims an audit.' };
  const client = fakeClient([sample, bad, sample, bad, sample, bad]);
  await assert.rejects(writeVideo(client, { config, facts: 'F' }), /funny or accurate/);
});

test('voices: provider from keys, distinct voices per character', () => {
  assert.equal(chooseProvider(normalizeConfig({ video: { openaiApiKey: 'k' } })), 'openai');
  assert.equal(chooseProvider(normalizeConfig({ video: { elevenlabsApiKey: 'k' } })), 'elevenlabs');
  assert.equal(chooseProvider(normalizeConfig({ video: { tts: 'none', openaiApiKey: 'k' } })), 'none');
  const v = castVoices([
    { id: 'a', voice: 'deadpan' },
    { id: 'b', voice: 'deadpan' },
  ], 'openai');
  assert.notEqual(v.a.openai, v.b.openai);
});

test('OpenAI voices are requested with a delivery style, trimmed and cached', async () => {
  const mp3 = path.join(home, 'tone.mp3');
  execFileSync(ffmpeg, ['-y', '-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', "aevalsrc='if(between(t,0.5,1.5),0.5*sin(2*PI*440*t),0)':s=48000:d=1.8", mp3]);
  // Half a second of silence, then a one-second tone.
  const bytes = fs.readFileSync(mp3);
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, body: JSON.parse(init.body), auth: init.headers.Authorization });
    return new Response(bytes, { status: 200 });
  };
  const cfg = normalizeConfig({ video: { openaiApiKey: 'sk-test' } });
  const voice = castVoices([{ id: 'n', voice: 'dramatic' }], 'openai').n;
  const out = await speak({ text: 'In a world', voice, provider: 'openai', config: cfg, ffmpeg, cacheDir: path.join(home, 'cache'), fetchImpl });
  assert.equal(calls[0].url, 'https://api.openai.com/v1/audio/speech');
  assert.equal(calls[0].body.model, 'gpt-4o-mini-tts');
  assert.match(calls[0].body.instructions, /trailer/);
  assert.equal(calls[0].auth, 'Bearer sk-test');
  assert.ok(out.duration > 0.9 && out.duration < 1.2, `trimmed to the tone, got ${out.duration}`);
  await speak({ text: 'In a world', voice, provider: 'openai', config: cfg, ffmpeg, cacheDir: path.join(home, 'cache'), fetchImpl });
  assert.equal(calls.length, 1);
});

test('a voice that comes back silent falls back to a reading-speed pause', async () => {
  const quiet = path.join(home, 'quiet.mp3');
  execFileSync(ffmpeg, ['-y', '-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'anullsrc=r=48000:cl=mono', '-t', '1', quiet]);
  const bytes = fs.readFileSync(quiet);
  const cfg = normalizeConfig({ video: { openaiApiKey: 'sk-test' } });
  const voice = castVoices([{ id: 'n', voice: 'deadpan' }], 'openai').n;
  const out = await speak({ text: 'three little words', voice, provider: 'openai', config: cfg, ffmpeg, cacheDir: path.join(home, 'cache2'), fetchImpl: async () => new Response(bytes) });
  assert.ok(Math.abs(out.duration - (0.4 + 3 * 0.36)) < 0.02);
});

test('silent mode gives every line a reading-speed duration', async () => {
  const out = await speak({ text: 'one two three four five', voice: {}, provider: 'none', config, ffmpeg, cacheDir: path.join(home, 'cache') });
  assert.ok(Math.abs(out.duration - (0.4 + 5 * 0.36)) < 0.02);
  assert.ok(Math.abs(wavDuration(out.file) - out.duration) < 0.02);
});

test('sound effects and the mix come out at the right length', async () => {
  const sfx = await makeSfx(ffmpeg, path.join(home, 'sfx'));
  for (const f of Object.values(sfx)) assert.ok(wavDuration(f) > 0.1);
  const a = path.join(home, 'a.wav');
  await silence(ffmpeg, 1, a);
  const out = path.join(home, 'mix.m4a');
  await mixAudio({ ffmpeg, lines: [{ file: a, start: 0.5 }], sfxEvents: [{ sfx: 'pop', at: 0.2 }, { sfx: 'boom', at: 1 }], sfxFiles: sfx, duration: 3, musicDir: null, seed: 's', output: out });
  const probe = execFileSync(ffmpeg, ['-hide_banner', '-i', out, '-f', 'null', '-'], { stdio: ['ignore', 'pipe', 'pipe'] }).toString();
  assert.ok(fs.statSync(out).size > 1000, probe);
});

test('the player page draws every scene of the sample without errors', { skip: !canPlay && 'no browser' }, async () => {
  const spec = normalizeSpec(sample);
  const tl = buildTimeline(spec, spec.scenes.map((s) => s.lines.map(() => 1.2)));
  const screens = [...new Set(['overview', ...spec.scenes.map((s) => s.screen).filter((s) => s !== 'none')])];
  const browser = await launch();
  const page = await browser.newPage({ viewport: { width: 1080, height: 1920 } });
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.setContent(playerHtml({ timeline: tl, cast: spec.cast, assets: loadAssets(screens) }));
  assert.ok(Math.abs((await page.evaluate(() => window.ready())) - tl.duration) < 1e-6);
  for (const s of tl.scenes) {
    for (const t of [s.start + 0.01, (s.start + s.end) / 2, s.end - 0.02]) {
      await page.evaluate((x) => window.renderAt(x), t);
    }
    const text = await page.locator('#stage').innerText();
    if (s.kind === 'chat') assert.match(text, /3 people/);
    if (s.kind === 'outro') assert.match(text, /goldfelty\.com/);
  }
  await browser.close();
  assert.deepEqual(errors, []);
});

test('a short video renders end to end', { skip: !canPlay && 'no browser', timeout: 120_000 }, async () => {
  const spec = {
    ...sample,
    scenes: [sample.scenes[0], sample.scenes.at(-1)].map((s) => ({ ...s, lines: s.lines.slice(0, 1) })),
  };
  // normalizeSpec needs three scenes; add a short punchline.
  spec.scenes.splice(1, 0, { kind: 'punchline', caption: 'Wow', screen: 'none', hotspot: 'none', chaos_items: [], lines: [] });
  const { deps } = makeTestDeps({ config: { video: { tts: 'none' } }, now: Date.now() });
  const made = await makeVideo(deps, { spec, outDir: path.join(home, 'out') });
  const info = execFileSync(ffmpeg, ['-hide_banner', '-i', made.file, '-f', 'null', '-'], { stdio: ['ignore', 'pipe', 'pipe'] });
  assert.ok(fs.existsSync(made.file));
  assert.ok(made.duration > 5 && made.duration < 15);
  assert.ok(fs.existsSync(made.file.replace(/\.mp4$/, '.json')));
  assert.ok(info !== undefined);
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
