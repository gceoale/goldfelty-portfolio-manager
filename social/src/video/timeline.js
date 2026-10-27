// Turns a script plus the length of each spoken line into exact timings for
// scenes, lines, words and sound effects.

const MIN_SCENE = { hook: 1.6, chaos: 2.4, punchline: 1.4, outro: 2.8, app: 2.0 };
const LINE_GAP = 0.14;
const SCENE_TAIL = 0.3;

// Spreads a line's duration over its words, longer words taking longer.
export function wordTimes(text, start, end) {
  const words = text.split(/\s+/).filter(Boolean);
  const weights = words.map((w) => w.replace(/[^\p{L}\p{N}]/gu, '').length + 2);
  const total = weights.reduce((a, b) => a + b, 0) || 1;
  let t = start;
  return words.map((w, i) => {
    const d = ((end - start) * weights[i]) / total;
    const out = { w, start: t, end: t + d };
    t += d;
    return out;
  });
}

// durations[sceneIndex][lineIndex] = seconds of audio for that line.
export function buildTimeline(spec, durations) {
  let t = 0;
  const scenes = [];
  const sfx = [];
  spec.scenes.forEach((scene, si) => {
    const start = t;
    t += si === 0 ? 0.25 : 0.2;
    if (scene.kind === 'chaos') t += 0.6; // let the pile-up start before anyone talks
    const lines = scene.lines.map((line, li) => {
      const d = durations[si]?.[li] ?? 1;
      const ls = t;
      t += d;
      const out = { ...line, start: ls, end: t, words: wordTimes(line.text, ls, t) };
      const effect = line.sfx !== 'none' ? line.sfx : scene.kind === 'chat' ? 'pop' : null;
      if (effect) sfx.push({ sfx: effect, at: Math.max(0, ls - 0.04) });
      t += LINE_GAP;
      return out;
    });
    t += SCENE_TAIL;
    if (t - start < (MIN_SCENE[scene.kind] || 1)) t = start + (MIN_SCENE[scene.kind] || 1);
    if (scene.kind === 'punchline') sfx.push({ sfx: 'boom', at: start + 0.05 });
    if (scene.kind === 'app' || scene.kind === 'outro') sfx.push({ sfx: 'whoosh', at: start });
    scenes.push({ ...scene, index: si, start, end: t, lines });
  });
  return { duration: t + 0.2, scenes, sfx };
}
