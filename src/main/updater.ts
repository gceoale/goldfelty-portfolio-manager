import { createHash } from 'node:crypto'
import { spawn, execFile, execFileSync } from 'node:child_process'
import { accessSync, constants, createWriteStream, existsSync, mkdirSync, readdirSync, renameSync, rmSync, writeFileSync, chmodSync, copyFileSync } from 'node:fs'
import { dirname, join, basename } from 'node:path'
import type { InstallKind, UpdateStatus } from '../shared/types.ts'

/**
 * Updates, from this repository's GitHub releases.
 *
 * Each copy of the app updates the way it was installed: the Mac app
 * replaces itself, the Windows installer runs the new installer silently,
 * the portable .exe swaps in the new one, an AppImage replaces its file,
 * .deb and .rpm installs go through the system's package tools, and a
 * tar.gz folder is swapped for the new one. Where none of that is possible
 * (the app is running from a disk image, say), it says so and links the
 * release instead.
 *
 * Every download is checked against two SHA-256 sums before anything is
 * installed: the digest GitHub records for the asset, and SHA256SUMS.txt
 * from the same release. Requests go only to GitHub, over HTTPS.
 */

export const REPO = 'gceoale/goldfelty-portfolio-manager'
const API = `https://api.github.com/repos/${REPO}`
/** Hosts a release download may come from or redirect through. */
const HOSTS = new Set(['api.github.com', 'github.com', 'objects.githubusercontent.com', 'release-assets.githubusercontent.com', 'github-releases.githubusercontent.com'])
const MAX_ASSET_BYTES = 600 * 1024 * 1024
const CHECK_EVERY_MS = 6 * 3_600_000
const FIRST_CHECK_MS = 30_000

/* ---- Pure parts, tested on their own ------------------------------------------------ */

export function parseVersion(v: string): [number, number, number] | null {
  const m = /^v?(\d+)\.(\d+)\.(\d+)$/.exec(v.trim())
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null
}

export function isNewer(candidate: string, current: string): boolean {
  const a = parseVersion(candidate)
  const b = parseVersion(current)
  if (!a || !b) return false
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] > b[i]
  return false
}

export const KIND_LABEL: Record<InstallKind, string> = {
  mac: 'Mac app',
  nsis: 'Windows installer',
  portable: 'Windows portable app',
  appimage: 'AppImage',
  deb: 'Debian/Ubuntu package (.deb)',
  rpm: 'Fedora/openSUSE package (.rpm)',
  targz: 'Linux folder (.tar.gz)',
  dev: 'Development build'
}

/**
 * The release file that updates this kind of install, as GitHub names it
 * (it turns the spaces in "Goldfelty Portfolio Manager" into dots).
 */
export function assetNameFor(kind: InstallKind, arch: 'x64' | 'arm64', version: string): string | null {
  const product = 'Goldfelty.Portfolio.Manager'
  const pkg = 'goldfelty-portfolio-manager'
  switch (kind) {
    case 'mac':
      // The .dmg and the .zip hold the same app; the .zip can be unpacked without mounting anything.
      return `${product}-${version}-${arch}-mac.zip`
    case 'nsis':
      return `${product}-${version}-${arch}-setup.exe`
    case 'portable':
      return `${product}-${version}-${arch}-portable.exe`
    case 'appimage':
      return `${product}-${version}-${arch === 'x64' ? 'x86_64' : 'arm64'}.AppImage`
    case 'deb':
      return `${pkg}_${version}_${arch === 'x64' ? 'amd64' : 'arm64'}.deb`
    case 'rpm':
      return `${pkg}-${version}.${arch === 'x64' ? 'x86_64' : 'aarch64'}.rpm`
    case 'targz':
      return `${pkg}-${version}-${arch}.tar.gz`
    default:
      return null
  }
}

/** SHA256SUMS.txt lines: "<hex>  <name>". */
export function parseSums(text: string): Map<string, string> {
  const out = new Map<string, string>()
  for (const line of text.split('\n')) {
    const m = /^([0-9a-f]{64})\s+\*?(.+)$/i.exec(line.trim())
    if (m) out.set(m[2].trim(), m[1].toLowerCase())
  }
  return out
}

