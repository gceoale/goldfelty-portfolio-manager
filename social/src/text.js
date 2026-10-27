// Text checks shared by generation, the review page and posting.

// Code point ranges X counts as one character; everything else counts as
// two (twitter-text v3). Links always count as 23.
const LIGHT = [
  [0, 4351],
  [8192, 8205],
  [8208, 8223],
  [8242, 8247],
];
const URL_RE =
  /(?:https?:\/\/[^\s]+)|(?:\b(?:[a-z0-9-]+\.)+(?:com|org|net|io|app|dev|xyz|co|ai|gg)(?:\/[^\s]*)?)/gi;
const EMOJI_RE = /\p{Extended_Pictographic}/u;
const segmenter = new Intl.Segmenter('en', { granularity: 'grapheme' });

export const X_MAX = 280;

export function xLength(text) {
  let n = 0;
  const rest = String(text).normalize('NFC').replace(URL_RE, () => {
    n += 23;
    return '';
  });
  for (const { segment } of segmenter.segment(rest)) {
    if (EMOJI_RE.test(segment)) {
      n += 2;
      continue;
    }
    for (const ch of segment) {
      const cp = ch.codePointAt(0);
      n += LIGHT.some(([a, b]) => cp >= a && cp <= b) ? 1 : 2;
    }
  }
  return n;
}

export function hasMention(text) {
  return /(^|[^\w])@\w/.test(text);
}

export function hashtagCount(text) {
  return (String(text).match(/(^|\s)#\w+/g) || []).length;
}

function words(text) {
  return new Set(
    String(text)
      .toLowerCase()
      .replace(/https?:\/\/\S+/g, '')
      .split(/[^\p{L}\p{N}]+/u)
      .filter((w) => w.length > 2),
  );
}

// Share of words two texts have in common (0 to 1).
export function similarity(a, b) {
  const A = words(a);
  const B = words(b);
  if (!A.size || !B.size) return 0;
  let common = 0;
  for (const w of A) if (B.has(w)) common++;
  return common / (A.size + B.size - common);
}

export function isNearDuplicate(text, others, threshold = 0.6) {
  return others.some((o) => similarity(text, o) >= threshold);
}
