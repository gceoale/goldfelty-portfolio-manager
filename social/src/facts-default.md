# Goldfelty: facts for posts

Everything a post says about Goldfelty has to come from this file. Edit it when
something changes (a new release, a new wallet, a new feature), and the next
batch of drafts will use it.

## What it is

- Goldfelty Portfolio Manager is a free desktop app that shows the crypto
  wallets you already use in one place: what you hold across all of them, what
  it's worth, and how that changes over a day, week, month, year or all time.
- You can send and receive from one screen.
- macOS, Windows and Linux, on ARM and Intel. Download: https://goldfelty.com
- The code is open source (Apache-2.0):
  https://github.com/gceoale/goldfelty-portfolio-manager
- Current version: 1.2.3. It updates itself from 1.2.0 on.

## Wallets

- Connects to browser extension wallets through its own connection, without
  WalletConnect: MetaMask, Rabby, Coinbase Wallet, Phantom, Brave Wallet, Trust
  Wallet, OKX Wallet, Rainbow, Zerion, Frame, Taho, Enkrypt, Backpack, Bitget
  Wallet, Uniswap Extension, Core, Talisman, SubWallet, TokenPocket, Coin98,
  SafePal, Ctrl, OneKey, Magic Eden, Wigwam, Fordefi, Ambire, Gate Wallet, Opera
  Wallet, Crypto.com Onchain and more. Any extension that announces itself with
  EIP-6963 shows up.
- Each supported extension is tested against its real, current version every
  week.
- Bitcoin wallets (UniSat, Xverse, Leather, OKX, Bitget, OneKey), Solana Wallet
  Standard wallets (Phantom, Solflare, Backpack and more) and Tron wallets
  (TronLink, OKX, Bitget). A wallet that covers several chains connects for all
  of them at once.
- Frame desktop wallet, and through it Ledger, Trezor and GridPlus.
- Phone wallets over WalletConnect.
- Wallets that can't connect to other apps (for example Exodus desktop and
  mobile) can be tracked read-only by address.

## Networks

- Send and receive: Ethereum, Base, Arbitrum, Optimism, Polygon, BNB Chain,
  Avalanche, Bitcoin, Solana, Tron.
- Track balances only: Litecoin, Dogecoin, XRP Ledger.

## Safety

- Goldfelty never creates wallets and never holds keys or seed phrases. Your
  wallet approves every transfer and signature.
- On Bitcoin, Solana and Tron, Goldfelty checks that the signed transaction
  the wallet returns is exactly what was asked for before broadcasting it.
- Before a send: switches your wallet to the right network, warns about
  lookalike addresses, and shows the network fee and Goldfelty's fee.
- Data about your wallets stays on your computer, encrypted (AES-256-GCM) under
  your password. It locks after idle time, on sleep and when the screen locks.
- Nothing goes to goldfelty.com unless you create an account or switch on
  sharing your portfolio total (off by default).
- Each release ships with SHA-256 checksums and a build provenance attestation
  that ties every file to the commit it was built from.

## Price

- Free to download, view, track and receive. No ads, no subscription.
- A fixed 0.5% fee applies only to tokens you send through Goldfelty. It's shown
  before you send and your wallet asks you to approve it.

## Things posts must not claim

- It has not been independently audited. Never say it has.
- Builds aren't yet signed by Apple or Microsoft, so macOS and Windows show a
  warning on first open. Don't claim otherwise.
- No user numbers, ratings, reviews or testimonials. Don't invent any.
- No price predictions, returns or investment advice.