export interface InstallInfo {
  kind: InstallKind
  /** What gets replaced: the .app, the portable .exe, the AppImage, or the tar.gz folder. */
  target: string | null
  /** Why this install can't update itself, if it can't. */
  blocked: string | null
}

export interface InstallEnv {
  platform: NodeJS.Platform
  execPath: string
  env: Record<string, string | undefined>
  isPackaged: boolean
  /** Which package manager owns a file, if any. */
  owner: (path: string) => 'deb' | 'rpm' | null
  writable: (path: string) => boolean
}

/** Work out how this copy was installed, from where it runs and what launched it. */
export function detectInstall(e: InstallEnv): InstallInfo {
  if (!e.isPackaged) return { kind: 'dev', target: null, blocked: 'Development builds don’t update themselves.' }
  if (e.platform === 'darwin') {
    const app = e.execPath.replace(/\/Contents\/MacOS\/[^/]+$/, '')
    if (!app.endsWith('.app')) return { kind: 'mac', target: null, blocked: 'Couldn’t find the app bundle.' }
    if (app.startsWith('/Volumes/') || app.includes('/AppTranslocation/')) {
      return { kind: 'mac', target: app, blocked: 'Move Goldfelty to your Applications folder to get updates.' }
    }
    if (!e.writable(dirname(app)) || !e.writable(app)) return { kind: 'mac', target: app, blocked: 'Goldfelty’s folder isn’t writable, so it can’t update itself.' }
    return { kind: 'mac', target: app, blocked: null }
  }
  if (e.platform === 'win32') {
    const portable = e.env.PORTABLE_EXECUTABLE_FILE
    if (portable) {
      return e.writable(dirname(portable))
        ? { kind: 'portable', target: portable, blocked: null }
        : { kind: 'portable', target: portable, blocked: 'The folder holding Goldfelty isn’t writable, so it can’t update itself.' }
    }
    return { kind: 'nsis', target: null, blocked: null }
  }
  if (e.platform === 'linux') {
    const image = e.env.APPIMAGE
    if (image) {
      return e.writable(dirname(image))
        ? { kind: 'appimage', target: image, blocked: null }
        : { kind: 'appimage', target: image, blocked: 'The folder holding the AppImage isn’t writable, so it can’t update itself.' }
    }
    const owner = e.owner(e.execPath)
    if (owner) return { kind: owner, target: null, blocked: null }
    const folder = dirname(e.execPath)
    if (!e.writable(folder) || !e.writable(dirname(folder))) {
      return { kind: 'targz', target: folder, blocked: 'Goldfelty’s folder isn’t writable, so it can’t update itself.' }
    }
    return { kind: 'targz', target: folder, blocked: null }
  }
  return { kind: 'dev', target: null, blocked: 'Updates aren’t available on this system.' }
}

/* ---- Network: GitHub only ------------------------------------------------------------- */

export interface ReleaseAsset {
  name: string
  size: number
  url: string
  /** "sha256:<hex>", when GitHub has recorded it. */
  digest: string | null
}
export interface Release {
  version: string
  url: string
  assets: ReleaseAsset[]
}

/** fetch, following redirects only to GitHub's own hosts, over HTTPS. */
async function githubFetch(url: string, allowLocal: boolean, accept: string): Promise<Response> {
  let current = url
  for (let hop = 0; hop < 6; hop++) {
    const u = new URL(current)
    const local = allowLocal && u.protocol === 'http:' && u.hostname === '127.0.0.1'
    if (!local && (u.protocol !== 'https:' || !HOSTS.has(u.hostname))) throw new Error(`Refused to fetch from ${u.hostname}.`)
    const res = await fetch(current, {
      redirect: 'manual',
      headers: { accept, 'user-agent': 'Goldfelty-Updater' },
      signal: AbortSignal.timeout(10 * 60_000)
    })
    if (res.status >= 300 && res.status < 400) {
      const next = res.headers.get('location')
      if (!next) throw new Error('A redirect without a destination.')
      current = new URL(next, current).toString()
      continue
    }
    if (!res.ok) throw new Error(`GitHub answered ${res.status}.`)
    return res
  }
  throw new Error('Too many redirects.')
}

