import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { createHash } from 'node:crypto'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync, statSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join, basename } from 'node:path'
import { Updater, assetNameFor, detectInstall, isNewer, parseSums, verifyChecksums } from '../src/main/updater.ts'

/* ---- Pure parts ------------------------------------------------------------------------ */

test('versions compare numerically, and odd tags never count as newer', () => {
  assert.equal(isNewer('1.2.0', '1.1.9'), true)
  assert.equal(isNewer('v1.10.0', '1.9.0'), true)
  assert.equal(isNewer('1.2.0', '1.2.0'), false)
  assert.equal(isNewer('1.1.9', '1.2.0'), false)
  assert.equal(isNewer('1.3.0-beta', '1.2.0'), false)
  assert.equal(isNewer('nonsense', '1.2.0'), false)
})

test('each kind of install maps to the file the release actually has', () => {
  // The asset names of the real 1.1.1 release, as GitHub serves them.
  const released = new Set([
    'goldfelty-portfolio-manager-1.1.1-arm64.tar.gz',
    'goldfelty-portfolio-manager-1.1.1-x64.tar.gz',
    'goldfelty-portfolio-manager-1.1.1.aarch64.rpm',
    'goldfelty-portfolio-manager-1.1.1.x86_64.rpm',
    'goldfelty-portfolio-manager_1.1.1_amd64.deb',
    'goldfelty-portfolio-manager_1.1.1_arm64.deb',
    'Goldfelty.Portfolio.Manager-1.1.1-arm64-mac.zip',
    'Goldfelty.Portfolio.Manager-1.1.1-arm64-portable.exe',
    'Goldfelty.Portfolio.Manager-1.1.1-arm64-setup.exe',
    'Goldfelty.Portfolio.Manager-1.1.1-arm64.AppImage',
    'Goldfelty.Portfolio.Manager-1.1.1-x64-mac.zip',
    'Goldfelty.Portfolio.Manager-1.1.1-x64-portable.exe',
    'Goldfelty.Portfolio.Manager-1.1.1-x64-setup.exe',
    'Goldfelty.Portfolio.Manager-1.1.1-x86_64.AppImage'
  ])
  for (const kind of ['mac', 'nsis', 'portable', 'appimage', 'deb', 'rpm', 'targz']) {
    for (const arch of ['x64', 'arm64']) {
      const name = assetNameFor(kind, arch, '1.1.1')
      assert.ok(released.has(name), `${kind} ${arch}: ${name}`)
    }
  }
  assert.equal(assetNameFor('dev', 'x64', '1.1.1'), null)
})

test('SHA256SUMS.txt is read line by line', () => {
  const sums = parseSums(`${'a'.repeat(64)}  one.zip\n${'B'.repeat(64)}  two.exe\nnot a line\n`)
  assert.equal(sums.get('one.zip'), 'a'.repeat(64))
  assert.equal(sums.get('two.exe'), 'b'.repeat(64))
  assert.equal(sums.size, 2)
})

test('both checksums must match, and one must exist', () => {
  const asset = { name: 'x.zip', size: 1, url: '', digest: `sha256:${'c'.repeat(64)}` }
  verifyChecksums(asset, 'c'.repeat(64), new Map([['x.zip', 'c'.repeat(64)]]))
  assert.throws(() => verifyChecksums(asset, 'd'.repeat(64), null), /GitHub’s checksum/)
  assert.throws(() => verifyChecksums(asset, 'c'.repeat(64), new Map([['x.zip', 'e'.repeat(64)]])), /SHA256SUMS/)
  assert.throws(() => verifyChecksums({ ...asset, digest: null }, 'c'.repeat(64), new Map()), /no checksum/)
})

