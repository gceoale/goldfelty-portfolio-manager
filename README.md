# Goldfelty Portfolio Manager

A desktop app for the wallets you already use. Connect MetaMask, Rainbow,
Phantom or Coinbase, see them together, and send across seven networks without
juggling tabs. macOS, Windows and Linux, on both ARM and Intel.

> Not audited, not signed. Use an amount you wouldn't mind losing.

## The four tabs

**Home** shows what everything is worth, how it's moved over 24h through
all-time, where it's allocated, and which wallet holds what. Pick an asset and
it breaks down by wallet and chain.

**Send** asks for an asset, then a route. If three wallets hold USDC it lists
all three with their balances and networks and waits for you to choose, rather
than picking one for you. Then it quotes gas and flags anything odd — sending
to a token contract, a signer too low on gas, a first use that needs a
deployment.

**Receive** works the same way in reverse. Choose the asset, choose which
wallet takes it, and only then does an address appear. Handing out the right
address on the wrong network is an easy way to lose money, so the warning names
the network.

**Settings** is where wallets get connected, networks get toggled, RPC
endpoints get overridden, and the password gets changed.

The tab rail is down the left. `⌘1`–`⌘4` or `Ctrl+1`–`4`.

## Connecting a wallet

Three ways, because no one way reaches everything:

**WalletConnect** covers wallet apps — on your phone by QR, or on this machine
by deep link. Several hundred of them.

**A browser bridge** covers extensions. Extensions live inside the browser and
a desktop app can't reach them, so Goldfelty serves a page on `127.0.0.1`
behind a single-use token and opens it in your browser. That tab *is* the
connection; close it and signing stops.

**Or make new ones.** Smart-contract accounts derived from one recovery phrase,
for people who don't already have a wallet.

Connected wallets are used as they are — your address, your balance, nothing to
deploy. Goldfelty holds no key for them, so sends are approved in the wallet
app rather than behind a password here.

## Wallets it creates itself

These are [ERC-1167 clones](contracts/GoldfeltyAccount.sol) of an
owner-controlled account, deployed by a CREATE2 factory. The address is a pure
function of `(factory, owner, salt)`, which buys two useful things: the same
address on every chain, and an address you can receive at before the contract
exists. It gets deployed the first time you send from it.

Owner keys come from `m/44'/60'/0'/0/i`, so one 24-word backup covers all of
them.

## Security

Your password is stretched with scrypt (N=2¹⁷) into a key that encrypts the
vault with AES-256-GCM. Neither it nor the phrase leaves the machine.

The decrypted seed stays in the main process. The renderer only ever sees
addresses and balances, and the preload bridge exposes named verbs — there's no
generic `invoke(channel, …)` to abuse.

The recovery phrase is shown once, during setup, behind a ticket that's
destroyed when you confirm the backup. There's deliberately no way to show it
again: a wallet that reveals its seed on demand is one screen-share from empty.

The vault locks on idle, on quit, and if the renderer crashes. The renderer
runs sandboxed with context isolation, a strict CSP, navigation blocked and
every web permission denied. All network traffic goes through the main process.

## Working on it

```sh
npm install
npm run dev        # hot reload
npm run typecheck
npm test           # 72 tests
npm run build
npm run smoke      # drives the real app end to end, screenshots each step
```

Tests run on Node's own TypeScript stripping — no build step, no framework.
`npm run smoke` is the one that catches things the compiler can't; it found a
runtime-only import bug that typechecked fine.

On a headless box: `xvfb-run -a npm run smoke`.

## Installing on macOS

Unsigned builds get quarantined, and macOS reports that as *"damaged and can't
be opened"*. It isn't damaged. After moving it to Applications:

```sh
xattr -dr com.apple.quarantine "/Applications/Goldfelty Portfolio Manager.app"
```

Builds are ad-hoc signed (`scripts/afterPack.cjs`) so the bundle is internally
consistent and runs on Apple silicon once quarantine is cleared. Getting rid of
that step needs a Developer ID and notarisation: set `CSC_LINK`,
`CSC_KEY_PASSWORD` and the `APPLE_*` secrets and the workflow handles both.

## Building installers

```sh
npm run dist:mac     # dmg + zip, arm64 and x64
npm run dist:win     # installer + portable, x64 and arm64
npm run dist:linux   # AppImage, deb, rpm, tar.gz, x64 and arm64
```

Each platform builds on its own OS. `.github/workflows/release.yml` does all
three and attaches everything to a release — push a `v*` tag, or run it
manually with a version.

## WalletConnect

A project ID identifies the app, not the user. One ships with the build, so
nobody installing this has to think about it. Override it with
`MAIN_VITE_WALLETCONNECT_PROJECT_ID` at build time, or with a
`WALLETCONNECT_PROJECT_ID` repository variable, which is how you'd rotate it.

## Layout

```
contracts/    the account contract, its factory, how to deploy them
src/main/     vault, store, RPC, prices, portfolio, transfers, connections
src/preload/  the named-verb bridge — the renderer's entire API
src/renderer/ React UI
src/shared/   types, chains, tokens, deep-link parsing
api/          account registration for api.goldfelty.com
site/         goldfelty.com
docs/DNS.md   domain, API and email setup
tests/        72 tests over the main-process logic
```

## Before real money

Deploy your own contracts ([contracts/DEPLOYMENT.md](contracts/DEPLOYMENT.md))
and point `GOLDFELTY_FACTORY` and `GOLDFELTY_IMPLEMENTATION` at them, or check
that the defaults match a deployment you trust. Until the factory exists on a
chain, receiving works but a first send reverts.

This only affects wallets Goldfelty creates. Connected wallets are ordinary
accounts and send immediately.

## Licence

Apache-2.0.
