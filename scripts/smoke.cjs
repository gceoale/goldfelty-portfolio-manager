/**
 * End-to-end smoke test.
 *
 * Launches the built app, walks the whole onboarding flow, connects five
 * wallets and visits every tab, screenshotting each step. It proves the three
 * processes actually talk to each other — something no unit test can.
 *
 *   npm run build && npm run smoke
 *
 * On a headless Linux box, wrap it: `xvfb-run -a npm run smoke`.
 * Screenshots land in release/smoke/ unless SHOT_DIR says otherwise.
 */
const { _electron: electron } = require('playwright-core')
const path = require('path')
const fs = require('fs')

const APP = process.env.APP_DIR ?? path.resolve(__dirname, '..')
const OUT = process.env.SHOT_DIR ?? path.join(APP, 'release', 'smoke')
const USER_DATA = process.env.USER_DATA ?? fs.mkdtempSync(path.join(require('os').tmpdir(), 'goldfelty-smoke-'))

fs.mkdirSync(OUT, { recursive: true })
fs.mkdirSync(USER_DATA, { recursive: true })

;(async () => {
  const app = await electron.launch({
    args: [
      path.join(APP, 'out/main/index.js'),
      '--no-sandbox',
      `--user-data-dir=${USER_DATA}`
    ],
    cwd: APP,
    env: { ...process.env, ELECTRON_DISABLE_SECURITY_WARNINGS: '1' }
  })
  const page = await app.firstWindow()
  await page.waitForLoadState('domcontentloaded')
  await page.waitForTimeout(1500)

  const shot = async (name) => {
    await page.screenshot({ path: path.join(OUT, `${name}.png`) })
    console.log('shot', name)
  }

  await shot('01-welcome')

  await page.getByRole('button', { name: 'Get started' }).click()
  await page.waitForTimeout(300)
  await page.locator('#pw').fill('Tr0ubad0ur&Bits')
  await page.locator('#pw2').fill('Tr0ubad0ur&Bits')
  await shot('02-password')

  await page.getByRole('button', { name: 'Continue' }).click()
  await page.waitForTimeout(4000) // scrypt N=2^17
  await shot('03-account')

  await page.locator('#email').fill('demo@example.com')
  await page.getByRole('button', { name: 'Continue' }).click()
  await page.waitForTimeout(400)
  await page.getByRole('button', { name: 'Reveal phrase' }).click()
  await page.waitForTimeout(300)
  await shot('04-recovery')

  await page.getByRole('button', { name: 'I have written it down' }).click()
  await page.waitForTimeout(300)
  for (const check of await page.locator('.check').all()) await check.click()
  await shot('05-confirm')

  await page.getByRole('button', { name: 'Seal my vault' }).click()
  await page.waitForTimeout(600)
  await page.locator('#username').fill('demo')
  await page.waitForTimeout(1500)
  await shot('06-username')

  await page.getByRole('button', { name: 'Create my account' }).click()
  await page.waitForTimeout(3000)
  await shot('07-wallets')

  await page.getByRole('button', { name: /Connect 5 wallets/ }).click()
  await page.waitForTimeout(6000)
  await shot('08-home')

  const goTo = async (tab) => {
    await page.locator('.navitem', { hasText: new RegExp(`^${tab}`) }).first().click()
    await page.waitForTimeout(2000)
  }

  await goTo('Receive')
  await page.locator('.picker', { hasText: 'USDC' }).first().click()
  await page.waitForTimeout(900)
  await shot('09-receive-routes')
  await page.locator('.route').first().click()
  await page.waitForTimeout(1200)
  await page.locator('.qr-frame').scrollIntoViewIfNeeded()
  await shot('10-receive-address')

  await goTo('Settings')
  await shot('11-settings-wallets')
  await page.getByRole('button', { name: 'Connect wallet' }).click()
  await page.waitForTimeout(600)
  await shot('12-connect-modal')
  await page.getByRole('button', { name: 'Cancel' }).click()
  await page.waitForTimeout(300)
  for (const section of ['Security', 'Networks']) {
    await page.locator('.settings-nav__item', { hasText: section }).click()
    await page.waitForTimeout(500)
    await shot(`13-settings-${section.toLowerCase()}`)
  }

  await goTo('Send')
  await shot('14-send')

  const errors = await page.evaluate(() => window.__errors ?? [])
  console.log('page errors:', JSON.stringify(errors))
  await app.close()
  console.log('SMOKE OK')
})().catch((error) => {
  console.error('SMOKE FAILED:', error.message)
  process.exit(1)
})
