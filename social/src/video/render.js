// Renders a timed script to a vertical MP4: the player page is drawn frame
// by frame in a headless browser and piped into ffmpeg with the mixed audio.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { once } from 'node:events';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

const run = promisify(execFile);
const PLAYER = fileURLToPath(new URL('./player.html', import.meta.url));
export const FPS = 30;

export async function findFfmpeg(config) {
  if (config.video?.ffmpeg) return config.video.ffmpeg;
  try {
    const mod = await import('ffmpeg-static');
    if (mod.default && fs.existsSync(mod.default)) return mod.default;
  } catch {
    /* optional dependency not installed */
  }
  return 'ffmpeg';
}

// Sound design, made by ffmpeg itself: nothing to license.
const SFX = {
  click: ['-f', 'lavfi', '-i', "aevalsrc='0.55*exp(-900*t)*sin(2*PI*2400*t)+0.35*exp(-260*t)*sin(2*PI*620*t)':s=48000:d=0.08"],
  pop: ['-f', 'lavfi', '-i', "aevalsrc='0.35*sin(2*PI*t*(480+900*t))*exp(-28*t)':s=48000:d=0.18"],
  whoosh: ['-f', 'lavfi', '-i', 'anoisesrc=d=0.5:c=pink:r=48000:a=0.5', '-af', 'bandpass=f=900:width_type=h:w=1300,afade=t=in:d=0.22,afade=t=out:st=0.22:d=0.28'],
  chime: ['-f', 'lavfi', '-i', "aevalsrc='0.22*(sin(2*PI*1046.5*t)+0.6*sin(2*PI*1568*t)+0.3*sin(2*PI*2093*t))*exp(-3*t)':s=48000:d=1.8", '-af', 'aecho=0.8:0.6:90|180:0.25|0.15'],
};
const LEVEL = { click: 0.9, pop: 0.5, whoosh: 0.22, chime: 0.55 };

// A quiet, warm pad under the whole video when there's no music of your own.
export async function makeBed(ffmpeg, seconds, output) {
  const notes = [110, 164.81, 261.63, 329.63, 493.88];
  const gains = [1, 0.7, 0.5, 0.4, 0.22];
  const voice = notes.map((f, i) => `${gains[i]}*sin(2*PI*${f}*t+${i})`).join('+');
  const expr = `0.07*(${voice})*(0.78+0.22*sin(2*PI*0.13*t))`;
  await run(ffmpeg, [
    '-y', '-hide_banner', '-loglevel', 'error',
    '-f', 'lavfi', '-i', `aevalsrc='${expr}':s=48000:d=${seconds.toFixed(2)}`,
    '-af', `lowpass=f=1600,aecho=0.8:0.7:140|280:0.3|0.2,afade=t=in:d=1.2,afade=t=out:st=${Math.max(0, seconds - 1.6).toFixed(2)}:d=1.6,atrim=0:${seconds.toFixed(2)}`,
    '-ac', '1', '-ar', '48000', '-c:a', 'pcm_s16le', output,
  ]);
  return output;
}

export async function makeSfx(ffmpeg, dir) {
  fs.mkdirSync(dir, { recursive: true });
  const out = {};
  for (const [name, args] of Object.entries(SFX)) {
    const file = path.join(dir, `${name}.wav`);
    if (!fs.existsSync(file)) {
      await run(ffmpeg, ['-y', '-hide_banner', '-loglevel', 'error', ...args, '-ac', '1', '-ar', '48000', '-c:a', 'pcm_s16le', file]);
    }
    out[name] = file;
  }
  return out;
}

function pickMusic(dir, seed) {
  if (!dir || !fs.existsSync(dir)) return null;
  const tracks = fs.readdirSync(dir).filter((f) => /\.(mp3|m4a|wav|ogg|flac)$/i.test(f)).sort();
  if (!tracks.length) return null;
  const n = crypto.createHash('sha256').update(seed).digest().readUInt32BE(0) % tracks.length;
  return path.join(dir, tracks[n]);
}

