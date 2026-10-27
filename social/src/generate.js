// Writes drafts with Claude. Every draft goes to the review queue; nothing
// here posts anything.
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import Anthropic from '@anthropic-ai/sdk';
import { dataPath, ensureDataDir } from './store.js';
import { itemText, problems, redditTarget } from './queue.js';
import { isNearDuplicate } from './text.js';
import { learnings } from './metrics.js';

const DEFAULT_FACTS = fileURLToPath(new URL('./facts-default.md', import.meta.url));

export function loadFacts() {
  const file = dataPath('facts.md');
  if (!fs.existsSync(file)) {
    ensureDataDir();
    fs.copyFileSync(DEFAULT_FACTS, file);
    fs.chmodSync(file, 0o600);
  }
  return fs.readFileSync(file, 'utf8');
}

export const SYSTEM = `You write posts for Goldfelty's own official accounts on X, Reddit and YouTube. Goldfelty is a free, open-source desktop app that shows all of someone's crypto wallets in one place. Drafts are checked against the facts sheet before they are posted.

Who is speaking: these accounts belong to Goldfelty, and readers know it. Write as the maker ("we" or "I"), never as a customer, a fan or a neutral third party, and never pretend to have discovered the app.

What to write: things that are useful or interesting on their own. How-tos (connecting a wallet, checking a download, tracking a wallet that can't connect), what a feature does and why it was built that way, release news, honest notes on limits and tradeoffs, plain explanations of wallet and self-custody ideas that relate to what Goldfelty does. Mention goldfelty.com when it helps the reader, not in every post.

Facts: everything you say about Goldfelty must come from the facts sheet in the user message. If the sheet doesn't say it, leave it out. Never invent numbers, users, reviews, partnerships, awards, audits or quotes, and never imply an endorsement by a wallet maker. When a fact is a limitation (no independent audit, unsigned builds), don't hide it if the post touches that subject.

Never: give financial or investment advice, predict prices or returns, use urgency or fear ("before it's too late"), tag or mention other accounts (@), reply to or address anyone, use more than two hashtags, or use clickbait.

Style: clear and specific, like a good changelog or a helpful forum answer. Short sentences. No hype words ("revolutionary", "game-changer"). Emoji sparingly or not at all.

What makes a post travel (use these; they are about being worth sharing, not about tricks):
- The first line carries the point. Someone who reads only that line should learn something or want the next line. Lead with the concrete thing (a step, a number from the facts sheet, a surprising limitation, a decision and its reason), never with "Excited to announce" or a vague question.
- Concrete beats general: name the wallet, the network, the command, the screen.
- Mix angles across a batch, at most one of each per batch where you can: a how-to in steps; a myth versus fact about self-custody or wallets that the facts sheet supports; a behind-the-build note (why something works the way it does, a tradeoff we chose); a release or change note; a short checklist people would save; an honest limitation and what to do about it; a genuine question to our own followers about what they want next (only when we would actually use the answers).
- Threads: post 1 promises something specific ("How to check a download in 3 commands:"), each later post delivers one piece, the last post sums up and links.
- Reddit: write it like the best answer in a thread, useful even to someone who never installs anything. Title states what the reader gets.
- Video scripts: the first 5 seconds show the result, then how.
- For each single X post, also write two alternative versions with a different first line (same facts), so the reviewer can pick the strongest.

For each item, fill "basis" with the facts-sheet points it relies on, in a few words, so the reviewer can check it.`;

const SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['x_posts', 'x_threads', 'reddit_posts', 'video_scripts'],
  properties: {
    x_posts: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['text', 'alternatives', 'basis'],
        properties: {
          text: { type: 'string' },
          alternatives: { type: 'array', items: { type: 'string' } },
          basis: { type: 'string' },
        },
      },
    },
    x_threads: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['tweets', 'basis'],
        properties: {
          tweets: { type: 'array', items: { type: 'string' } },
          basis: { type: 'string' },
        },
      },
    },
    reddit_posts: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['title', 'body', 'basis'],
        properties: {
          title: { type: 'string' },
          body: { type: 'string' },
          basis: { type: 'string' },
        },
      },
    },
    video_scripts: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['title', 'script', 'description', 'basis'],
        properties: {
          title: { type: 'string' },
          script: { type: 'string' },
          description: { type: 'string' },
          basis: { type: 'string' },
        },
      },
    },
  },
};

export class GenerationError extends Error {}

export function buildPrompt({ facts, recent, counts, focus, lessons = [] }) {
  const recentBlock = recent.length
    ? recent.map((t) => `- ${t.replace(/\s+/g, ' ').slice(0, 280)}`).join('\n')
    : '(nothing yet)';
  const lessonBlock = lessons.length
    ? `
<how_recent_posts_did>
Real numbers from our own accounts. Work out what the best ones have in common (angle, first line, format, length, topic) and lean into it; avoid what the weakest ones have in common. Don't copy them.
${lessons
  .map((l) => `${l.platform}, best:\n${l.best.join('\n')}${l.worst.length ? `\n${l.platform}, weakest:\n${l.worst.join('\n')}` : ''}`)
  .join('\n\n')}
</how_recent_posts_did>
`
    : '';
  return `<facts>
${facts}
</facts>
${lessonBlock}
<already_written>
These were written or posted recently. Cover different ground: a different feature, angle or question.
${recentBlock}
</already_written>

Write:
- ${counts.xPosts} single X posts, each at most 270 characters (a link counts as 23).
- ${counts.xThreads} X thread(s) of 3 to 6 posts, each post at most 270 characters. The first post should make sense on its own.
- ${counts.redditPosts} Reddit post(s) for Goldfelty's own profile: a clear title, and a body of 120 to 400 words in Markdown that helps the reader even if they never install anything.
- ${counts.videoScripts} short video script(s) of 45 to 90 seconds, for the maker to record as a screen recording with voice-over: say what's on screen in [brackets]. Include a YouTube title (at most 90 characters) and description (2 to 4 sentences, ending with https://goldfelty.com).
${focus ? `\nFocus this batch on: ${focus}\n` : ''}`;
}

