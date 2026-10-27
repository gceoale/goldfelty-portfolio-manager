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

// Sound effects, made by ffmpeg itself.
const SFX = {
  pop: ['-f', 'lavfi', '-i', "aevalsrc='0.8*sin(2*PI*t*(900-3000*t))*exp(-38*t)':s=48000:d=0.14"],
  whoosh: ['-f', 'lavfi', '-i', 'anoisesrc=d=0.5:c=pink:r=48000:a=0.7', '-af', 'bandpass=f=1400:width_type=h:w=2000,afade=t=in:d=0.25,afade=t=out:st=0.25:d=0.25'],
  ding: ['-f', 'lavfi', '-i', "aevalsrc='0.5*sin(2*PI*1318*t)*exp(-4*t)+0.3*sin(2*PI*1975*t)*exp(-5*t)':s=48000:d=0.9"],
  boing: ['-f', 'lavfi', '-i', "aevalsrc='0.7*sin(2*PI*t*(220+160*sin(2*PI*9*t)))*exp(-3.5*t)':s=48000:d=0.8"],
  scratch: ['-f', 'lavfi', '-i', "aevalsrc='0.5*sin(2*PI*t*(1700-3600*t))*(0.6+0.4*sin(2*PI*50*t))':s=48000:d=0.38"],
  drumroll: ['-f', 'lavfi', '-i', 'anoisesrc=d=1.2:c=white:r=48000:a=0.5', '-af', "volume='0.25+0.75*abs(sin(2*PI*15*t))':eval=frame,lowpass=f=2500,afade=t=out:st=1.0:d=0.2"],
  fail: ['-f', 'lavfi', '-i', "aevalsrc='0.35*(sin(2*PI*if(lt(t,0.38),392,if(lt(t,0.76),370,if(lt(t,1.14),349,330+7*sin(2*PI*6*t))))*t)+0.4*sin(4*PI*if(lt(t,0.38),392,if(lt(t,0.76),370,if(lt(t,1.14),349,330+7*sin(2*PI*6*t))))*t))*if(gt(t,1.14),exp(-1.3*(t-1.14)),1)':s=48000:d=2.0"],
  cash: ['-f', 'lavfi', '-i', "aevalsrc='0.4*sin(2*PI*2093*t)*exp(-7*t)+0.45*sin(2*PI*2637*t)*exp(-6*(t-0.09))*gte(t,0.09)':s=48000:d=0.8"],
  boom: ['-f', 'lavfi', '-i', "aevalsrc='0.9*sin(2*PI*t*(110-70*t))*exp(-5*t)':s=48000:d=0.7"],
};

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

// Voices, sound effects and optional music, mixed and loudness-normalised
// for YouTube (-14 LUFS).
export async function mixAudio({ ffmpeg, lines, sfxEvents, sfxFiles, duration, musicDir, seed, output }) {
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
    chains.push(`[${n}:a]adelay=delays=${Math.round(e.at * 1000)}:all=1,volume=${e.sfx === 'whoosh' ? 0.25 : 0.4}[a${n}]`);
    n++;
  }
  const music = pickMusic(musicDir, seed);
  if (music) {
    inputs.push('-stream_loop', '-1', '-i', music);
    chains.push(`[${n}:a]aformat=sample_rates=48000:channel_layouts=mono,volume=0.11,afade=t=in:d=0.6,afade=t=out:st=${Math.max(0, duration - 1.2).toFixed(2)}:d=1.2[a${n}]`);
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