test('the install kind follows how the app was launched', () => {
  const base = { isPackaged: true, env: {}, owner: () => null, writable: () => true }
  const mac = detectInstall({ ...base, platform: 'darwin', execPath: '/Applications/Goldfelty Portfolio Manager.app/Contents/MacOS/Goldfelty Portfolio Manager' })
  assert.deepEqual(mac, { kind: 'mac', target: '/Applications/Goldfelty Portfolio Manager.app', blocked: null })
  const dmg = detectInstall({ ...base, platform: 'darwin', execPath: '/Volumes/Goldfelty/Goldfelty Portfolio Manager.app/Contents/MacOS/Goldfelty Portfolio Manager' })
  assert.match(dmg.blocked, /Applications folder/)

  assert.equal(detectInstall({ ...base, platform: 'win32', execPath: 'C:\\Users\\a\\AppData\\Local\\Programs\\goldfelty\\Goldfelty.exe' }).kind, 'nsis')
  const portable = detectInstall({ ...base, platform: 'win32', execPath: 'C:\\Temp\\x\\Goldfelty.exe', env: { PORTABLE_EXECUTABLE_FILE: 'D:\\Apps\\Goldfelty.exe' } })
  assert.deepEqual(portable, { kind: 'portable', target: 'D:\\Apps\\Goldfelty.exe', blocked: null })

  const image = detectInstall({ ...base, platform: 'linux', execPath: '/tmp/.mount_x/goldfelty', env: { APPIMAGE: '/home/a/Apps/Goldfelty.AppImage' } })
  assert.deepEqual(image, { kind: 'appimage', target: '/home/a/Apps/Goldfelty.AppImage', blocked: null })
  assert.equal(detectInstall({ ...base, platform: 'linux', execPath: '/opt/Goldfelty Portfolio Manager/goldfelty-portfolio-manager', owner: () => 'deb' }).kind, 'deb')
  assert.equal(detectInstall({ ...base, platform: 'linux', execPath: '/opt/Goldfelty Portfolio Manager/goldfelty-portfolio-manager', owner: () => 'rpm' }).kind, 'rpm')
  const folder = detectInstall({ ...base, platform: 'linux', execPath: '/home/a/goldfelty/goldfelty-portfolio-manager' })
  assert.deepEqual(folder, { kind: 'targz', target: '/home/a/goldfelty', blocked: null })
  assert.match(detectInstall({ ...base, platform: 'linux', execPath: '/home/a/goldfelty/x', writable: () => false }).blocked, /writable/)
  assert.equal(detectInstall({ ...base, isPackaged: false, platform: 'linux', execPath: '/x' }).kind, 'dev')
})

/* ---- Against a stand-in for GitHub --------------------------------------------------- */

const files = new Map() // path -> Buffer
let release = null
const server = createServer((req, res) => {
  if (req.url === '/api/releases/latest') {
    res.writeHead(200, { 'content-type': 'application/json' })
    return res.end(JSON.stringify(release))
  }
  if (req.url === '/redirect-away') {
    res.writeHead(302, { location: 'https://example.com/evil.AppImage' })
    return res.end()
  }
  const file = files.get(req.url)
  if (!file) {
    res.writeHead(404)
    return res.end()
  }
  res.writeHead(200, { 'content-type': 'application/octet-stream' })
  res.end(file)
})
await new Promise((r) => server.listen(0, '127.0.0.1', r))
const origin = `http://127.0.0.1:${server.address().port}`
test.after(() => server.close())

const sha = (buf) => createHash('sha256').update(buf).digest('hex')

function publish(version, name, content, { digest = sha(content), sums = sha(content), url } = {}) {
  files.set(`/dl/${name}`, content)
  const assets = [{ name, size: content.length, browser_download_url: url ?? `${origin}/dl/${name}`, digest: digest && `sha256:${digest}` }]
  if (sums) {
    const text = Buffer.from(`${sums}  ${name}\n`)
    files.set('/dl/SHA256SUMS.txt', text)
    assets.push({ name: 'SHA256SUMS.txt', size: text.length, browser_download_url: `${origin}/dl/SHA256SUMS.txt`, digest: `sha256:${sha(text)}` })
  }
  release = { tag_name: `v${version}`, html_url: `${origin}/release`, draft: false, prerelease: false, assets }
}

