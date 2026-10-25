import type { Chain, ChainFamily, TokenDef } from './types.ts'

type EvmSeed = Omit<Chain, 'family' | 'explorerTx' | 'canSend'>

/** EVM networks. One address works on all of them. */
const EVM_SEEDS: EvmSeed[] = [
  {
    id: 1,
    key: 'ethereum',
    name: 'Ethereum',
    shortName: 'ETH',
    nativeSymbol: 'ETH',
    nativeName: 'Ether',
    decimals: 18,
    rpcUrls: ['https://ethereum-rpc.publicnode.com', 'https://rpc.ankr.com/eth', 'https://cloudflare-eth.com'],
    explorer: 'https://etherscan.io',
    color: '#6b7fd7',
    testnet: false
  },
  {
    id: 8453,
    key: 'base',
    name: 'Base',
    shortName: 'BASE',
    nativeSymbol: 'ETH',
    nativeName: 'Ether',
    decimals: 18,
    rpcUrls: ['https://base-rpc.publicnode.com', 'https://mainnet.base.org'],
    explorer: 'https://basescan.org',
    color: '#0052ff',
    testnet: false
  },
  {
    id: 42161,
    key: 'arbitrum',
    name: 'Arbitrum One',
    shortName: 'ARB',
    nativeSymbol: 'ETH',
    nativeName: 'Ether',
    decimals: 18,
    rpcUrls: ['https://arbitrum-one-rpc.publicnode.com', 'https://arb1.arbitrum.io/rpc'],
    explorer: 'https://arbiscan.io',
    color: '#28a0f0',
    testnet: false
  },
  {
    id: 10,
    key: 'optimism',
    name: 'OP Mainnet',
    shortName: 'OP',
    nativeSymbol: 'ETH',
    nativeName: 'Ether',
    decimals: 18,
    rpcUrls: ['https://optimism-rpc.publicnode.com', 'https://mainnet.optimism.io'],
    explorer: 'https://optimistic.etherscan.io',
    color: '#ff0420',
    testnet: false
  },
  {
    id: 137,
    key: 'polygon',
    name: 'Polygon',
    shortName: 'POL',
    nativeSymbol: 'POL',
    nativeName: 'Polygon Ecosystem Token',
    decimals: 18,
    rpcUrls: ['https://polygon-bor-rpc.publicnode.com', 'https://polygon-rpc.com'],
    explorer: 'https://polygonscan.com',
    color: '#8247e5',
    testnet: false
  },
  {
    id: 56,
    key: 'bnb',
    name: 'BNB Smart Chain',
    shortName: 'BNB',
    nativeSymbol: 'BNB',
    nativeName: 'BNB',
    decimals: 18,
    rpcUrls: ['https://bsc-rpc.publicnode.com', 'https://bsc-dataseed.binance.org'],
    explorer: 'https://bscscan.com',
    color: '#f0b90b',
    testnet: false
  },
  {
    id: 43114,
    key: 'avalanche',
    name: 'Avalanche C-Chain',
    shortName: 'AVAX',
    nativeSymbol: 'AVAX',
    nativeName: 'Avalanche',
    decimals: 18,
    rpcUrls: ['https://avalanche-c-chain-rpc.publicnode.com', 'https://api.avax.network/ext/bc/C/rpc'],
    explorer: 'https://snowtrace.io',
    color: '#e84142',
    testnet: false
  },
  {
    id: 11155111,
    key: 'sepolia',
    name: 'Sepolia',
    shortName: 'SEP',
    nativeSymbol: 'ETH',
    nativeName: 'Sepolia Ether',
    decimals: 18,
    rpcUrls: ['https://ethereum-sepolia-rpc.publicnode.com'],
    explorer: 'https://sepolia.etherscan.io',
    color: '#8b95a5',
    testnet: true
  }
]

/**
 * Chains that aren't EVM. Their ids are negative so they can never collide
 * with an EIP-155 chain id. `rpcUrls` are the APIs balances are read from:
 * Esplora for Bitcoin and Litecoin, Blockchair for Dogecoin, Solana and
 * XRPL JSON-RPC, and TronGrid. Each can be replaced in Settings.
 */
