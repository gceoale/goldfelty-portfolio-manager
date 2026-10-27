// Writes the comedy script for a Short, then has a second pass judge it.
import { callClaude } from '../generate.js';
import { SCREEN_NAMES, HOTSPOT_NAMES, screensForPrompt } from './screens.js';

export const VOICES = ['narrator', 'upbeat', 'deadpan', 'dramatic', 'anxious', 'smug'];
export const LOOKS = ['person', 'friend', 'wallet', 'coin', 'goldfelty', 'none'];
export const COLORS = ['gold', 'blue', 'orange', 'purple', 'green', 'red', 'pink', 'gray'];
export const SFX = ['none', 'pop', 'whoosh', 'ding', 'boing', 'scratch', 'drumroll', 'fail', 'cash'];
export const KINDS = ['hook', 'dialogue', 'chat', 'chaos', 'app', 'punchline', 'outro'];

const str = { type: 'string' };

export const SPEC_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['premise', 'format', 'title', 'description', 'cast', 'scenes'],
  properties: {
    premise: str,
    format: str,
    title: str,
    description: str,
    cast: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['id', 'name', 'voice', 'look', 'color'],
        properties: {
          id: str,
          name: str,
          voice: { type: 'string', enum: VOICES },
          look: { type: 'string', enum: LOOKS },
          color: { type: 'string', enum: COLORS },
        },
      },
    },
    scenes: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['kind', 'caption', 'screen', 'hotspot', 'chaos_items', 'lines'],
        properties: {
          kind: { type: 'string', enum: KINDS },
          caption: str,
          screen: { type: 'string', enum: ['none', ...SCREEN_NAMES] },
          hotspot: { type: 'string', enum: ['none', ...HOTSPOT_NAMES] },
          chaos_items: { type: 'array', items: str },
          lines: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              required: ['speaker', 'text', 'sfx'],
              properties: {
                speaker: str,
                text: str,
                sfx: { type: 'string', enum: SFX },
              },
            },
          },
        },
      },
    },
  },
};

export const WRITER_SYSTEM = `You write short, genuinely funny vertical videos (YouTube Shorts, 25 to 45 seconds) for Goldfelty's own channel. Goldfelty is a free desktop app that shows all of someone's crypto wallets in one place, and lets them send from one screen while their own wallet approves everything.

The comedy lives in relatable self-custody pain: seven wallets and no idea what's in which; 40 browser tabs to add up one number; the spreadsheet updated once in March; checking the total at 3am; "which chain did I bridge that to"; explaining your setup to family; seed-phrase paranoia; tiny gas fees that somehow add up; the token you forgot you had. Goldfelty shows up as the payoff that ends the pain, never as the butt of the joke.

Craft:
- Hook in the first two seconds: a specific, slightly absurd, instantly relatable situation. The first spoken line and the hook caption must make a scroller stop.
- One clear premise per video. Escalate: each beat bigger than the last (rule of three works).
- Characters with strong attitudes: the anxious owner, a smug or needy wallet, a deadpan Goldfelty, a mock nature-documentary or movie-trailer narrator. Give wallets and coins personalities.
- Lines short and speakable: at most 14 words, written the way people talk. Comic timing over information.
- Length: 70 to 110 spoken words in total (about 30 to 45 seconds). Cut anything that isn't a setup or a laugh.
- Show the real app once or twice with a screen and one concrete fact from the facts sheet, said with a joke, not a sales pitch.
- End on a punchline or callback, then a 2 to 4 second outro that says goldfelty.com. No "link in bio", no "smash that like button".
- Rotate formats between videos: text-message chat, two-character skit, POV, expectation versus reality, nature documentary, movie trailer, "things nobody tells you".

Scenes (render as vertical video, 5 to 9 scenes):
- hook: big caption (at most 7 words) plus a spoken line. Always first.
- dialogue: characters on screen talking; the speaker animates.
- chat: a phone text conversation; each line is a message, spoken aloud by its sender.
- chaos: windows and tabs piling up; chaos_items are their titles (wallet names, "portfolio_FINAL_v7.xlsx", "block explorer", "price site").
- app: a real Goldfelty screen (pick screen and hotspot) with a caption and a line about it.
- punchline: big caption for the biggest laugh.
- outro: always last; caption like "Every wallet. One app." and a line that ends with goldfelty.com.
Fields that don't apply to a scene: caption "", screen "none", hotspot "none", chaos_items []. sfx can punctuate a line ("none" mostly; use them for timing, not on every line).

Cast: 1 to 3 characters plus an optional narrator (look "none"). Each id is referenced as the speaker of lines. Use distinct voices.

Honesty: it's an obvious skit, never a fake testimonial or a "real user". Everything said about Goldfelty must be in the facts sheet; screens show demo wallets, so don't imply they are someone's real money. No price predictions, returns or investment advice, no "to the moon". Don't disparage real people or other companies; wallet brands can appear as characters only in friendly ways.

Title: at most 70 characters, funny, no clickbait lies, ending with " #Shorts". Description: 1 to 2 sentences plus https://goldfelty.com.`;

