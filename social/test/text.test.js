import test from 'node:test';
import assert from 'node:assert/strict';
import { xLength, hasMention, hashtagCount, similarity, isNearDuplicate } from '../src/text.js';

test('plain text counts one per character', () => {
  assert.equal(xLength('hello world'), 11);
});

test('links count as 23 whatever their length', () => {
  assert.equal(xLength('see https://goldfelty.com/security/index.html'), 4 + 23);
  assert.equal(xLength('goldfelty.com'), 23);
});

test('emoji and CJK count as two', () => {
  assert.equal(xLength('👍'), 2);
  assert.equal(xLength('👨‍👩‍👧'), 2);
  assert.equal(xLength('漢字'), 4);
});

test('mentions are spotted, emails are not', () => {
  assert.ok(hasMention('thanks @someone'));
  assert.ok(hasMention('@start'));
  assert.ok(!hasMention('mail security@goldfelty.com'));
});

test('hashtags are counted', () => {
  assert.equal(hashtagCount('#crypto news #wallets and #more'), 3);
  assert.equal(hashtagCount('issue #12 is not a tag? it is'), 1);
});

test('near duplicates are caught, different posts are not', () => {
  const a = 'Goldfelty now connects to Bitget Wallet for Bitcoin, Solana and Tron in one go.';
  const b = 'Goldfelty now connects to Bitget Wallet for Bitcoin, Solana and Tron at once.';
  const c = 'Every release has SHA-256 checksums you can check before installing.';
  assert.ok(similarity(a, b) > 0.6);
  assert.ok(isNearDuplicate(b, [a, c]));
  assert.ok(!isNearDuplicate(c, [a]));
});