const OTHER_CHAINS: Chain[] = [
  {
    id: -1,
    key: 'bitcoin',
    name: 'Bitcoin',
    shortName: 'BTC',
    family: 'utxo',
    nativeSymbol: 'BTC',
    nativeName: 'Bitcoin',
    decimals: 8,
    rpcUrls: ['https://mempool.space/api', 'https://blockstream.info/api'],
    explorer: 'https://mempool.space',
    explorerTx: 'https://mempool.space/tx/{hash}',
    color: '#f7931a',
    testnet: false,
    canSend: true
  },
  {
    id: -2,
    key: 'litecoin',
    name: 'Litecoin',
    shortName: 'LTC',
    family: 'utxo',
    nativeSymbol: 'LTC',
    nativeName: 'Litecoin',
    decimals: 8,
    rpcUrls: ['https://litecoinspace.org/api'],
    explorer: 'https://litecoinspace.org',
    explorerTx: 'https://litecoinspace.org/tx/{hash}',
    color: '#345d9d',
    testnet: false,
    canSend: false
  },
  {
    id: -3,
    key: 'dogecoin',
    name: 'Dogecoin',
    shortName: 'DOGE',
    family: 'utxo',
    nativeSymbol: 'DOGE',
    nativeName: 'Dogecoin',
    decimals: 8,
    rpcUrls: ['https://api.blockchair.com/dogecoin'],
    explorer: 'https://blockchair.com/dogecoin',
    explorerTx: 'https://blockchair.com/dogecoin/transaction/{hash}',
    color: '#c2a633',
    testnet: false,
    canSend: false
  },
  {
    id: -501,
    key: 'solana',
    name: 'Solana',
    shortName: 'SOL',
    family: 'solana',
    nativeSymbol: 'SOL',
    nativeName: 'Solana',
    decimals: 9,
    rpcUrls: ['https://api.mainnet-beta.solana.com', 'https://solana-rpc.publicnode.com'],
    explorer: 'https://solscan.io',
    explorerTx: 'https://solscan.io/tx/{hash}',
    color: '#9945ff',
    testnet: false,
    canSend: true
  },
  {
    id: -195,
    key: 'tron',
    name: 'Tron',
    shortName: 'TRX',
    family: 'tron',
    nativeSymbol: 'TRX',
    nativeName: 'Tron',
    decimals: 6,
    rpcUrls: ['https://api.trongrid.io'],
    explorer: 'https://tronscan.org',
    explorerTx: 'https://tronscan.org/#/transaction/{hash}',
    color: '#eb0029',
    testnet: false,
    canSend: true
  },
  {
    id: -144,
    key: 'xrp',
    name: 'XRP Ledger',
    shortName: 'XRP',
    family: 'xrp',
    nativeSymbol: 'XRP',
    nativeName: 'XRP',
    decimals: 6,
    rpcUrls: ['https://xrplcluster.com', 'https://s1.ripple.com:51234'],
    explorer: 'https://livenet.xrpl.org',
    explorerTx: 'https://livenet.xrpl.org/transactions/{hash}',
    color: '#23292f',
    testnet: false,
    canSend: false
  }
]

export const CHAINS: Chain[] = [
  ...EVM_SEEDS.map<Chain>((c) => ({ ...c, family: 'evm', explorerTx: `${c.explorer}/tx/{hash}`, canSend: true })),
  ...OTHER_CHAINS
]

/** EVM networks turned on for a new install. Other chains are always on: they cost nothing until a wallet uses them. */
export const DEFAULT_CHAIN_IDS = [1, 8453, 42161, 10, 137]

/** Ids of the chains that aren't EVM, by name. */
export const CHAIN_IDS = { bitcoin: -1, litecoin: -2, dogecoin: -3, solana: -501, tron: -195, xrp: -144 } as const

export const CHAIN_BY_ID = new Map(CHAINS.map((c) => [c.id, c]))

export function getChain(id: number): Chain {
  const chain = CHAIN_BY_ID.get(id)
  if (!chain) throw new Error(`Unknown chain ${id}`)
  return chain
}

export function isEvm(chain: Chain): boolean {
  return chain.family === 'evm'
}

export function chainsOfFamily(family: ChainFamily): Chain[] {
  return CHAINS.filter((c) => c.family === family)
}

/**
 * The chains a wallet of `family` is scanned on: the enabled networks for EVM
 * wallets, and every chain of the family otherwise.
 */
export function chainIdsForFamily(family: ChainFamily, enabledChains: number[]): number[] {
  if (family !== 'evm') return chainsOfFamily(family).map((c) => c.id)
  const enabled = enabledChains.filter((id) => CHAIN_BY_ID.get(id)?.family === 'evm')
  return enabled.length ? enabled : [...DEFAULT_CHAIN_IDS]
}