export function writerPrompt({ facts, recentPremises, lessons, feedback, format }) {
  return `<facts>
${facts}
</facts>

<screens>
${screensForPrompt()}
</screens>

<recent_videos>
${recentPremises.length ? recentPremises.map((p) => `- ${p}`).join('\n') : '(none yet)'}
</recent_videos>
${lessons ? `\n<how_recent_videos_did>\n${lessons}\n</how_recent_videos_did>\n` : ''}
Write one new video with a premise and format different from the recent ones${format ? ` (format: ${format})` : ''}.${feedback ? `\n\nA previous draft was turned down. Reviewer's notes, fix these:\n${feedback}` : ''}`;
}

export const REVIEW_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['funny', 'hook', 'accurate', 'publish', 'notes'],
  properties: {
    funny: { type: 'integer' },
    hook: { type: 'integer' },
    accurate: { type: 'boolean' },
    publish: { type: 'boolean' },
    notes: str,
  },
};

const REVIEW_SYSTEM = `You are a tough comedy editor and fact checker for Goldfelty's YouTube Shorts. The video will be published automatically if you approve it.

Score honestly from 1 to 10:
- funny: would a crypto-curious viewer actually laugh or smile? Generic jokes, puns without a setup, and ad-speak score low.
- hook: would the first two seconds stop someone scrolling?
accurate: false if anything said about Goldfelty isn't supported by the facts sheet, if it gives financial advice or price predictions, if it poses as a real testimonial, or if it disparages a real person or company.
publish: true only if funny >= 7, hook >= 7 and accurate.
notes: the specific changes that would make it funnier or fix it.`;

export async function reviewSpec(client, { config, facts, spec }) {
  return callClaude(client, {
    model: config.model,
    effort: 'high',
    system: REVIEW_SYSTEM,
    prompt: `<facts>\n${facts}\n</facts>\n\n<video_script>\n${JSON.stringify(spec, null, 2)}\n</video_script>`,
    schema: REVIEW_SCHEMA,
  });
}

// Fixes what a model can get slightly wrong, and refuses what can't be fixed.
export function normalizeSpec(spec) {
  const cast = (spec.cast || []).slice(0, 4);
  if (!cast.length) throw new Error('The script has no cast.');
  const ids = new Set(cast.map((c) => c.id));
  let scenes = (spec.scenes || []).filter((s) => KINDS.includes(s.kind)).slice(0, 12);
  for (const s of scenes) {
    s.lines = (s.lines || [])
      .filter((l) => l.text && l.text.trim())
      .map((l) => ({ ...l, text: l.text.trim(), speaker: ids.has(l.speaker) ? l.speaker : cast[0].id, sfx: SFX.includes(l.sfx) ? l.sfx : 'none' }));
    if (s.kind === 'app' && !SCREEN_NAMES.includes(s.screen)) s.screen = 'overview';
    if (s.screen !== 'none' && !SCREEN_NAMES.includes(s.screen)) s.screen = 'none';
    s.chaos_items = (s.chaos_items || []).slice(0, 12);
  }
  scenes = scenes.filter((s) => s.lines.length || ['chaos', 'punchline', 'outro', 'hook'].includes(s.kind));
  if (scenes.length < 3) throw new Error('The script is too short.');
  if (scenes.at(-1).kind !== 'outro') {
    scenes.push({ kind: 'outro', caption: 'Every wallet. One app.', screen: 'none', hotspot: 'none', chaos_items: [], lines: [] });
  }
  const title = String(spec.title || 'Goldfelty').replace(/[<>]/g, '').slice(0, 100);
  const description = String(spec.description || '').replace(/[<>]/g, '');
  return {
    ...spec,
    title,
    description: description.includes('goldfelty.com') ? description : `${description}\n\nhttps://goldfelty.com`.trim(),
    cast,
    scenes,
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
    const spec = normalizeSpec(raw);
    const review = await reviewSpec(client, { config, facts, spec });
    log(`Script "${spec.premise}": funny ${review.funny}/10, hook ${review.hook}/10${review.accurate ? '' : ', not accurate'}`);
    if (review.publish && review.accurate && review.funny >= 7 && review.hook >= 7) return { spec, review };
    feedback = review.notes;
  }
  throw new Error('Three scripts in a row weren’t funny or accurate enough; trying again later.');
}
