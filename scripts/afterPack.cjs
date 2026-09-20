'use strict'

const { execFileSync } = require('node:child_process')
const path = require('node:path')

/**
 * Ad-hoc sign macOS builds when no Developer ID certificate is configured.
 *
 * electron-builder skips code signing entirely when it cannot find an
 * identity. That leaves the .app in a state Apple silicon refuses outright:
 * the Electron binary keeps the ad-hoc signature it shipped with, but
 * electron-builder has since renamed the executable and rewritten Info.plist,
 * and no `_CodeSignature/CodeResources` seals the bundle. The signature no
 * longer describes the bundle, so the loader rejects it and Finder reports
 * the app as "damaged and can't be opened".
 *
 * Re-sealing with an ad-hoc signature makes the bundle internally consistent,
 * so it runs once the quarantine attribute is cleared. It does NOT make
 * Gatekeeper trust a download — only a Developer ID certificate plus
 * notarisation does that, which is what CSC_LINK and APPLE_ID enable.
 */
exports.default = async function afterPack(context) {
  if (context.electronPlatformName !== 'darwin') return

  // A real certificate is present, so electron-builder signs it properly.
  if (process.env.CSC_LINK) return

  const appPath = path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`)

  // --deep is deprecated for distribution signing but remains the practical
  // way to ad-hoc seal an Electron bundle's nested helpers and frameworks.
  execFileSync('codesign', ['--force', '--deep', '--sign', '-', appPath], { stdio: 'inherit' })
  execFileSync('codesign', ['--verify', '--deep', '--strict', appPath], { stdio: 'inherit' })

  console.log(`  • ad-hoc signed (no certificate configured)  ${path.basename(appPath)}`)
}
