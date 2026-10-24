## Goldfelty 1.1.2

**Exodus.** The Exodus desktop and phone apps don’t let other apps connect to
them: Exodus ended WalletConnect and its dApp browser in 2026. Goldfelty now
says so, and lets you track an Exodus address instead, so its balances count in
your portfolio. Send from Exodus itself. Connect a wallet > Can’t connect >
Exodus. “Another wallet” does the same for any other address.

The browser list is now labelled **Browser extensions**, and its Exodus entry
is the Exodus Web3 Wallet extension, which is what it always was.

Also: `SHA256SUMS.txt` now lists files under the names GitHub serves them as,
so `shasum -c` checks the macOS and Windows downloads too.

New in 1.1 (from 1.1.1): Goldfelty connects the wallets you already use
instead of creating them, has a new desktop interface, encrypts everything it
stores, and takes a fee on sends, shown before every send. See the
[Terms](https://goldfelty.com/terms/) and the
[security review](https://github.com/gceoalexyt-ops/goldfelty-portfolio-manager/blob/main/docs/SECURITY-AUDIT.md).

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
