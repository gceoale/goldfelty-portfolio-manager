'use strict'

const { execFileSync } = require('node:child_process')
const path = require('node:path')
const { flipFuses, FuseVersion, FuseV1Options } = require('@electron/fuses')

/**
 * Runs on every packaged app before it is signed or wrapped in an installer.
 *
 * 1. Electron fuses. These are switches compiled into the Electron binary.
 *    Turning these off means the shipped app cannot be repurposed as a
 *    general Node runtime (ELECTRON_RUN_AS_NODE), cannot be steered with
 *    NODE_OPTIONS or --inspect, and only loads its code from app.asar.
 *
 * 2. Ad-hoc signing on macOS when no Developer ID certificate is configured.
 *    electron-builder skips signing without an identity, which leaves the
 *    bundle's signature describing a different executable; Apple silicon
 *    then reports the app as damaged. Re-sealing ad hoc makes it consistent.
 *    It does not make Gatekeeper trust a download; only a Developer ID
 *    certificate and notarisation do that (CSC_LINK and APPLE_ID).
 */
exports.default = async function afterPack(context) {
  const platform = context.electronPlatformName
  const product = context.packager.appInfo.productFilename
  const executable =
    platform === 'darwin'
      ? path.join(context.appOutDir, `${product}.app`)
      : platform === 'win32'
        ? path.join(context.appOutDir, `${product}.exe`)
        : path.join(context.appOutDir, context.packager.executableName)

  await flipFuses(executable, {
    version: FuseVersion.V1,
    // The ad-hoc step below re-signs the whole bundle, so no separate reset.
    resetAdHocDarwinSignature: false,
    [FuseV1Options.RunAsNode]: false,
    [FuseV1Options.EnableNodeOptionsEnvironmentVariable]: false,
    [FuseV1Options.EnableNodeCliInspectArguments]: false,
    [FuseV1Options.OnlyLoadAppFromAsar]: true,
    [FuseV1Options.EnableCookieEncryption]: true
  })
  console.log(`  • fuses set  ${path.basename(executable)}`)

  if (platform !== 'darwin') return
  // A real certificate is present, so electron-builder signs it properly.
  if (process.env.CSC_LINK) return

  // --deep is deprecated for distribution signing but remains the practical
  // way to ad-hoc seal an Electron bundle's nested helpers and frameworks.
  execFileSync('codesign', ['--force', '--deep', '--sign', '-', executable], { stdio: 'inherit' })
  execFileSync('codesign', ['--verify', '--deep', '--strict', executable], { stdio: 'inherit' })
  console.log(`  • ad-hoc signed (no certificate configured)  ${path.basename(executable)}`)
}