export async function latestRelease(apiBase = API, allowLocal = false): Promise<Release> {
  const res = await githubFetch(`${apiBase}/releases/latest`, allowLocal, 'application/vnd.github+json')
  const body = (await res.json()) as {
    tag_name?: string
    html_url?: string
    draft?: boolean
    prerelease?: boolean
    assets?: Array<{ name?: string; size?: number; browser_download_url?: string; digest?: string | null }>
  }
  const version = String(body.tag_name ?? '').replace(/^v/, '')
  if (!parseVersion(version) || body.draft || body.prerelease) throw new Error('The latest release isn’t a usable version.')
  return {
    version,
    url: String(body.html_url ?? `https://github.com/${REPO}/releases`),
    assets: (body.assets ?? [])
      .filter((a) => typeof a.name === 'string' && typeof a.browser_download_url === 'string')
      .map((a) => ({ name: a.name!, size: Number(a.size) || 0, url: a.browser_download_url!, digest: typeof a.digest === 'string' ? a.digest : null }))
  }
}

/** Download to `dest`, hashing as it goes. Returns the SHA-256 in hex. */
export async function download(asset: ReleaseAsset, dest: string, onProgress: (fraction: number) => void, allowLocal = false): Promise<string> {
  if (asset.size > MAX_ASSET_BYTES) throw new Error('That download is unexpectedly large.')
  const res = await githubFetch(asset.url, allowLocal, 'application/octet-stream')
  if (!res.body) throw new Error('Empty download.')
  const hash = createHash('sha256')
  const out = createWriteStream(dest, { mode: 0o600 })
  let received = 0
  try {
    for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
      received += chunk.length
      if (received > MAX_ASSET_BYTES) throw new Error('That download is unexpectedly large.')
      hash.update(chunk)
      if (!out.write(chunk)) await new Promise<void>((r) => out.once('drain', () => r()))
      if (asset.size) onProgress(Math.min(1, received / asset.size))
    }
  } finally {
    await new Promise<void>((resolve) => out.end(() => resolve()))
  }
  if (asset.size && received !== asset.size) throw new Error('The download was cut short.')
  return hash.digest('hex')
}

/** Both checksums must agree with the file, and at least one must exist. */
export function verifyChecksums(asset: ReleaseAsset, actual: string, sums: Map<string, string> | null): void {
  const fromGithub = asset.digest?.startsWith('sha256:') ? asset.digest.slice(7).toLowerCase() : null
  const fromSums = sums?.get(asset.name) ?? null
  if (!fromGithub && !fromSums) throw new Error('The release has no checksum for this file, so it wasn’t installed.')
  if (fromGithub && fromGithub !== actual) throw new Error('The download doesn’t match GitHub’s checksum, so it wasn’t installed.')
  if (fromSums && fromSums !== actual) throw new Error('The download doesn’t match SHA256SUMS.txt, so it wasn’t installed.')
}

/* ---- The updater ----------------------------------------------------------------------- */

export interface UpdaterDeps {
  currentVersion: string
  dataDir: string
  install: InstallInfo
  arch: 'x64' | 'arm64'
  autoUpdate: () => boolean
  setAutoUpdate: (on: boolean) => void
  /** Quit the app; the installer helper is already waiting for this process to exit. */
  quit: () => void
  onChange: (status: UpdateStatus) => void
  /** For tests: a local stand-in for the GitHub API. */
  apiBase?: string
  /** Opens a file with the system's default handler (the software installer, for .deb and .rpm). */
  openPath?: (path: string) => Promise<string>
}

interface Ready {
  version: string
  file: string
  /** The unpacked .app or tar.gz folder, where that applies. */
  unpacked: string | null
}

export class Updater {
  private readonly d: UpdaterDeps
  private status: UpdateStatus
  private ready: Ready | null = null
  private busy: Promise<void> | null = null
  private timer: NodeJS.Timeout | null = null
  private readonly dir: string

  constructor(deps: UpdaterDeps) {
    this.d = deps
    this.dir = join(deps.dataDir, 'updates')
    this.status = {
      state: deps.install.kind === 'dev' ? 'manual' : 'idle',
      current: deps.currentVersion,
      latest: null,
      progress: null,
      kind: deps.install.kind,
      kindLabel: KIND_LABEL[deps.install.kind],
      message: deps.install.kind === 'dev' ? deps.install.blocked : null,
      releaseUrl: `https://github.com/${REPO}/releases/latest`,
      autoUpdate: deps.autoUpdate(),
      checkedAt: null
    }
  }