// Sound effects with your music (or the pad), mixed and loudness-normalised
// for YouTube (-14 LUFS).
export async function mixAudio({ ffmpeg, lines = [], sfxEvents, sfxFiles, duration, musicDir, seed, output, bed = null }) {
  const inputs = [];
  const chains = [];
  let n = 0;
  for (const l of lines) {
    inputs.push('-i', l.file);
    chains.push(`[${n}:a]adelay=delays=${Math.round(l.start * 1000)}:all=1,volume=1.0[a${n}]`);
    n++;
  }
  for (const e of sfxEvents) {
    if (!sfxFiles[e.sfx]) continue;
    inputs.push('-i', sfxFiles[e.sfx]);
    chains.push(`[${n}:a]adelay=delays=${Math.round(e.at * 1000)}:all=1,volume=${LEVEL[e.sfx] ?? 0.4}[a${n}]`);
    n++;
  }
  const music = pickMusic(musicDir, seed);
  if (music) {
    inputs.push('-stream_loop', '-1', '-i', music);
    chains.push(`[${n}:a]aformat=sample_rates=48000:channel_layouts=mono,volume=0.3,afade=t=in:d=0.6,afade=t=out:st=${Math.max(0, duration - 1.2).toFixed(2)}:d=1.2[a${n}]`);
    n++;
  } else if (bed) {
    inputs.push('-i', bed);
    chains.push(`[${n}:a]volume=0.5[a${n}]`);
    n++;
  }
  if (!n) throw new Error('Nothing to mix.');
  const labels = Array.from({ length: n }, (_, i) => `[a${i}]`).join('');
  const graph = `${chains.join(';')};${labels}amix=inputs=${n}:normalize=0:dropout_transition=0,apad,atrim=0:${duration.toFixed(3)},loudnorm=I=-14:TP=-1.5:LRA=11[out]`;
  await run(ffmpeg, ['-y', '-hide_banner', '-loglevel', 'error', ...inputs, '-filter_complex', graph, '-map', '[out]', '-ar', '48000', '-ac', '2', '-c:a', 'aac', '-b:a', '192k', output], { maxBuffer: 1 << 24 });
  return { music };
}

export async function launch() {
  let chromium;
  try {
    ({ chromium } = await import('playwright'));
  } catch {
    throw new Error('Video needs Playwright: run "npm install" in the goldfelty-social folder.');
  }
  const errors = [];
  for (const opts of [{}, { channel: 'chrome' }, { channel: 'msedge' }]) {
    try {
      return await chromium.launch(opts);
    } catch (err) {
      errors.push(err.message.split('\n')[0]);
    }
  }
  throw new Error(`Couldn't start a browser to draw the video. Run "npx playwright install chromium". (${errors[0]})`);
}

export function playerHtml(data) {
  const json = JSON.stringify(data).replace(/</g, '\\u003c');
  return fs.readFileSync(PLAYER, 'utf8').replace('/*__DATA__*/null', json);
}

// Draws every frame and encodes the MP4. Returns the frame count.
export async function renderFrames({ ffmpeg, html, audio, output, fps = FPS, onProgress = () => {} }) {
  const browser = await launch();
  try {
    const page = await browser.newPage({ viewport: { width: 1080, height: 1920 }, deviceScaleFactor: 1 });
    const pageErrors = [];
    page.on('pageerror', (e) => pageErrors.push(e.message));
    await page.setContent(html, { waitUntil: 'load' });
    const duration = await page.evaluate(() => window.ready());
    const frames = Math.ceil(duration * fps);
    const ff = spawn(ffmpeg, [
      '-y', '-hide_banner', '-loglevel', 'error',
      '-f', 'image2pipe', '-framerate', String(fps), '-c:v', 'mjpeg', '-i', '-',
      '-i', audio,
      '-map', '0:v', '-map', '1:a',
      '-c:v', 'libx264', '-preset', 'medium', '-crf', '20', '-pix_fmt', 'yuv420p', '-r', String(fps),
      '-c:a', 'copy', '-shortest', '-movflags', '+faststart',
      output,
    ], { stdio: ['pipe', 'ignore', 'pipe'] });
    let stderr = '';
    ff.stderr.on('data', (d) => (stderr += d));
    const exited = once(ff, 'close');
    for (let f = 0; f < frames; f++) {
      await page.evaluate((t) => window.renderAt(t), f / fps);
      if (pageErrors.length) throw new Error(`Video page error: ${pageErrors[0]}`);
      const jpg = await page.screenshot({ type: 'jpeg', quality: 90 });
      if (!ff.stdin.write(jpg)) await once(ff.stdin, 'drain');
      if (f % fps === 0) onProgress(f / frames);
    }
    ff.stdin.end();
    const [code] = await exited;
    if (code !== 0) throw new Error(`ffmpeg failed: ${stderr.trim().slice(0, 500)}`);
    return frames;
  } finally {
    await browser.close();
  }
}

// A single frame as PNG, for checking the look without rendering it all.
export async function renderStill({ html, t, output }) {
  const browser = await launch();
  try {
    const page = await browser.newPage({ viewport: { width: 1080, height: 1920 }, deviceScaleFactor: 1 });
    await page.setContent(html, { waitUntil: 'load' });
    await page.evaluate(() => window.ready());
    await page.evaluate((x) => window.renderAt(x), t);
    await page.screenshot({ path: output });
  } finally {
    await browser.close();
  }
}
