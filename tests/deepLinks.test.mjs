import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseDeepLink, linkFromArgv } from '../src/shared/deepLink.ts'

const WC = 'wc:7f6e5d@2?relay-protocol=irn&symKey=abc123'

test('accepts a pairing URI on the custom scheme', () => {
  const link = parseDeepLink(`goldfelty://wc?uri=${encodeURIComponent(WC)}`)
  assert.deepEqual(link, { action: 'wc', uri: WC })
})

test('accepts the same thing over https, for clients that refuse custom schemes', () => {
  const link = parseDeepLink(`https://goldfelty.com/wc?uri=${encodeURIComponent(WC)}`)
  assert.deepEqual(link, { action: 'wc', uri: WC })
})

test('treats a bare link as just "open the app"', () => {
  assert.deepEqual(parseDeepLink('goldfelty://'), { action: 'open' })
  assert.deepEqual(parseDeepLink('https://goldfelty.com/'), { action: 'open' })
})

test('ignores links belonging to somebody else', () => {
  assert.equal(parseDeepLink('https://evil.example/wc?uri=wc:abc'), null)
  assert.equal(parseDeepLink('otherapp://wc?uri=wc:abc'), null)
  assert.equal(parseDeepLink('not a url'), null)
})

test('refuses to forward anything that is not a wc: URI', () => {
  // This channel reaches the wallet layer, so it carries pairing URIs only.
  for (const bad of ['javascript:alert(1)', 'file:///etc/passwd', 'https://evil.example', '']) {
    const link = parseDeepLink(`goldfelty://wc?uri=${encodeURIComponent(bad)}`)
    assert.equal(link, null, `${bad} must not be forwarded`)
  }
})

test('refuses a wc action with no uri at all', () => {
  assert.equal(parseDeepLink('goldfelty://wc'), null)
})

test('finds a link among process arguments', () => {
  const argv = ['/usr/bin/goldfelty', '--no-sandbox', `goldfelty://wc?uri=${encodeURIComponent(WC)}`]
  assert.deepEqual(linkFromArgv(argv), { action: 'wc', uri: WC })
  assert.equal(linkFromArgv(['/usr/bin/goldfelty', '--flag']), null)
})