  get snapshot(): UpdateStatus {
    return { ...this.status, autoUpdate: this.d.autoUpdate() }
  }

  private set(patch: Partial<UpdateStatus>): void {
    this.status = { ...this.status, ...patch }
    this.d.onChange(this.snapshot)
  }

  /** Check now, then every few hours. */
  start(): void {
    if (this.d.install.kind === 'dev') return
    // Leftovers from an update that already installed.
    try {
      rmSync(this.dir, { recursive: true, force: true })
    } catch {
      // An installer still finishing up; next launch, then.
    }
    const first = setTimeout(() => void this.check(true), FIRST_CHECK_MS)
    first.unref?.()
    this.timer = setInterval(() => void this.check(true), CHECK_EVERY_MS)
    this.timer.unref?.()
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
  }

  setAuto(on: boolean): UpdateStatus {
    this.d.setAutoUpdate(on)
    this.set({ autoUpdate: on })
    if (on && this.status.state === 'idle') void this.check(true)
    return this.snapshot
  }

  /** Look for a newer release; download it straight away when allowed. */
  check(automatic = false): Promise<void> {
    if (this.busy) return this.busy
    if (this.d.install.kind === 'dev') return Promise.resolve()
    this.busy = this.run(automatic).finally(() => {
      this.busy = null
    })
    return this.busy
  }

  private async run(automatic: boolean): Promise<void> {
    if (this.ready) return
    this.set({ state: 'checking', message: null, progress: null })
    let release: Release
    try {
      release = await latestRelease(this.d.apiBase ?? API, !!this.d.apiBase)
    } catch (error) {
      // A quiet background check that fails shouldn't nag.
      this.set({ state: automatic ? 'idle' : 'error', message: automatic ? null : `Couldn’t check for updates: ${(error as Error).message}`, checkedAt: Date.now() })
      return
    }
    this.set({ latest: release.version, releaseUrl: release.url, checkedAt: Date.now() })
    if (!isNewer(release.version, this.d.currentVersion)) return this.set({ state: 'up-to-date' })

    const name = assetNameFor(this.d.install.kind, this.d.arch, release.version)
    const asset = release.assets.find((a) => a.name === name)
    if (this.d.install.blocked || !asset) {
      return this.set({ state: 'manual', message: this.d.install.blocked ?? `Version ${release.version} has no ${KIND_LABEL[this.d.install.kind]} download for this computer. Get it from the release page.` })
    }
    // Automatic updates off: say it's there, and wait to be asked.
    if (automatic && !this.d.autoUpdate()) return this.set({ state: 'available', message: null })
    await this.fetchAndPrepare(release, asset)
  }

  /** Download, verify and unpack, without installing. */
  async fetchAndPrepare(release: Release, asset: ReleaseAsset): Promise<void> {
    const local = !!this.d.apiBase
    try {
      rmSync(this.dir, { recursive: true, force: true })
      mkdirSync(this.dir, { recursive: true, mode: 0o700 })
      this.set({ state: 'downloading', progress: 0, message: null })
      const file = join(this.dir, asset.name)
      const partial = `${file}.partial`
      const sha = await download(asset, partial, (progress) => this.set({ progress }), local)
      const sumsAsset = release.assets.find((a) => a.name === 'SHA256SUMS.txt')
      let sums: Map<string, string> | null = null
      if (sumsAsset) sums = parseSums(await (await githubFetch(sumsAsset.url, local, 'text/plain')).text())
      verifyChecksums(asset, sha, sums)
      renameSync(partial, file)
      const unpacked = await this.unpack(file, release.version)
      this.ready = { version: release.version, file, unpacked }
      this.set({ state: 'ready', progress: 1 })
    } catch (error) {
      rmSync(this.dir, { recursive: true, force: true })
      this.set({ state: 'error', progress: null, message: `The update didn’t download: ${(error as Error).message}` })
    }
  }

