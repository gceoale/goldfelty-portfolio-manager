# Wallet compatibility

Every wallet in the registry (`src/shared/walletRegistry.ts`) is checked against
its real browser extension by `scripts/wallet-probe.mjs`. The probe downloads each
extension from the Chrome Web Store, loads it into Chromium, opens Goldfelty's
bridge page, and records what the wallet announces, whether Goldfelty files it
under the right wallet and chains, and whether a connect request reaches it.

It runs in GitHub Actions (**Wallet connection probe**): weekly, by hand, and on
any change to the bridge or the registry. The run summary has the full table.

The extensions are fresh installs with no account, so a connect request is
expected to open the wallet's window or answer "not set up yet". Either means
the request reached the wallet, which is what Goldfelty controls. Approving it
and signing are up to the wallet.

## Results, 26 October 2026

| Wallet | Version | Chains Goldfelty connects | Result |
| --- | --- | --- | --- |
| MetaMask | 13.53.0 | Ethereum, Solana | Works |
| Rabby | 0.94.13 | Ethereum | Works |
| Coinbase Wallet | 3.150.0 | Ethereum | Works (needed the CSP change below) |
| Phantom | 26.34.0 | Ethereum, Solana | Works |
| Trust Wallet | 26.42.4 | Ethereum, Solana, Tron | Works |
| OKX Wallet | 4.21.0 | Ethereum, Solana, Bitcoin, Tron | Works |
| Rainbow | 1.6.13 | Ethereum | Works |
| Zerion | 1.45.2 | Ethereum, Solana | Works (needed localhost, below) |
| Frame Companion | 0.12.1 | Ethereum | Works with the Frame desktop app running |
| Taho | 0.67.1 | Ethereum | Works (needed localhost) |
| Enkrypt | 2.19.0 | Ethereum, Solana | Works |
| Backpack | 0.10.218 | Ethereum, Solana, Bitcoin, Tron | Works |
| Bitget Wallet | 2.21.11 | Ethereum, Solana, Bitcoin, Tron | Works; slow to start, see below |
| Uniswap Extension | 1.85.0.1 | Ethereum | Works |
| Core | 1.137.2 | Ethereum, Solana | Works |
| Talisman | 3.12.0 | Ethereum, Solana | Works |
| SubWallet | 1.3.90 | Ethereum | Works |
| TokenPocket | 2.20.1 | Ethereum, Solana, Bitcoin | Works |
| Coin98 | 10.8.2 | Ethereum, Solana | Works |
| SafePal | 2.41.2 | Ethereum, Solana, Tron | Works |
| Ctrl | 37.0.2 | Ethereum, Solana, Tron | Works; slow to start, see below |
| OneKey | 6.6.3 | Ethereum, Bitcoin | Works. Solana and Tron didn't answer on a fresh install |
| Magic Eden | 3.3.1 | Ethereum, Solana | Works |
| Wigwam | 2.11.3 | Ethereum | Works |
| Fordefi | 2026.10.21.3 | Ethereum, Solana, Tron | Works |
| Ambire | 6.23.3 | Ethereum | Works |
| Gate Wallet | 3.24.1 | Ethereum, Solana, Tron | Works (needed localhost) |
| Solflare | 2.41.0 | Solana | Works |
| UniSat | 1.8.0 | Bitcoin | Works |
| Xverse | 2.11.1 | Bitcoin | Works |
| Leather | 6.114.0 | Bitcoin | Works |
| TronLink | 4.11.2 | Ethereum, Tron | Works |
| Crypto.com Onchain | 3.10.4 | Ethereum | Works. Solana didn't answer on a fresh install |
| Ronin Wallet | 2.12.0 | – | Found, but didn't answer a connect request on a fresh install |
| Exodus Web3 Wallet | 26.9.21 | – | Injects nothing on a fresh install, on any site |
| Brave Wallet, Opera Wallet | – | – | Built into their browsers; can't be loaded here |

"Didn't answer on a fresh install" means no window and no reply within 12
seconds. That is most likely the wallet waiting to be set up, but it couldn't
be confirmed without an account.

## What the probe found and what changed

- **Three wallets never saw the bridge page.** Zerion,
  Taho and Gate Wallet only inject into `http://localhost` pages, and the page was
  opened at `http://127.0.0.1`. It's now opened at `localhost`.
- **Coinbase Wallet was blocked by the page's CSP.** Its in-page code connects to
  `wss://www.walletlink.org` and adds inline styles. Only scripts are locked to
  the page's own now.
- **Look-alike objects were filed under the wrong wallet.** Many wallets also fill
  in `window.tronLink`, `window.unisat` or `window.BitcoinProvider`. Those
  carrying the injecting wallet's flag (`isOneKey`, `isFordefi`, `isTokenPocket`,
  `isBackpackBitcoinWallet`, `isMagicEden`) now connect under that wallet. An
  unmarked `window.tronLink` with the real TronLink absent goes to the only other
  wallet present, which covers Trust, SafePal, Gate and Backpack.
- **Bitget and Ctrl don't load into tabs opened while they're still starting**,
  right after the browser opens. The page now looks again at 5, 10 and 20 s and
  on focus, the app waits 6 s before calling a wallet missing, and the page
  offers a "Reload this tab" button.
- **Registry corrections**: the rdns values wallets actually announce (Ambire,
  TokenPocket, SafePal, TronLink, Taho), Solana and Tron where wallets offer them,
  no Solana for Coinbase Wallet, and no Zeal, which only injects into `https://`
  pages and so can't reach a page on this computer.

## Known limits

- **Fordefi's and Gate Wallet's `window.unisat` carries no flag**, so their
  Bitcoin side shows up as "UniSat". It still connects.
- **OneKey also registers Solana wallets named "Solflare", "Jupiter" and
  "MetaMask".** With OneKey and the real Solflare both installed, whichever
  registers first is used for "Solflare".
- **Magic Eden's `window.BitcoinProvider` has no `request` method**, so its
  Bitcoin side isn't connected.

## Running it yourself

```sh
npx playwright-core install chromium
xvfb-run -a node scripts/wallet-probe.mjs            # every wallet
xvfb-run -a node scripts/wallet-probe.mjs okx trust  # just these
```

Results land in `release/wallet-probe/`: `summary.md`, `results.json` and a
screenshot of the bridge page per wallet.
