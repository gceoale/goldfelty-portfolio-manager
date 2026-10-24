## Goldfelty 1.1.1

A rebuilt app. Goldfelty no longer creates wallets: you connect the ones you
already use, and they approve everything.

**New**

- Connects to 33 browser wallets through Goldfelty's own local connection,
  plus Frame on the desktop and any WalletConnect phone wallet.
- A new interface that looks and behaves like a desktop app, in light and dark.
- When several wallets hold a token, you choose which one sends it. Goldfelty
  switches the wallet to the right network first, warns about lookalike
  addresses, and checks the chain recorded what you approved.
- Optional goldfelty.com account, proved by a signature from your wallet.

**Fees.** Goldfelty now takes a fee on tokens sent through it, currently 0.5%,
shown before every send and approved in your wallet as its own transaction. See
the [Terms](https://goldfelty.com/terms/).

**Security.** Everything Goldfelty stores is now encrypted with your password.
Electron 44, locked-down builds, and a full internal security review:
[docs/SECURITY-AUDIT.md](https://github.com/gceoalexyt-ops/goldfelty-portfolio-manager/blob/main/docs/SECURITY-AUDIT.md).

**Upgrading from 1.0.** Unlock with your existing password. Addresses that 1.0
created are kept as read-only; don't send anything to them. Your old encrypted
vault is kept unchanged next to the new one. Wallets you had connected need
connecting again.

## Which file do I download?

| Your machine | File |
| --- | --- |
| Mac, Apple silicon | `…-arm64.dmg` |
| Mac, Intel | `…-x64.dmg` |
| Windows, Intel or AMD | `…-x64-setup.exe` |
| Windows on ARM | `…-arm64-setup.exe` |
| Linux, x64 | `…-x86_64.AppImage`, `…_amd64.deb` or `…x86_64.rpm` |
| Linux, ARM64 | `…-arm64.AppImage`, `…_arm64.deb` or `…aarch64.rpm` |

`-portable.exe`, `-mac.zip` and `.tar.gz` are the same app without an installer.
Check a download against `SHA256SUMS.txt`:

```bash
shasum -a 256 -c SHA256SUMS.txt --ignore-missing
```

## Unsigned builds

These builds aren't signed by Apple or Microsoft yet. On a Mac, after moving
the app to Applications:

```bash
xattr -dr com.apple.quarantine "/Applications/Goldfelty Portfolio Manager.app"
```

On Windows, choose **More info > Run anyway**. AppImages need
`chmod +x` first.