  private async unpack(file: string, version: string): Promise<string | null> {
    const kind = this.d.install.kind
    if (kind === 'mac') {
      const out = join(this.dir, 'unpacked')
      mkdirSync(out)
      // ditto keeps the bundle's symlinks and permissions, which unzip can lose.
      await run('ditto', ['-x', '-k', file, out])
      const app = readdirSync(out).find((n) => n.endsWith('.app'))
      if (!app) throw new Error('The download has no app inside.')
      const plist = join(out, app, 'Contents', 'Info.plist')
      const id = (await run('plutil', ['-extract', 'CFBundleIdentifier', 'raw', plist])).trim()
      const v = (await run('plutil', ['-extract', 'CFBundleShortVersionString', 'raw', plist])).trim()
      if (id !== 'com.goldfelty.portfolio' || v !== version) throw new Error('The download isn’t the expected Goldfelty version.')
      return join(out, app)
    }
    if (kind === 'targz') {
      // Unpack beside the install so the final swap is a rename on one disk.
      const parent = dirname(this.d.install.target!)
      const out = join(parent, `.goldfelty-update-${version}`)
      rmSync(out, { recursive: true, force: true })
      mkdirSync(out, { mode: 0o755 })
      await run('tar', ['-xzf', file, '-C', out])
      const top = readdirSync(out).find((n) => existsSync(join(out, n, basename(process.execPath))))
      if (!top) throw new Error('The download isn’t laid out as expected.')
      return join(out, top)
    }
    if (kind === 'appimage' || kind === 'portable') chmodSync(file, 0o755)
    return null
  }

  /**
   * Install what was downloaded and restart into it. Unless `relaunch` is
   * false (quitting anyway), the new version opens once this one has closed.
   */
  async install(relaunch = true): Promise<UpdateStatus> {
    const ready = this.ready
    if (!ready) return this.snapshot
    const { kind, target } = this.d.install
    const pid = String(process.pid)
    this.set({ state: 'installing', message: null })
    try {
      switch (kind) {
        case 'mac': {
          const script = this.script('swap-app.sh', MAC_SWAP)
          detach('/bin/sh', [script, pid, ready.unpacked!, target!, relaunch ? '1' : '0'])
          break
        }
        case 'nsis':
          // electron-builder's installer: /S is silent, --updated keeps settings, --force-run reopens the app.
          detach(ready.file, ['--updated', '/S', ...(relaunch ? ['--force-run'] : [])])
          break
        case 'portable': {
          const script = this.script('swap-portable.cmd', portableSwap(pid, ready.file, target!, relaunch))
          detach('cmd.exe', ['/d', '/c', script], { windowsHide: true })
          break
        }
        case 'appimage': {
          // Replacing the file of a running AppImage is safe on Linux.
          const next = `${target}.update`
          copyFileSync(ready.file, next)
          chmodSync(next, 0o755)
          renameSync(next, target!)
          if (relaunch) detach('/bin/sh', [this.script('relaunch.sh', RELAUNCH), pid, target!])
          break
        }
        case 'deb':
        case 'rpm': {
          const args = kind === 'deb' ? ['dpkg', '-i', ready.file] : ['rpm', '-U', '--oldpackage', ready.file]
          try {
            // pkexec shows the system's own password prompt.
            await run('pkexec', args)
          } catch {
            // No pkexec, or the prompt was cancelled: hand the package to the system's installer.
            await this.d.openPath?.(ready.file)
            this.set({ state: 'ready', message: 'Finish installing in the window that opened, then restart Goldfelty.' })
            return this.snapshot
          }
          if (relaunch) detach('/bin/sh', [this.script('relaunch.sh', RELAUNCH), pid, process.execPath])
          break
        }
        case 'targz': {
          const script = this.script('swap-folder.sh', FOLDER_SWAP)
          detach('/bin/sh', [script, pid, ready.unpacked!, target!, basename(process.execPath), relaunch ? '1' : '0'])
          break
        }
        default:
          return this.snapshot
      }
    } catch (error) {
      this.set({ state: 'error', message: `The update couldn’t be installed: ${(error as Error).message}` })
      return this.snapshot
    }
    this.ready = null
    if (relaunch) this.d.quit()
    return this.snapshot
  }

  /** Called as the app quits: a downloaded update goes in without reopening the app. */
  installOnQuit(): void {
    if (!this.ready || this.status.state !== 'ready') return
    // Package installs need a password prompt; leave those for the next launch.
    if (this.d.install.kind === 'deb' || this.d.install.kind === 'rpm') return
    void this.install(false)
  }