function updater(t, install, { auto = true, current = '1.2.0' } = {}) {
  const dataDir = mkdtempSync(join(tmpdir(), 'goldfelty-update-'))
  t.after(() => rmSync(dataDir, { recursive: true, force: true }))
  const seen = []
  let quit = 0
  let autoOn = auto
  const u = new Updater({
    currentVersion: current,
    dataDir,
    install,
    arch: 'x64',
    autoUpdate: () => autoOn,
    setAutoUpdate: (on) => (autoOn = on),
    quit: () => quit++,
    onChange: (s) => seen.push(s.state),
    apiBase: `${origin}/api`
  })
  return { u, seen, quits: () => quit, dataDir }
}

test('an AppImage downloads the new AppImage, checks it, and replaces itself', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'goldfelty-appimage-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const target = join(dir, 'Goldfelty.AppImage')
  writeFileSync(target, 'old version')
  const content = Buffer.from('new version '.repeat(1000))
  publish('1.3.0', 'Goldfelty.Portfolio.Manager-1.3.0-x86_64.AppImage', content)

  const { u, seen, quits } = updater(t, { kind: 'appimage', target, blocked: null })
  await u.check(true)
  assert.equal(u.snapshot.state, 'ready', u.snapshot.message)
  assert.equal(u.snapshot.latest, '1.3.0')
  assert.ok(seen.includes('downloading'))
  assert.equal(readFileSync(target, 'utf8'), 'old version', 'nothing changes until it installs')

  await u.install(false)
  assert.deepEqual(readFileSync(target), content)
  assert.ok(statSync(target).mode & 0o100, 'still executable')
  assert.equal(quits(), 0, 'installing on quit doesn’t quit again')
})

test('a download that doesn’t match its checksum is thrown away', async (t) => {
  const content = Buffer.from('tampered')
  publish('1.3.0', 'Goldfelty.Portfolio.Manager-1.3.0-x86_64.AppImage', content, { digest: 'f'.repeat(64) })
  const { u, dataDir } = updater(t, { kind: 'appimage', target: '/nowhere/Goldfelty.AppImage', blocked: null })
  await u.check(false)
  assert.equal(u.snapshot.state, 'error')
  assert.match(u.snapshot.message, /checksum/)
  assert.equal(existsSync(join(dataDir, 'updates')), false)
})

test('a redirect anywhere but GitHub is refused', async (t) => {
  publish('1.3.0', 'Goldfelty.Portfolio.Manager-1.3.0-x86_64.AppImage', Buffer.from('x'), { url: `${origin}/redirect-away` })
  const { u } = updater(t, { kind: 'appimage', target: '/nowhere/Goldfelty.AppImage', blocked: null })
  await u.check(false)
  assert.equal(u.snapshot.state, 'error')
  assert.match(u.snapshot.message, /Refused to fetch from example\.com/)
})

test('up to date, automatic updates off, and installs that can’t update themselves', async (t) => {
  publish('1.2.0', 'Goldfelty.Portfolio.Manager-1.2.0-x86_64.AppImage', Buffer.from('same'))
  const same = updater(t, { kind: 'appimage', target: '/x', blocked: null })
  await same.u.check(true)
  assert.equal(same.u.snapshot.state, 'up-to-date')

  publish('1.3.0', 'Goldfelty.Portfolio.Manager-1.3.0-x86_64.AppImage', Buffer.from('newer'))
  const off = updater(t, { kind: 'appimage', target: '/x', blocked: null }, { auto: false })
  await off.u.check(true)
  assert.equal(off.u.snapshot.state, 'available', 'it says so, and waits to be asked')

  const dmg = updater(t, { kind: 'mac', target: '/Volumes/G/Goldfelty.app', blocked: 'Move Goldfelty to your Applications folder to get updates.' })
  await dmg.u.check(true)
  assert.equal(dmg.u.snapshot.state, 'manual')
  assert.match(dmg.u.snapshot.message, /Applications/)

  const missing = updater(t, { kind: 'deb', target: null, blocked: null })
  await missing.u.check(true)
  assert.equal(missing.u.snapshot.state, 'manual', 'no .deb in this release')
})

