import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseDeepLink, linkFromArgv } from '../src/shared/deepLink.ts'

test('a link of ours only ever means "open the app"', () => {
  assert.deepEqual(parseDeepLink('goldfelty://'), { action: 'open' })
  assert.deepEqual(parseDeepLink('https://goldfelty.com/open'), { action: 'open' })
})

test('pairing URIs are no longer forwarded anywhere', () => {
  // Before 1.1.1 these reached the wallet layer. Now they only focus the window.
  const link = parseDeepLink(`goldfelty://wc?uri=${encodeURIComponent('wc:abc@2?relay-protocol=irn&symKey=1')}`)
  assert.deepEqual(link, { action: 'open' })
  assert.equal('uri' in link, false)
})

test('ignores links belonging to somebody else', () => {
  assert.equal(parseDeepLink('https://evil.example/open'), null)
  assert.equal(parseDeepLink('https://goldfelty.com.evil.example/'), null)
  assert.equal(parseDeepLink('http://goldfelty.com/'), null)
  assert.equal(parseDeepLink('otherapp://open'), null)
  assert.equal(parseDeepLink('not a url'), null)
  assert.equal(parseDeepLink('goldfelty://' + 'a'.repeat(5000)), null)
})

test('finds a link among process arguments', () => {
  assert.deepEqual(linkFromArgv(['/usr/bin/goldfelty', '--flag', 'goldfelty://']), { action: 'open' })
  assert.equal(linkFromArgv(['/usr/bin/goldfelty', '--flag']), null)
})