export function makeClient(apiKey) {
  if (!apiKey) {
    throw new GenerationError(
      'No Anthropic API key. Set ANTHROPIC_API_KEY, or anthropicApiKey in config.json.',
    );
  }
  return new Anthropic({ apiKey });
}

export async function callClaude(client, { model, effort, system, prompt, schema = SCHEMA }) {
  let msg;
  try {
    msg = await client.beta.messages.create({
      model,
      max_tokens: 16000,
      // If Claude's safety checks wrongly decline, the API retries the same
      // request on the model Anthropic recommends instead of failing.
      betas: ['server-side-fallback-2026-07-01'],
      fallbacks: 'default',
      output_config: { effort, format: { type: 'json_schema', schema } },
      system,
      messages: [{ role: 'user', content: prompt }],
    });
  } catch (err) {
    if (err instanceof Anthropic.AuthenticationError) {
      throw new GenerationError('The Anthropic API key was refused. Check it and try again.');
    }
    if (err instanceof Anthropic.RateLimitError) {
      throw new GenerationError('Anthropic rate limit reached. Try again in a minute.');
    }
    if (err instanceof Anthropic.APIError) {
      throw new GenerationError(`Anthropic API error (${err.status ?? 'network'}): ${err.message}`);
    }
    throw err;
  }
  if (msg.stop_reason === 'refusal') {
    const why = msg.stop_details?.explanation ? ` ${msg.stop_details.explanation}` : '';
    throw new GenerationError(`Claude declined this request.${why}`);
  }
  if (msg.stop_reason === 'max_tokens') {
    throw new GenerationError('The batch was cut off. Ask for fewer items.');
  }
  const text = msg.content
    .filter((b) => b.type === 'text')
    .map((b) => b.text)
    .join('');
  try {
    return JSON.parse(text);
  } catch {
    throw new GenerationError("Claude's reply wasn't valid JSON.");
  }
}

// Turns Claude's reply into queue drafts. Drafts that break the rules or
// repeat recent posts are dropped and reported, not queued.
export function toDrafts(plan, { recent, redditTarget: target, counts }) {
  const drafts = [];
  const dropped = [];
  const seen = [...recent];
  const consider = (item) => {
    const issues = problems(item);
    const text = itemText(item);
    if (issues.length) dropped.push({ item, reason: issues.join(' ') });
    else if (isNearDuplicate(text, seen)) dropped.push({ item, reason: 'too close to a recent post' });
    else {
      seen.push(text);
      drafts.push(item);
    }
  };
  for (const p of (plan.x_posts || []).slice(0, counts.xPosts)) {
    // Keep only alternatives that would pass review themselves.
    const alternatives = (p.alternatives || [])
      .map((t) => t.trim())
      .filter((t) => t && t !== p.text.trim())
      .filter((t) => !problems({ platform: 'x', kind: 'post', content: { text: t } }).length)
      .slice(0, 2);
    consider({ platform: 'x', kind: 'post', content: { text: p.text.trim() }, alternatives, basis: p.basis });
  }
  for (const t of (plan.x_threads || []).slice(0, counts.xThreads)) {
    consider({
      platform: 'x',
      kind: 'thread',
      content: { tweets: t.tweets.map((s) => s.trim()).filter(Boolean) },
      basis: t.basis,
    });
  }
  for (const r of (plan.reddit_posts || []).slice(0, counts.redditPosts)) {
    consider({
      platform: 'reddit',
      kind: 'self',
      content: { subreddit: redditTarget(target), title: r.title.trim(), body: r.body.trim() },
      basis: r.basis,
    });
  }
  for (const v of (plan.video_scripts || []).slice(0, counts.videoScripts)) {
    consider({
      platform: 'youtube',
      kind: 'script',
      content: { title: v.title.trim(), script: v.script.trim(), description: v.description.trim() },
      basis: v.basis,
    });
  }
  return { drafts, dropped };
}

export const DEFAULT_COUNTS = { xPosts: 6, xThreads: 1, redditPosts: 1, videoScripts: 1 };

export async function generate({ client, config, facts, queue, counts = DEFAULT_COUNTS, focus = '', redditUser }) {
  const recent = queue.items
    .filter((i) => i.status !== 'rejected')
    .slice(-40)
    .map(itemText);
  const plan = await callClaude(client, {
    model: config.model,
    effort: config.effort,
    system: SYSTEM,
    prompt: buildPrompt({ facts, recent, counts, focus, lessons: learnings(queue.items) }),
  });
  return toDrafts(plan, {
    recent,
    counts,
    redditTarget: redditUser ? `u_${redditUser}` : 'u_YOUR_USERNAME',
  });
}
