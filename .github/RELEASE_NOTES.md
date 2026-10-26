## Goldfelty 1.2.2

**More wallets connect.** Every supported wallet was tested against its real
browser extension, and this fixes what that turned up:

- Zerion, Taho and Gate Wallet now connect. They only work on `localhost`
  pages, so Goldfelty's browser tab now opens there.
- Coinbase Wallet connects properly; the tab no longer blocks its own code.
- Wallets that also act as a Tron or Bitcoin wallet connect those under their
  own name: Trust Wallet, SafePal, Gate and Fordefi on Tron; Backpack and OneKey
  on Bitcoin and Tron; TokenPocket on Bitcoin.
- Bitget Wallet and Ctrl, which can be slow to start right after the browser
  opens, are picked up when they're ready, and the tab has a Reload button.

Accounts on goldfelty.com also link again; that was fixed on the server, for
every version.

If you have 1.2.0 or 1.2.1, the app updates itself to this version.

## Goldfelty 1.2.1

**A new logo.** Goldfelty has a proper icon now: a serif G with a gold dot, on
a dark tile. You’ll see it in your Dock, taskbar or app menu, on the lock
screen, on the wallet bridge page and on goldfelty.com.

If you installed 1.2.0, the app updates itself to this version.

## What arrived in 1.2

**Bitcoin, Solana and Tron.** Connect Bitcoin, Solana and Tron wallets from the
same browser tab as your Ethereum ones, see their balances, and send and
receive BTC, SOL, TRX and the USDC and USDT that live there.

- Bitcoin: UniSat, Xverse, Leather, OKX, Bitget and OneKey, with native and
  nested SegWit, Taproot and legacy addresses.
- Solana: any wallet that supports the Solana Wallet Standard, such as Phantom,
  Solflare, Backpack and MetaMask.
- Tron: TronLink, OKX and Bitget.
- A wallet that does several chains, like Phantom or OKX, is connected for all
  of them at once.
- **Litecoin, Dogecoin and XRP**: track an address and its balance counts in
  your portfolio. No wallet for these lets other apps ask it to sign, so you
  send from the wallet itself.

On these chains Goldfelty builds the transaction, your wallet signs it, and
Goldfelty checks that what came back is exactly what you reviewed before
broadcasting it.

**The fee is now a fixed 0.5%.** It’s built into the app, so no server,
goldfelty.com included, can raise it, and the app no longer fetches anything to
decide it. On Bitcoin and Solana it’s part of the same transaction as your
transfer; elsewhere it’s still a second transaction. Viewing, tracking and
receiving stay free. See the updated [Terms](https://goldfelty.com/terms/).

**Checking a download.** Every file now carries a build provenance attestation:
a signed, public record that it was built by this repository’s release
workflow from this exact commit.

```bash
gh attestation verify <file> --repo gceoale/goldfelty-portfolio-manager
```

**Automatic updates.** From this version on, Goldfelty updates itself the way
you installed it: the Mac app, the Windows installer or portable app, the
AppImage, the .deb or .rpm package, or the tar.gz folder. It downloads in the
background, checks the file against the release’s checksums, and installs when
you restart or quit. You can switch this off in Settings > Updates. Earlier
versions don’t have the updater, so this one is a manual download.

**Exodus.** The Exodus desktop and phone apps don’t let other apps connect to
them, so Goldfelty tracks an Exodus address instead: Connect a wallet > Can’t
connect > Exodus. “Another wallet” does the same for any address, on any of the
chains above.

Also: `SHA256SUMS.txt` lists files under the names GitHub serves them as, so
`shasum -c` checks the macOS and Windows downloads too.

See the [security review](https://github.com/gceoale/goldfelty-portfolio-manager/blob/main/docs/SECURITY-AUDIT.md).

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
Check a download against `SHA256SUMS.txt`, or with `gh attestation verify` as above:

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