export function txUrl(chain: Chain, hash: string): string {
  return chain.explorerTx.replace('{hash}', encodeURIComponent(hash))
}

/** Token keys lowercase EVM addresses only; base58 addresses are case-sensitive. */
export function tokenKey(chainId: number, address: string | null): string {
  if (!address) return `${chainId}:native`
  return `${chainId}:${address.startsWith('0x') ? address.toLowerCase() : address}`
}



interface Erc20Seed {
  chainId: number
  address: string
  symbol: string
  name: string
  decimals: number
  priceId: string
  color: string
}

const ERC20_SEEDS: Erc20Seed[] = [
  // Ethereum
  { chainId: 1, address: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48', symbol: 'USDC', name: 'USD Coin', decimals: 6, priceId: 'usd-coin', color: '#2775ca' },
  { chainId: 1, address: '0xdAC17F958D2ee523a2206206994597C13D831ec7', symbol: 'USDT', name: 'Tether USD', decimals: 6, priceId: 'tether', color: '#26a17b' },
  { chainId: 1, address: '0x6B175474E89094C44Da98b954EedeAC495271d0F', symbol: 'DAI', name: 'Dai Stablecoin', decimals: 18, priceId: 'dai', color: '#f5ac37' },
  { chainId: 1, address: '0x2260FAC5E5542a773Aa44fBCfeDf7C193bc2C599', symbol: 'WBTC', name: 'Wrapped Bitcoin', decimals: 8, priceId: 'wrapped-bitcoin', color: '#f09242' },
  { chainId: 1, address: '0x514910771AF9Ca656af840dff83E8264EcF986CA', symbol: 'LINK', name: 'Chainlink', decimals: 18, priceId: 'chainlink', color: '#2a5ada' },
  { chainId: 1, address: '0x1f9840a85d5aF5bf1D1762F925BDADdC4201F984', symbol: 'UNI', name: 'Uniswap', decimals: 18, priceId: 'uniswap', color: '#ff007a' },
  { chainId: 1, address: '0x7f39C581F595B53c5cb19bD0b3f8dA6c935E2Ca0', symbol: 'wstETH', name: 'Wrapped stETH', decimals: 18, priceId: 'wrapped-steth', color: '#00a3ff' },
  // Base
  { chainId: 8453, address: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', symbol: 'USDC', name: 'USD Coin', decimals: 6, priceId: 'usd-coin', color: '#2775ca' },
  { chainId: 8453, address: '0x50c5725949A6F0c72E6C4a641F24049A917DB0Cb', symbol: 'DAI', name: 'Dai Stablecoin', decimals: 18, priceId: 'dai', color: '#f5ac37' },
  { chainId: 8453, address: '0x4200000000000000000000000000000000000006', symbol: 'WETH', name: 'Wrapped Ether', decimals: 18, priceId: 'weth', color: '#6b7fd7' },
  // Arbitrum
  { chainId: 42161, address: '0xaf88d065e77c8cC2239327C5EDb3A432268e5831', symbol: 'USDC', name: 'USD Coin', decimals: 6, priceId: 'usd-coin', color: '#2775ca' },
  { chainId: 42161, address: '0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9', symbol: 'USDT', name: 'Tether USD', decimals: 6, priceId: 'tether', color: '#26a17b' },
  { chainId: 42161, address: '0x912CE59144191C1204E64559FE8253a0e49E6548', symbol: 'ARB', name: 'Arbitrum', decimals: 18, priceId: 'arbitrum', color: '#28a0f0' },
  { chainId: 42161, address: '0x2f2a2543B76A4166549F7aaB2e75Bef0aefC5B0f', symbol: 'WBTC', name: 'Wrapped Bitcoin', decimals: 8, priceId: 'wrapped-bitcoin', color: '#f09242' },
  // Optimism
  { chainId: 10, address: '0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85', symbol: 'USDC', name: 'USD Coin', decimals: 6, priceId: 'usd-coin', color: '#2775ca' },
  { chainId: 10, address: '0x94b008aA00579c1307B0EF2c499aD98a8ce58e58', symbol: 'USDT', name: 'Tether USD', decimals: 6, priceId: 'tether', color: '#26a17b' },
  { chainId: 10, address: '0x4200000000000000000000000000000000000042', symbol: 'OP', name: 'Optimism', decimals: 18, priceId: 'optimism', color: '#ff0420' },
  // Polygon
  { chainId: 137, address: '0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359', symbol: 'USDC', name: 'USD Coin', decimals: 6, priceId: 'usd-coin', color: '#2775ca' },
  { chainId: 137, address: '0xc2132D05D31c914a87C6611C10748AEb04B58e8F', symbol: 'USDT', name: 'Tether USD', decimals: 6, priceId: 'tether', color: '#26a17b' },
  { chainId: 137, address: '0x7ceB23fD6bC0adD59E62ac25578270cFf1b9f619', symbol: 'WETH', name: 'Wrapped Ether', decimals: 18, priceId: 'weth', color: '#6b7fd7' },
  // BNB Smart Chain
  { chainId: 56, address: '0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d', symbol: 'USDC', name: 'USD Coin', decimals: 18, priceId: 'usd-coin', color: '#2775ca' },
  { chainId: 56, address: '0x55d398326f99059fF775485246999027B3197955', symbol: 'USDT', name: 'Tether USD', decimals: 18, priceId: 'tether', color: '#26a17b' },
  { chainId: 56, address: '0x2170Ed0880ac9A755fd29B2688956BD959F933F8', symbol: 'ETH', name: 'Binance-Peg Ether', decimals: 18, priceId: 'ethereum', color: '#6b7fd7' },
  // Avalanche
  { chainId: 43114, address: '0xB97EF9Ef8734C71904D8002F8b6Bc66Dd9c48a6E', symbol: 'USDC', name: 'USD Coin', decimals: 6, priceId: 'usd-coin', color: '#2775ca' },
  { chainId: 43114, address: '0x9702230A8Ea53601f5cD2dc00fDBc13d4dF4A8c7', symbol: 'USDT', name: 'Tether USD', decimals: 6, priceId: 'tether', color: '#26a17b' }
]

/** Tokens on chains that aren't EVM: SPL tokens on Solana, TRC-20 on Tron. */
const OTHER_TOKEN_SEEDS: Erc20Seed[] = [
  { chainId: -501, address: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', symbol: 'USDC', name: 'USD Coin', decimals: 6, priceId: 'usd-coin', color: '#2775ca' },
  { chainId: -501, address: 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB', symbol: 'USDT', name: 'Tether USD', decimals: 6, priceId: 'tether', color: '#26a17b' },
  { chainId: -195, address: 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t', symbol: 'USDT', name: 'Tether USD', decimals: 6, priceId: 'tether', color: '#26a17b' }
]

const NATIVE_PRICE_IDS: Record<string, string> = {
  ETH: 'ethereum',
  POL: 'matic-network',
  BNB: 'binancecoin',
  AVAX: 'avalanche-2',
  BTC: 'bitcoin',
  LTC: 'litecoin',
  DOGE: 'dogecoin',
  SOL: 'solana',
  TRX: 'tron',
  XRP: 'ripple'
}

/** Every token the app knows about: chain natives first, then ERC-20, SPL and TRC-20 tokens. */
export const TOKENS: TokenDef[] = [
  ...CHAINS.map<TokenDef>((chain) => ({
    key: tokenKey(chain.id, null),
    chainId: chain.id,
    address: null,
    symbol: chain.nativeSymbol,
    name: chain.nativeName,
    decimals: chain.decimals,
    priceId: chain.testnet ? null : (NATIVE_PRICE_IDS[chain.nativeSymbol] ?? null),
    color: chain.color
  })),
  ...[...ERC20_SEEDS, ...OTHER_TOKEN_SEEDS].map<TokenDef>((t) => ({
    key: tokenKey(t.chainId, t.address),
    chainId: t.chainId,
    address: t.address,
    symbol: t.symbol,
    name: t.name,
    decimals: t.decimals,
    priceId: t.priceId,
    color: t.color
  }))
]

export const TOKEN_BY_KEY = new Map(TOKENS.map((t) => [t.key, t]))

export function tokensForChain(chainId: number): TokenDef[] {
  return TOKENS.filter((t) => t.chainId === chainId)
}

/** All tokens carrying a given symbol, across every chain. */
export function tokensBySymbol(symbol: string): TokenDef[] {
  const upper = symbol.toUpperCase()
  return TOKENS.filter((t) => t.symbol.toUpperCase() === upper)
}