test('a tar.gz folder gets the new folder unpacked beside it, ready to swap', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'goldfelty-targz-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const installed = join(root, 'goldfelty')
  mkdirSync(installed)
  // Build a release tarball laid out like electron-builder's.
  const stage = join(root, 'stage')
  const top = join(stage, 'goldfelty-portfolio-manager-1.3.0-x64')
  mkdirSync(top, { recursive: true })
  writeFileSync(join(top, basename(process.execPath)), 'new binary')
  const tarball = join(root, 'release.tar.gz')
  execFileSync('tar', ['-czf', tarball, '-C', stage, 'goldfelty-portfolio-manager-1.3.0-x64'])
  publish('1.3.0', 'goldfelty-portfolio-manager-1.3.0-x64.tar.gz', readFileSync(tarball))

  const { u } = updater(t, { kind: 'targz', target: installed, blocked: null })
  await u.check(true)
  assert.equal(u.snapshot.state, 'ready', u.snapshot.message)
  assert.equal(readFileSync(join(root, '.goldfelty-update-1.3.0', 'goldfelty-portfolio-manager-1.3.0-x64', basename(process.execPath)), 'utf8'), 'new binary')
})

test('the swap scripts replace the app and the folder, and keep the old one if the move fails', async (t) => {
  const { MAC_SWAP, FOLDER_SWAP } = await import('../src/main/updater.ts')
  const root = mkdtempSync(join(tmpdir(), 'goldfelty-swap-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  // A process that has already exited, so the scripts don't wait.
  const gone = String(execFileSync('sh', ['-c', 'echo $$']).toString().trim())

  // The Mac script, on an .app-shaped folder.
  const app = join(root, 'Goldfelty.app')
  const fresh = join(root, 'updates', 'Goldfelty.app')
  mkdirSync(app)
  writeFileSync(join(app, 'v'), 'old')
  mkdirSync(fresh, { recursive: true })
  writeFileSync(join(fresh, 'v'), 'new')
  writeFileSync(join(root, 'mac.sh'), MAC_SWAP)
  execFileSync('sh', [join(root, 'mac.sh'), gone, fresh, app, '0'])
  assert.equal(readFileSync(join(app, 'v'), 'utf8'), 'new')
  assert.equal(existsSync(`${app}.previous`), false)

  // A failed move puts the old app back.
  execFileSync('sh', [join(root, 'mac.sh'), gone, join(root, 'missing.app'), app, '0'])
  assert.equal(readFileSync(join(app, 'v'), 'utf8'), 'new', 'still there after a failed swap')

  // The tar.gz folder script.
  const folder = join(root, 'goldfelty')
  const unpackDir = join(root, '.goldfelty-update-1.3.0')
  const next = join(unpackDir, 'goldfelty-portfolio-manager-1.3.0-x64')
  mkdirSync(folder)
  writeFileSync(join(folder, 'bin'), 'old')
  mkdirSync(next, { recursive: true })
  writeFileSync(join(next, 'bin'), 'new')
  writeFileSync(join(root, 'folder.sh'), FOLDER_SWAP)
  execFileSync('sh', [join(root, 'folder.sh'), gone, next, folder, 'bin', '0'])
  assert.equal(readFileSync(join(folder, 'bin'), 'utf8'), 'new')
  assert.equal(existsSync(unpackDir), false, 'the unpack folder is cleaned up')
  assert.equal(existsSync(`${folder}.previous`), false)
})
