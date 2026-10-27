// Script -> timing -> sound -> frames -> MP4.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { dataPath, appendLog } from '../store.js';
import { loadFacts } from '../generate.js';
import { loadQueue } from '../queue.js';
import { score } from '../metrics.js';
import { writeVideo, normalizeSpec } from './script.js';
import { buildTimeline } from './timeline.js';
import { DEMOS, loadAssets } from './demos.js';
import { findFfmpeg, makeSfx, makeBed, mixAudio, playerHtml, renderFrames } from './render.js';

export const SAMPLE = fileURLToPath(new URL('./sample.json', import.meta.url));

export function slug(s) {
  return String(s).toLowerCase().replace(/#\w+/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 50) || 'video';
}

// What earlier videos were about, and how they did, so the next one differs
// and leans toward what worked.
export function videoHistory(items) {
  const videos = items.filter((i) => i.kind === 'video' && i.content.premise);
  const recentPremises = videos.slice(-15).map((i) => i.content.premise);
  const measured = videos.filter((i) => i.status === 'posted' && i.metrics).sort((a, b) => score(b.metrics) - score(a.metrics));
  const lessons = measured.length >= 3
    ? measured
      .map((i) => `- ${i.metrics.views} views, ${i.metrics.likes} likes, ${i.metrics.replies} comments: ${i.content.premise}`)
      .slice(0, 6)
      .join('\n')
    : '';
  return { recentPremises, lessons };
}

export async function makeVideo(deps, { client, spec, format = '', log = deps.log, outDir = dataPath('videos/made') } = {}) {
  const config = deps.config;
  let finalSpec = spec ? normalizeSpec(spec) : null;
  let review = null;
  if (!finalSpec) {
    const { recentPremises, lessons } = videoHistory(loadQueue().items);
    ({ spec: finalSpec, review } = await writeVideo(client, { config, facts: loadFacts(), recentPremises, lessons, format, log }));
  }
  const ffmpeg = await findFfmpeg(config);
  const timeline = buildTimeline(finalSpec, DEMOS);

  fs.mkdirSync(outDir, { recursive: true });
  const stamp = new Date(deps.now()).toISOString().slice(0, 10);
  const base = path.join(outDir, `${stamp}-${slug(finalSpec.title)}`);
  const audio = `${base}.m4a`;
  const cache = dataPath('cache/sfx');
  const sfxFiles = await makeSfx(ffmpeg, cache);
  const bed = await makeBed(ffmpeg, timeline.duration, path.join(cache, `bed-${timeline.duration.toFixed(2)}.wav`));
  const { music } = await mixAudio({
    ffmpeg,
    sfxEvents: timeline.sfx,
    sfxFiles,
    duration: timeline.duration,
    musicDir: dataPath('music'),
    seed: finalSpec.title,
    output: audio,
    bed,
  });
  if (music) log(`Music: ${path.basename(music)}`);

  const html = playerHtml({ timeline, assets: loadAssets([...new Set(finalSpec.beats.map((b) => b.demo))]) });
  const file = `${base}.mp4`;
  const started = Date.now();
  let lastPct = -1;
  await renderFrames({
    ffmpeg,
    html,
    audio,
    output: file,
    onProgress: (p) => {
      const pct = Math.floor(p * 10) * 10;
      if (pct !== lastPct) {
        lastPct = pct;
        log(`Rendering… ${pct}%`);
      }
    },
  });
  fs.rmSync(audio, { force: true });
  fs.writeFileSync(`${base}.json`, JSON.stringify({ spec: finalSpec, review }, null, 2));
  appendLog(`made video ${path.basename(file)} (${timeline.duration.toFixed(1)}s, ${Math.round((Date.now() - started) / 1000)}s to render)`);
  return { file, spec: finalSpec, review, duration: timeline.duration };
}
