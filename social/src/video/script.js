// Writes a Short's script, then has a tough editor judge it.
//
// A Short is a handful of beats: kinetic type on the brand background, and
// real moments in the app with a cursor and camera moves. No characters, no
// narration. The joke lives in the copy and the cut.
import { callClaude } from '../generate.js';
import { DEMO_NAMES, demosForPrompt } from './demos.js';

export const KINDS = ['type', 'demo', 'end'];
export const MAX_WORDS = 9;
const str = { type: 'string' };

export const SPEC_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['premise', 'title', 'description', 'beats'],
  properties: {
    premise: str,
    title: str,
    description: str,
    beats: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['kind', 'text', 'demo'],
        properties: {
          kind: { type: 'string', enum: KINDS },
          text: str,
          demo: { type: 'string', enum: ['none', ...DEMO_NAMES] },
        },
      },
    },
  },
};

export const WRITER_SYSTEM = `You write the copy for short vertical videos (YouTube Shorts, 14 to 22 seconds) for Goldfelty, a free desktop app that shows all of someone's crypto wallets in one place and lets them send from one screen while their own wallet approves everything.

The look is a premium product film: big serif type on a warm off-white background, then the real app with a cursor and smooth camera moves. There are no characters and no voice-over. Think of the best Apple, Arc or Linear ads: the joke is in the writing and the edit.

Voice: dry, observational, quietly confident. One true, specific, slightly painful observation about life with many crypto wallets, then the app resolves it. Wit over puns. Understatement over hype. Never "game-changer", "unlock", "seamless", "revolutionize", "level up", emojis, exclamation marks or rhetorical "Imagine if...".

Beats (4 to 7, in order):
- type: one line of big type on its own. At most ${MAX_WORDS} words. Use for the hook and the setup.
- demo: a real moment in the app (pick it in "demo"), with one short line above it. At most ${MAX_WORDS} words. The line should land a beat against what's shown, not describe it.
- end: always last, exactly once. Its text is the sign-off line, like "Every wallet. *One app.*"
Wrap one or two words per line in *asterisks* for gold italic emphasis; that's where the eye lands, so put it on the punch.
The first beat must stop a scroll on its own. Use 1 to 3 demos per video. "demo" is "none" for type and end beats.

Real moments you can show:
${demosForPrompt()}
They show demo wallets; never imply they are anyone's real money.

Honesty: every claim about Goldfelty must come from the facts sheet. No price predictions, returns or investment advice. Don't mock real people or other companies.

Title: at most 70 characters, written like the video's best line, ending with " #Shorts". Description: one sentence plus https://goldfelty.com.`;

export function writerPrompt({ facts, recentPremises, lessons, feedback, format }) {
  return `<facts>
${facts}
</facts>

<recent_videos>
${recentPremises.length ? recentPremises.map((p) => `- ${p}`).join('\n') : '(none yet)'}
</recent_videos>
${lessons ? `\n<how_recent_videos_did>\n${lessons}\n</how_recent_videos_did>\n` : ''}
Write one new video whose observation is different from the recent ones${format ? ` (angle: ${format})` : ''}.${feedback ? `\n\nA previous draft was turned down. The editor's notes, fix these:\n${feedback}` : ''}`;
}

export const REVIEW_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['funny', 'hook', 'premium', 'accurate', 'publish', 'notes'],
  properties: {
    funny: { type: 'integer' },
    hook: { type: 'integer' },
    premium: { type: 'integer' },
    accurate: { type: 'boolean' },
    publish: { type: 'boolean' },
    notes: str,
  },
};

const REVIEW_SYSTEM = `You are the creative director and fact checker for Goldfelty's YouTube Shorts: big serif type and real app footage, no characters, no voice. A video you approve is published automatically, so be hard to please.

Score 1 to 10:
- funny: does the copy earn a smile or a "ha, true"? Generic, punny or sales-y copy scores low.
- hook: would the first beat stop someone scrolling?
- premium: does it read like a top-tier brand ad? Anything that smells of AI-written marketing ("unlock", "seamless", "game-changer", hype, filler, explaining the joke, more than 9 words on a line) scores 4 or less.
accurate: false if anything about Goldfelty isn't supported by the facts sheet, if it gives financial advice or price predictions, or if it mocks real people or companies.
publish: true only if funny >= 7, hook >= 7, premium >= 8 and accurate.
notes: the specific changes that would make it sharper.`;

export async function reviewSpec(client, { config, facts, spec }) {
  return callClaude(client, {
    model: config.model,
    effort: 'high',
    system: REVIEW_SYSTEM,
    prompt: `<facts>\n${facts}\n</facts>\n\n<video_script>\n${JSON.stringify(spec, null, 2)}\n</video_script>`,
    schema: REVIEW_SCHEMA,
  });
}

export function wordCount(text) {
  return String(text).replace(/\*/g, '').split(/\s+/).filter(Boolean).length;
}

// Fixes what a model can get slightly wrong, and refuses what can't be fixed.
export function normalizeSpec(spec) {
  let beats = (spec.beats || [])
    .filter((b) => KINDS.includes(b.kind))
    .map((b) => ({
      kind: b.kind,
      text: String(b.text || '').replace(/\s+/g, ' ').trim(),
      demo: b.kind === 'demo' && DEMO_NAMES.includes(b.demo) ? b.demo : 'none',
    }))
    .filter((b) => b.kind !== 'demo' || b.demo !== 'none')
    .filter((b) => b.text || b.kind === 'end');
  beats = beats.filter((b) => b.kind !== 'end');
  if (beats.length < 2) throw new Error('The script is too short.');
  if (beats.some((b) => wordCount(b.text) > MAX_WORDS + 3)) throw new Error('A line is far too long.');
  const end = (spec.beats || []).find((b) => b.kind === 'end');
  beats = beats.slice(0, 7);
  beats.push({ kind: 'end', text: end?.text?.trim() || 'Every wallet. *One app.*', demo: 'none' });
  const title = String(spec.title || 'Goldfelty').replace(/[<>*]/g, '').slice(0, 100);
  const description = String(spec.description || '').replace(/[<>*]/g, '');
  return {
    premise: String(spec.premise || ''),
    title,
    description: description.includes('goldfelty.com') ? description : `${description}\n\nhttps://goldfelty.com`.trim(),
    beats,
  };
}

export async function writeVideo(client, { config, facts, recentPremises = [], lessons = '', format = '', log = () => {} }) {
  let feedback = '';
  for (let attempt = 1; attempt <= 3; attempt++) {
    const raw = await callClaude(client, {
      model: config.model,
      effort: 'high',
      system: WRITER_SYSTEM,
      prompt: writerPrompt({ facts, recentPremises, lessons, feedback, format }),
      schema: SPEC_SCHEMA,
    });
    let spec;
    try {
      spec = normalizeSpec(raw);
    } catch (err) {
      feedback = err.message;
      continue;
    }
    const review = await reviewSpec(client, { config, facts, spec });
    log(`Script "${spec.premise}": funny ${review.funny}, hook ${review.hook}, premium ${review.premium}${review.accurate ? '' : ', not accurate'}`);
    if (review.publish && review.accurate && review.funny >= 7 && review.hook >= 7 && review.premium >= 8) return { spec, review };
    feedback = review.notes;
  }
  throw new Error('Three scripts in a row weren’t good enough; trying again later.');
}
