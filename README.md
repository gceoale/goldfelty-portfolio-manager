# Goldfelty Portfolio Manager

A desktop app that shows the crypto wallets you already use in one place: what
you hold across all of them, what it's worth, and how that changes. Send and
receive from one screen. macOS, Windows and Linux, on ARM and Intel.

Goldfelty doesn't create wallets and never holds keys. Your wallets approve
every transfer and signature.

> Not independently audited, and builds aren't signed by Apple or Microsoft
> yet ([how to set that up](docs/CODE-SIGNING.md)). Every release can be
> checked against the build that produced it; see
> [Checking a download](#checking-a-download), and
> [docs/SECURITY-AUDIT.md](docs/SECURITY-AUDIT.md).

## Wallets

**Browser extensions**, through Goldfelty's own connection: MetaMask, Rabby,
Coinbase Wallet, Phantom, Brave Wallet, Trust Wallet, OKX Wallet, Rainbow,
Zerion, Frame Companion, Taho, Enkrypt, Exodus Web3 Wallet, Backpack, Bitget Wallet,
Uniswap Extension, Core, Talisman, SubWallet, Ronin Wallet, TokenPocket,
Coin98, SafePal, Ctrl, OneKey, Magic Eden, Wigwam, Fordefi, Zeal, Ambire, Gate
Wallet, Opera Wallet and Crypto.com Onchain. Any other extension that announces
itself with EIP-6963 shows up too.

**Bitcoin, Solana and Tron wallets** in the browser: UniSat, Xverse, Leather,
OKX, Bitget and OneKey for Bitcoin; any wallet that supports the Solana Wallet
Standard (Phantom, Solflare, Backpack, MetaMask and more) for Solana; TronLink,
OKX and Bitget for Tron. A wallet that does several chains is connected for all
of them at once.

**Frame**, the desktop wallet, over its local socket. Ledger, Trezor and
GridPlus work through it.

**Phone wallets**, over WalletConnect. This is the only connection that uses an
outside relay, because a phone can't reach your computer directly.

**Wallets that can't connect**, such as the Exodus desktop and phone apps
(Exodus ended WalletConnect and its dApp browser in 2026): Goldfelty tracks
their addresses read-only, so the balances count, and you send from the
wallet itself.

Networks: send and receive on Ethereum, Base, Arbitrum, Optimism, Polygon, BNB
Chain, Avalanche, Bitcoin, Solana and Tron (plus Sepolia for testing). Track
balances on Litecoin, Dogecoin and the XRP Ledger as well; no wallet for those
offers a way for other apps to ask it to sign, so you send from the wallet.

On Bitcoin, Solana and Tron, Goldfelty builds the transaction itself, the
wallet signs it, and Goldfelty checks that what came back is exactly what was
asked for (outputs, instructions or decoded contract, and the signer) before
broadcasting it.

## How browser wallets connect

Extensions live inside the browser, out of reach of a desktop app. Goldfelty
serves a small page on `127.0.0.1` and opens it in your browser with a one-time
link. The page finds every wallet installed there (EIP-6963) and passes
requests between the app and the wallet you picked. One tab carries all of
them. It talks to nothing but the app and the wallets in that browser.

The one-time link is swapped for an `HttpOnly` cookie on first use, so nothing
left in your browser history can reconnect. Requests from any other site, or
through DNS rebinding, are refused.

## The app

- **Overview**: total value, change over a day, week, month, year or all time,
  holdings across wallets with a breakdown by wallet and network, recent activity.
- **Send**: pick the asset; if several wallets hold it, you choose which one
  sends. The review shows the network fee and Goldfelty's fee before anything is
  sent. Goldfelty switches your wallet to the right network first, warns about
  lookalike addresses, and afterwards checks the chain recorded what you approved.
- **Receive**: pick the asset, then the wallet and network, and only then is the
  address shown.
- **Activity**, a page per wallet, and **Settings**.

`Cmd/Ctrl+1` to `4` switch pages, `Cmd/Ctrl+L` locks.

## Your data

Goldfelty keeps what it knows about your wallets on your computer, encrypted
(AES-256-GCM) under a random key that your password unwraps through scrypt.
It locks after idle time, on sleep and when your screen locks.

Nothing is sent to goldfelty.com unless you create an account (username, email,
and a wallet signature proving it's you) or turn on **Share my portfolio total**
(your total, its currency and a wallet count; off by default).

## Fee

Goldfelty takes a fixed 0.5% fee on tokens sent through it, paid on top of the
amount sent. On Bitcoin and Solana it's part of the same transaction; elsewhere
it's a second transaction. Either way the wallet asks the user to approve it.
Viewing, tracking and receiving are free.

The rate is a constant in [`src/shared/fees.ts`](src/shared/fees.ts). Nothing is
fetched to decide it, so no server can raise it. Changing it takes a new release,
and the Terms promise that any change is announced there first.
[`site/fees.json`](site/fees.json) stays at 0.5% only for version 1.1, which read
its rate from there.

Fee addresses are compiled into each build from repository variables, and never
read at runtime, so a compromised website can't redirect fees. A chain with no
address set charges no fee.

## Setting up the services

| What | Where | Needed for |
|---|---|---|
| `GOLDFELTY_FEE_ADDRESS` | Repository variable | The send fee on Ethereum-family networks. Your Exodus Ethereum address. |
| `GOLDFELTY_FEE_ADDRESS_BTC`, `_SOL`, `_TRX` | Repository variables | The send fee on Bitcoin, Solana and Tron. Your Exodus address on each. |
| `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID` | Repository secrets | Deploying api.goldfelty.com, so sign-up works. See [api/README.md](api/README.md). |
| `GOLDFELTY_ADMIN_TOKEN` | Repository secret | The owner dashboard at goldfelty.com/admin. Any random string of 32+ characters. |
| `WALLETCONNECT_PROJECT_ID` | Repository variable (optional) | Overrides the project ID that ships with the build. |
| `CSC_LINK`, `CSC_KEY_PASSWORD`, `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD`, `APPLE_TEAM_ID` | Repository secrets (optional) | Signing and notarising the builds. |

## Working on it

```sh
npm install
npm run dev          # hot reload
npm run typecheck
npm test             # main-process tests on Node's own TypeScript stripping
npm run build
xvfb-run -a npm run e2e   # drives the built app with a fake browser wallet
```

`npm run e2e` launches the real app with fake wallets in a separate Chromium
page (an EIP-6963 wallet, a Solana Wallet Standard wallet and a UniSat-style
Bitcoin wallet), the real account API code on a local port, and mock chain and
price servers. It walks setup, connecting, sign-up, sending ETH, SOL and BTC
with the fee, every page, dark mode and locking, and fails on any console error
or CSP violation.
Screenshots land in `release/e2e/`.

## Installing on macOS

Unsigned builds get quarantined, which macOS reports as *"damaged and can't be
opened"*. After moving the app to Applications:

```sh
xattr -dr com.apple.quarantine "/Applications/Goldfelty Portfolio Manager.app"
```

## Checking a download

Each release lists SHA-256 checksums in `SHA256SUMS.txt`:

```sh
shasum -a 256 -c SHA256SUMS.txt --ignore-missing
```

Each file also carries a build provenance attestation, a signed public record
that it was built by this repository's release workflow from a specific
commit. With the [GitHub CLI](https://cli.github.com):

```sh
gh attestation verify <downloaded file> --repo gceoalexyt-ops/goldfelty-portfolio-manager
```

A file changed anywhere after the build fails that check. Downloads come from
GitHub Releases, never from goldfelty.com itself.

## Building installers

```sh
npm run dist:mac     # dmg + zip, arm64 and x64
npm run dist:win     # installer + portable, x64 and arm64
npm run dist:linux   # AppImage, deb, rpm, tar.gz, x64 and arm64
```

`.github/workflows/release.yml` builds all three on their own OS and attaches
them to a release. Run it with a version, or push a `v*` tag.

## Layout

```
src/main/             vault, encrypted store, settings, portfolio, transfers, fees
src/main/connections/ browser bridge, Frame, WalletConnect, and one manager over them
src/preload/          the renderer's whole API, as named verbs
src/renderer/         the UI
src/shared/           types, chains, tokens, the wallet registry, fee rules
api/                  accounts for goldfelty.com: Cloudflare Worker + D1
site/                 goldfelty.com, including /terms, /privacy and /admin
docs/                 DNS setup, code signing and the security audit
tests/                unit tests; scripts/e2e.cjs for the whole app
```

## Licence

Apache-2.0.
