// Turns a script into exact timings for beats, words and sound effects.

// Inside a demo beat, seconds from its start. The player uses the same.
export const DEMO = {
  enter: 0.4, // window settles in
  focus: 1.05, // camera reaches the area of interest
  click: 1.7, // cursor clicks (demos with a click)
  swap: 1.5, // screens cross-fade (demos without one)
  after: 2.75, // camera reaches the result
};

const clamp = (x, a, b) => Math.min(b, Math.max(a, x));

// "Every wallet. *One app.*" -> words, with the starred ones marked.
export function parseWords(text) {
  const out = [];
  let em = false;
  for (const raw of String(text).split(/\s+/).filter(Boolean)) {
    const opens = raw.startsWith('*');
    const closes = raw.endsWith('*') && raw.length > 1;
    if (opens) em = true;
    out.push({ w: raw.replace(/\*/g, ''), em });
    if (closes) em = false;
  }
  return out.filter((x) => x.w);
}

export function beatDuration(beat, demos) {
  const n = parseWords(beat.text).length;
  if (beat.kind === 'type') return clamp(1.3 + 0.3 * n, 1.7, 3.4);
  if (beat.kind === 'demo') return demos[beat.demo]?.click ? 3.8 : 3.2;
  return 3.0;
}

export function buildTimeline(spec, demos) {
  let t = 0;
  const beats = [];
  const sfx = [];
  spec.beats.forEach((beat, i) => {
    const start = t;
    const dur = beatDuration(beat, demos);
    const words = parseWords(beat.text);
    beats.push({ ...beat, index: i, start, end: start + dur, words });
    if (beat.kind === 'type') sfx.push({ sfx: 'whoosh', at: start });
    if (beat.kind === 'demo') {
      sfx.push({ sfx: 'whoosh', at: start + 0.35 });
      const d = demos[beat.demo];
      if (d?.click) sfx.push({ sfx: 'click', at: start + DEMO.click });
      else if (d && d.from !== d.to) sfx.push({ sfx: 'pop', at: start + DEMO.swap });
    }
    if (beat.kind === 'end') sfx.push({ sfx: 'chime', at: start + 0.2 });
    t += dur;
  });
  return { duration: t, beats, sfx, demo: DEMO };
}