  private script(name: string, body: string): string {
    const path = join(this.dir, name)
    writeFileSync(path, body, { mode: 0o700 })
    return path
  }
}

/* ---- Helpers that outlive the app ------------------------------------------------------ */

// Each waits for this process to exit, then swaps the new version in. Paths
// arrive as arguments, never pasted into the script text.

export const MAC_SWAP = `#!/bin/sh
# $1 pid, $2 new .app, $3 installed .app, $4 relaunch
while kill -0 "$1" 2>/dev/null; do sleep 0.5; done
old="$3.previous"
rm -rf "$old"
mv "$3" "$old" || exit 1
if mv "$2" "$3"; then rm -rf "$old"; else mv "$old" "$3"; fi
xattr -dr com.apple.quarantine "$3" 2>/dev/null
[ "$4" = 1 ] && open "$3"
exit 0
`

export const FOLDER_SWAP = `#!/bin/sh
# $1 pid, $2 new folder, $3 installed folder, $4 executable name, $5 relaunch
while kill -0 "$1" 2>/dev/null; do sleep 0.5; done
old="$3.previous"
rm -rf "$old"
mv "$3" "$old" || exit 1
if mv "$2" "$3"; then rm -rf "$old"; else mv "$old" "$3"; fi
rm -rf "$(dirname "$2")"
[ "$5" = 1 ] && nohup "$3/$4" >/dev/null 2>&1 &
exit 0
`

const RELAUNCH = `#!/bin/sh
# $1 pid, $2 program
while kill -0 "$1" 2>/dev/null; do sleep 0.5; done
nohup "$2" >/dev/null 2>&1 &
exit 0
`

/** cmd.exe has no argument passing worth trusting, so the paths are quoted in; Windows paths can't contain a double quote. */
function portableSwap(pid: string, file: string, target: string, relaunch: boolean): string {
  for (const p of [file, target]) if (p.includes('"')) throw new Error('Unexpected path.')
  return [
    '@echo off',
    ':wait',
    `tasklist /FI "PID eq ${pid}" 2>NUL | find "${pid}" >NUL && (timeout /t 1 /nobreak >NUL & goto wait)`,
    'set tries=0',
    ':move',
    `move /Y "${file}" "${target}" >NUL 2>&1 && goto done`,
    'set /a tries+=1',
    'if %tries% GEQ 30 exit /b 1',
    'timeout /t 1 /nobreak >NUL',
    'goto move',
    ':done',
    relaunch ? `start "" "${target}"` : 'rem',
    'exit /b 0',
    ''
  ].join('\r\n')
}

function detach(command: string, args: string[], options: { windowsHide?: boolean } = {}): void {
  const child = spawn(command, args, { detached: true, stdio: 'ignore', ...options })
  child.unref()
}

function run(command: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(command, args, { timeout: 10 * 60_000, maxBuffer: 1024 * 1024 }, (error, stdout) => (error ? reject(error) : resolve(String(stdout))))
  })
}

/* ---- Wiring for the real app ------------------------------------------------------------ */

function isWritable(path: string): boolean {
  try {
    accessSync(path, constants.W_OK)
    return true
  } catch {
    return false
  }
}

/** Which package manager installed `path`, asked synchronously once at startup. */
function packageOwner(path: string): 'deb' | 'rpm' | null {
  if (!path.startsWith('/opt/') && !path.startsWith('/usr/')) return null
  const owns = (cmd: string, args: string[]): boolean => {
    try {
      execFileSync(cmd, args, { stdio: 'ignore', timeout: 5_000 })
      return true
    } catch {
      return false
    }
  }
  if (owns('dpkg', ['-S', path])) return 'deb'
  if (owns('rpm', ['-qf', path])) return 'rpm'
  return null
}

export function detectThisInstall(isPackaged: boolean): InstallInfo {
  return detectInstall({
    platform: process.platform,
    execPath: process.execPath,
    env: process.env,
    isPackaged,
    owner: packageOwner,
    writable: isWritable
  })
}

/** For a running x64 build under Rosetta or Windows' emulation, the native build is the better update. */
export function updateArch(runningUnderArm64Translation: boolean): 'x64' | 'arm64' {
  if (runningUnderArm64Translation) return 'arm64'
  return process.arch === 'arm64' ? 'arm64' : 'x64'
}
