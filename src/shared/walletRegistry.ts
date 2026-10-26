import type { ChainFamily } from './types.ts'

/**
 * Wallets Goldfelty connects to without any third-party service.
 *
 * Every entry here is a browser-extension wallet. EVM wallets speak EIP-1193
 * and announce themselves through EIP-6963; Solana wallets register through
 * the Wallet Standard; Bitcoin and Tron wallets are found by the objects
 * they inject. The bridge page keys those with a family prefix (`sol:`,
 * `btc:`, `tron:`), and a wallet that does several chains is connected for
 * all of them at once. The registry does not gate anything: a wallet missing from this list
 * still connects if it announces itself, and shows up under its own name and
 * icon. What the registry adds is a name and colour for wallets that are not
 * installed yet, and a homepage to install them from.
 *
 * Matching tries `rdns` first, then the announced name. The rdns values are
 * the ones the wallets publish; if one is ever wrong or changes, detection
 * falls back to the name rather than failing.
 *
 * Icons for detected wallets come from the wallet itself at runtime. Nothing
 * here is fetched from anywhere.
 */

export interface RegistryWallet {
  id: string
  name: string
  rdns: string[]
  /** Lower-case names the wallet has been seen announcing itself as. */
  aliases: string[]
  /** Brand colour, used for the monogram until the real icon is known. */
  color: string
  homepage: string
  /** Chain families it connects for. Absent means EVM only. */
  families?: ChainFamily[]
}

export const FRAME_ID = 'frame-desktop'

/**
 * Wallet apps that don't let other apps connect to them at all, so nothing
 * can ask them to sign. Goldfelty can still track their addresses, read-only:
 * balances show in the portfolio, and sending happens in the wallet itself.
 *
 * Exodus ended WalletConnect support and its dApp browser in 2026, and its
 * desktop app has never had a way for other apps to connect.
 */
export interface TrackOnlyWallet {
  id: string
  name: string
  color: string
  /** Why it can't connect, shown in the connect sheet. */
  why: string
}

export const TRACK_ONLY_WALLETS: TrackOnlyWallet[] = [
  { id: 'exodus-desktop', name: 'Exodus', color: '#1f2033', why: 'Exodus doesn’t let other apps connect to it, on any computer or phone.' }
]

export const TRACK_ONLY_BY_ID = new Map(TRACK_ONLY_WALLETS.map((w) => [w.id, w]))

