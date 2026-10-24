# Goldfelty Portfolio Manager

A desktop app that shows the crypto wallets you already use in one place: what
you hold across all of them, what it's worth, and how that changes. Send and
receive from one screen. macOS, Windows and Linux, on ARM and Intel.

Goldfelty doesn't create wallets and never holds keys. Your wallets approve
every transfer and signature.

> Not independently audited, and builds aren't signed by Apple or Microsoft
> yet. See [docs/SECURITY-AUDIT.md](docs/SECURITY-AUDIT.md).

## Wallets

**Browser extensions**, through Goldfelty's own connection: MetaMask, Rabby,
Coinbase Wallet, Phantom, Brave Wallet, Trust Wallet, OKX Wallet, Rainbow,
Zerion, Frame Companion, Taho, Enkrypt, Exodus, Backpack, Bitget Wallet,
Uniswap Extension, Core, Talisman, SubWallet, Ronin Wallet, TokenPocket,
Coin98, SafePal, Ctrl, OneKey, Magic Eden, Wigwam, Fordefi, Zeal, Ambire, Gate
Wallet, Opera Wallet and Crypto.com Onchain. Any other extension that announces
itself with EIP-6963 shows up too.

**Frame**, the desktop wallet, over its local socket. Ledger, Trezor and
GridPlus work through it.

**Phone wallets**, over WalletConnect. This is the only connection that uses an
outside relay, because a phone can't reach your computer directly.

Networks: Ethereum, Base, Arbitrum, Optimism, Polygon, BNB Chain and Avalanche,
plus Sepolia for testing.

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

Goldfelty takes a fee on tokens sent through it: 0.5% for now, paid on top of
the amount sent, as a separate transaction your wallet asks you to approve. The
owner of goldfelty.com can set it from 0% to 10% by editing
[`site/fees.json`](site/fees.json); the app clamps whatever it reads to that
range and never charges more than the rate shown on the review screen.

The fee goes to the address in the `GOLDFELTY_FEE_ADDRESS` repository variable,
which is compiled into each build. It's deliberately not read at runtime, so a
compromised website can't redirect fees. With no address set, builds charge no
fee.

## Setting up the services

| What | Where | Needed for |
|---|---|---|
| `GOLDFELTY_FEE_ADDRESS` | Repository variable | The send fee. Your Exodus Ethereum address. |
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

`npm run e2e` launches the real app with a fake EIP-6963 wallet in a separate
Chromium page, the real account API code on a local port, and mock RPC and price
servers. It walks setup, connecting, sign-up, sending with the fee, every page,
dark mode and locking, and fails on any console error or CSP violation.
Screenshots land in `release/e2e/`.

## Installing on macOS

Unsigned builds get quarantined, which macOS reports as *"damaged and can't be
opened"*. After moving the app to Applications:

```sh
xattr -dr com.apple.quarantine "/Applications/Goldfelty Portfolio Manager.app"
```

Each release lists SHA-256 checksums in `SHA256SUMS.txt`.

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
docs/                 DNS setup and the security audit
tests/                unit tests; scripts/e2e.cjs for the whole app
```

## Licence

Apache-2.0.
