# Goldfelty Portfolio Manager

A desktop wallet and portfolio manager for EVM smart-contract accounts. Connect
up to 256 wallets, watch them in one place, and send or receive on any of them —
on macOS, Windows and Linux, on both ARM64 and x64.

> **Not audited.** Neither this application nor the contracts in `contracts/`
> have been through an independent security review. Use amounts you would not
> mind losing until they have.

## What it does

**Home** — total value across every connected wallet, growth or loss over 24h /
7d / 30d / 1y / all-time, allocation by asset, a per-wallet breakdown, and the
recent transfer log. Selecting an asset shows exactly which wallet and chain
each unit of it sits on.

**Send** — pick an asset, then pick the route. When several wallets hold the
same token, Goldfelty does not choose for you: it lists every wallet-and-chain
pair that can cover the amount, with its balance, its network and whether the
account still needs deploying, and waits for you to say which one pays. It then
quotes the gas, warns about anything odd (self-sends, a token contract as the
recipient, an owner key too low on gas), and asks for your password.

**Receive** — pick an asset, then pick which wallet receives it. Same rule: if
more than one wallet can take the token, you choose before the address is
copyable. You get a QR code, the address, and a warning naming the exact network
that address is safe on.

**Settings** — connect wallets, watch external addresses, rename and archive,
choose networks and custom RPC endpoints, set theme, currency, auto-lock and
refresh interval, change your password, and manage your goldfelty.com account.

The tab switcher sits in a rail down the left-hand side. `⌘1`–`⌘4` / `Ctrl+1`–`4`
move between tabs.

## Wallets are smart contracts

Each wallet is a clone of [`GoldfeltyAccount`](contracts/GoldfeltyAccount.sol) —
an owner-controlled contract account — deployed by a CREATE2 factory. That buys
three things a bare key does not:

- **One address everywhere.** The factory and implementation live at the same
  address on every supported chain, so a wallet's address is identical on
  Ethereum, Base, Arbitrum, OP, Polygon, BNB and Avalanche.
- **An address before deployment.** The address is a pure function of
  `(factory, owner, salt)`, so you can receive at a wallet that does not exist on
  chain yet. It is deployed the first time you send from it.
- **Batched calls.** `executeBatch` lets deploy-and-send, or approve-and-swap,
  land in a single transaction.

The owner key for wallet *i* is derived from your recovery phrase at
`m/44'/60'/0'/0/i`, so one 24-word backup restores all of them.

## Security model

- Your password is stretched with **scrypt** (N=2¹⁷, r=8, p=1) into a 256-bit
  key, which encrypts the vault with **AES-256-GCM**. Neither the password nor
  the phrase is ever sent anywhere.
- The decrypted seed lives **only in the main process**. The renderer receives
  addresses and balances — never key material. There is no generic
  `invoke(channel, …)` in the preload bridge, only named verbs.
- The recovery phrase is shown **exactly once**, during onboarding, behind a
  one-time ticket that is destroyed when you confirm the backup. There is no
  "show me again" anywhere in the app, by design.
- The vault auto-locks after inactivity, on quit, and if the renderer crashes.
  Every transfer re-checks your password rather than trusting an unlocked window.
- The renderer runs sandboxed with context isolation, a strict CSP, no node
  integration, navigation blocked, and every web permission denied. All network
  traffic goes through the main process.

## Development

```bash
npm install
npm run dev        # hot-reloading Electron app
npm run typecheck  # main, preload and renderer
npm test           # 52 tests over crypto, vault, accounts, routing, portfolio
npm run build      # production bundles into out/
npm run smoke      # drives the real app through onboarding, screenshots each tab
npm run icons      # regenerate resources/icon.png and the Linux icon set
```

`npm run smoke` launches the built app and walks the whole onboarding flow —
password, account, one-time key reveal, username, wallet connection — then
visits every tab and screenshots each step into `release/smoke/`. On a headless
machine, run it as `xvfb-run -a npm run smoke`.

Tests run on Node's native TypeScript stripping — no build step, no test
framework dependency.

## Installing on macOS

These builds are unsigned, so macOS quarantine will report the app as
"damaged and can't be opened". It is not damaged — Gatekeeper rejects
unsigned downloads outright instead of offering an "open anyway" prompt.
Clear the quarantine flag once, after moving the app to Applications:

```bash
xattr -dr com.apple.quarantine "/Applications/Goldfelty Portfolio Manager.app"
```

Builds are ad-hoc signed (`scripts/afterPack.cjs`) so the bundle is
internally consistent and runs on Apple silicon once quarantine is cleared.
Making Gatekeeper trust the download without that step needs a real Developer
ID certificate and notarisation — set `CSC_LINK`, `CSC_KEY_PASSWORD` and the
`APPLE_*` secrets and the release workflow signs and notarises automatically.

## Building installers

```bash
npm run dist:mac    # dmg + zip, arm64 and x64
npm run dist:win    # nsis + portable, x64 and arm64
npm run dist:linux  # AppImage, deb, rpm, tar.gz, x64 and arm64
```

Each platform must be built on its own OS. `.github/workflows/release.yml` does
all three on tag push and attaches the artifacts to a draft release. Code
signing is opt-in: set `CSC_LINK`, `CSC_KEY_PASSWORD` and the `APPLE_*` secrets
to sign and notarise, or leave them unset for unsigned builds.

| Platform | Architectures | Formats |
| --- | --- | --- |
| macOS 11+ | arm64, x64 | `.dmg`, `.zip` |
| Windows 10+ | x64, arm64 | NSIS installer, portable `.exe` |
| Linux | x64, arm64 | AppImage, `.deb`, `.rpm`, `.tar.gz` |

## Layout

```
contracts/          GoldfeltyAccount + factory, and how to deploy them
src/main/           Vault, store, RPC, prices, portfolio, transfers, IPC
src/preload/        The named-verb bridge — the renderer's whole API surface
src/renderer/       React UI: sidebar shell, four tabs, onboarding
src/shared/         Types, chain registry and token registry
tests/              Node test-runner suites over the main-process logic
```

## Before real money

Deploy your own contracts (see [`contracts/DEPLOYMENT.md`](contracts/DEPLOYMENT.md))
and point `GOLDFELTY_FACTORY` / `GOLDFELTY_IMPLEMENTATION` at them, or verify
that the defaults match a deployment you trust. Until the factory exists on a
chain, receiving works but the first send on that chain will revert.

## Licence

Apache-2.0. See [LICENSE](LICENSE).