export const WALLET_REGISTRY: RegistryWallet[] = [
  { id: 'metamask', name: 'MetaMask', rdns: ['io.metamask', 'io.metamask.flask', 'sol:metamask'], aliases: ['metamask', 'metamask flask'], color: '#f6851b', homepage: 'https://metamask.io', families: ['evm', 'solana'] },
  { id: 'rabby', name: 'Rabby', rdns: ['io.rabby'], aliases: ['rabby', 'rabby wallet'], color: '#7084ff', homepage: 'https://rabby.io' },
  { id: 'coinbase', name: 'Coinbase Wallet', rdns: ['com.coinbase.wallet', 'sol:coinbase-wallet'], aliases: ['coinbase wallet', 'coinbase'], color: '#0052ff', homepage: 'https://www.coinbase.com/wallet' },
  { id: 'phantom', name: 'Phantom', rdns: ['app.phantom', 'sol:phantom'], aliases: ['phantom'], color: '#ab9ff2', homepage: 'https://phantom.com', families: ['evm', 'solana'] },
  { id: 'brave', name: 'Brave Wallet', rdns: ['com.brave.wallet'], aliases: ['brave wallet', 'brave'], color: '#fb542b', homepage: 'https://brave.com/wallet' },
  { id: 'trust', name: 'Trust Wallet', rdns: ['com.trustwallet.app', 'sol:trust', 'sol:trust-wallet', 'tron:trust', 'tron:trust-wallet'], aliases: ['trust wallet', 'trust'], color: '#0500ff', homepage: 'https://trustwallet.com', families: ['evm', 'solana', 'tron'] },
  { id: 'okx', name: 'OKX Wallet', rdns: ['com.okex.wallet', 'sol:okx-wallet', 'btc:okx', 'tron:okx'], aliases: ['okx wallet', 'okx'], color: '#121212', homepage: 'https://www.okx.com/web3', families: ['evm', 'solana', 'utxo', 'tron'] },
  { id: 'rainbow', name: 'Rainbow', rdns: ['me.rainbow'], aliases: ['rainbow'], color: '#001e59', homepage: 'https://rainbow.me' },
  { id: 'zerion', name: 'Zerion', rdns: ['io.zerion.wallet', 'sol:zerion'], aliases: ['zerion'], color: '#2962ef', homepage: 'https://zerion.io', families: ['evm', 'solana'] },
  { id: 'frame-extension', name: 'Frame Companion', rdns: ['sh.frame'], aliases: ['frame', 'frame companion'], color: '#1c1b24', homepage: 'https://frame.sh' },
  { id: 'taho', name: 'Taho', rdns: ['xyz.taho', 'xyz.taho.wallet'], aliases: ['taho'], color: '#d08e39', homepage: 'https://taho.xyz' },
  { id: 'enkrypt', name: 'Enkrypt', rdns: ['com.enkrypt', 'sol:enkrypt'], aliases: ['enkrypt'], color: '#704fea', homepage: 'https://www.enkrypt.com', families: ['evm', 'solana'] },
  { id: 'exodus', name: 'Exodus Web3 Wallet', rdns: ['com.exodus.web3-wallet'], aliases: ['exodus', 'exodus web3 wallet'], color: '#1f2033', homepage: 'https://www.exodus.com' },
  { id: 'backpack', name: 'Backpack', rdns: ['app.backpack', 'sol:backpack', 'btc:backpack', 'tron:backpack'], aliases: ['backpack'], color: '#e33e3f', homepage: 'https://backpack.app', families: ['evm', 'solana', 'utxo', 'tron'] },
  { id: 'bitget', name: 'Bitget Wallet', rdns: ['com.bitget.web3', 'sol:bitget-wallet', 'btc:bitget', 'tron:bitget'], aliases: ['bitget wallet', 'bitkeep'], color: '#00f0ff', homepage: 'https://web3.bitget.com', families: ['evm', 'solana', 'utxo', 'tron'] },
  { id: 'uniswap', name: 'Uniswap Extension', rdns: ['org.uniswap.app'], aliases: ['uniswap extension', 'uniswap wallet', 'uniswap'], color: '#ff37c7', homepage: 'https://wallet.uniswap.org' },
  { id: 'core', name: 'Core', rdns: ['app.core.extension', 'sol:core'], aliases: ['core', 'core wallet'], color: '#e84142', homepage: 'https://core.app', families: ['evm', 'solana'] },
  { id: 'talisman', name: 'Talisman', rdns: ['xyz.talisman', 'sol:talisman'], aliases: ['talisman'], color: '#d5ff5c', homepage: 'https://talisman.xyz', families: ['evm', 'solana'] },
  { id: 'subwallet', name: 'SubWallet', rdns: ['app.subwallet'], aliases: ['subwallet'], color: '#004bff', homepage: 'https://www.subwallet.app' },
  { id: 'ronin', name: 'Ronin Wallet', rdns: ['com.roninchain.wallet', 'sol:ronin-wallet'], aliases: ['ronin wallet', 'ronin'], color: '#1273ea', homepage: 'https://wallet.roninchain.com', families: ['evm', 'solana'] },
  { id: 'tokenpocket', name: 'TokenPocket', rdns: ['pro.tokenpocket', 'https://www.tokenpocket.pro/en/download/app', 'sol:tokenpocket', 'btc:tokenpocket'], aliases: ['tokenpocket'], color: '#2980fe', homepage: 'https://www.tokenpocket.pro', families: ['evm', 'solana', 'utxo'] },
  { id: 'coin98', name: 'Coin98', rdns: ['coin98.com', 'sol:coin98'], aliases: ['coin98', 'coin98 wallet'], color: '#d9b432', homepage: 'https://coin98.com', families: ['evm', 'solana'] },
  { id: 'safepal', name: 'SafePal', rdns: ['app.safepal', 'https://www.safepal.com/download', 'sol:safepal', 'tron:safepal'], aliases: ['safepal'], color: '#4a21ef', homepage: 'https://www.safepal.com', families: ['evm', 'solana', 'tron'] },
  { id: 'ctrl', name: 'Ctrl', rdns: ['io.xdefi', 'sol:ctrl-wallet', 'tron:ctrl-wallet', 'tron:ctrl'], aliases: ['ctrl', 'ctrl wallet', 'xdefi'], color: '#3e72f6', homepage: 'https://ctrl.xyz', families: ['evm', 'solana', 'tron'] },
  { id: 'onekey', name: 'OneKey', rdns: ['so.onekey.app.wallet', 'sol:onekey', 'btc:onekey', 'tron:onekey'], aliases: ['onekey'], color: '#44d62c', homepage: 'https://onekey.so', families: ['evm', 'solana', 'utxo', 'tron'] },
  { id: 'magiceden', name: 'Magic Eden', rdns: ['io.magiceden.wallet', 'sol:magic-eden'], aliases: ['magic eden', 'magic eden wallet'], color: '#e42575', homepage: 'https://wallet.magiceden.io', families: ['evm', 'solana'] },
  { id: 'wigwam', name: 'Wigwam', rdns: ['com.wigwam.wallet'], aliases: ['wigwam'], color: '#80ef6e', homepage: 'https://wigwam.app' },
  { id: 'fordefi', name: 'Fordefi', rdns: ['com.fordefi', 'sol:fordefi', 'tron:fordefi'], aliases: ['fordefi'], color: '#7994ff', homepage: 'https://www.fordefi.com', families: ['evm', 'solana', 'tron'] },
  { id: 'ambire', name: 'Ambire', rdns: ['com.ambire', 'com.ambire.wallet'], aliases: ['ambire', 'ambire wallet'], color: '#6000ff', homepage: 'https://www.ambire.com' },
  { id: 'gate', name: 'Gate Wallet', rdns: ['io.gate.wallet', 'sol:gate-wallet', 'tron:gate-wallet'], aliases: ['gate wallet', 'gate'], color: '#2354e6', homepage: 'https://www.gate.io/web3', families: ['evm', 'solana', 'tron'] },
  { id: 'opera', name: 'Opera Wallet', rdns: ['com.opera.wallet'], aliases: ['opera wallet', 'opera crypto wallet'], color: '#ff1b2d', homepage: 'https://www.opera.com/crypto' },
  { id: 'solflare', name: 'Solflare', rdns: ['sol:solflare'], aliases: ['solflare'], color: '#fc7227', homepage: 'https://solflare.com', families: ['solana'] },
  { id: 'unisat', name: 'UniSat', rdns: ['btc:unisat'], aliases: ['unisat', 'unisat wallet'], color: '#ff7a00', homepage: 'https://unisat.io', families: ['utxo'] },
  { id: 'xverse', name: 'Xverse', rdns: ['btc:xverse'], aliases: ['xverse', 'xverse wallet'], color: '#ee7a30', homepage: 'https://www.xverse.app', families: ['utxo'] },
  { id: 'leather', name: 'Leather', rdns: ['btc:leather'], aliases: ['leather'], color: '#12100f', homepage: 'https://leather.io', families: ['utxo'] },
  { id: 'tronlink', name: 'TronLink', rdns: ['tron:tronlink', 'org.tronlink.www'], aliases: ['tronlink'], color: '#ff060a', homepage: 'https://www.tronlink.org', families: ['evm', 'tron'] },
  { id: 'cryptocom', name: 'Crypto.com Onchain', rdns: ['com.crypto.wallet', 'sol:crypto-com-onchain'], aliases: ['crypto.com onchain', 'crypto.com defi wallet', 'crypto.com'], color: '#103f68', homepage: 'https://crypto.com/onchain', families: ['evm', 'solana'] }
]

export const REGISTRY_BY_ID = new Map(WALLET_REGISTRY.map((w) => [w.id, w]))

/** The registry entry for an announced wallet, by rdns then by name. */
export function matchRegistry(rdns: string, name: string): RegistryWallet | null {
  const r = rdns.toLowerCase()
  const byRdns = WALLET_REGISTRY.find((w) => w.rdns.some((x) => x.toLowerCase() === r))
  if (byRdns) return byRdns
  const n = name.trim().toLowerCase()
  return WALLET_REGISTRY.find((w) => w.aliases.includes(n) || w.name.toLowerCase() === n) ?? null
}

/** A stable id for an announced wallet: the registry id when known, else its rdns. */
export function providerIdFor(rdns: string, name: string): string {
  return matchRegistry(rdns, name)?.id ?? (rdns || name.trim().toLowerCase().replace(/\s+/g, '-'))
}

/** A letter or two for a wallet that has no icon yet. */
export function monogram(name: string): string {
  const words = name.replace(/\b(wallet|extension)\b/gi, '').trim().split(/\s+/).filter(Boolean)
  if (words.length >= 2) return (words[0][0] + words[1][0]).toUpperCase()
  return (words[0] ?? name).charAt(0).toUpperCase()
}
