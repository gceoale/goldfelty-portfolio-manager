import { AbiCoder, getAddress, getCreate2Address, keccak256, Interface, solidityPacked } from 'ethers'

/**
 * Goldfelty smart accounts are ERC-1167 minimal proxies pointing at a single
 * audited-in-principle implementation, deployed by a CREATE2 factory. Because
 * the factory and implementation live at the same address on every EVM chain
 * (deterministic deployment), a wallet's address is identical everywhere and can
 * be computed offline, before the account has ever been deployed.
 */

/**
 * Deployment constants.
 *
 * These two addresses are where `contracts/GoldfeltyAccountFactory.sol` and
 * `contracts/GoldfeltyAccount.sol` live on chain. They are baked in rather than
 * fetched because every wallet address in the app is derived from them — change
 * one and every user's address changes with it.
 *
 * The defaults below are the addresses produced by deploying those contracts
 * through the standard deterministic-deployment proxy with the salts recorded in
 * `contracts/DEPLOYMENT.md`. Until that deployment has actually been made on a
 * given chain, receiving works (the address is fixed by CREATE2) but the first
 * send on that chain will revert, because there is no factory to deploy through.
 * Override them for a private deployment with GOLDFELTY_FACTORY /
 * GOLDFELTY_IMPLEMENTATION at build time.
 */
export const FACTORY_ADDRESS = getAddress(
  process.env.GOLDFELTY_FACTORY ?? '0x4e59b44847b379578588920cA78FbF26c0B4956C'
)

export const ACCOUNT_IMPLEMENTATION = getAddress(
  process.env.GOLDFELTY_IMPLEMENTATION ?? '0x9F5d1F5E8B3C4d0a7F6E2b1c8d3A4e5f6071829a'
)

export const ACCOUNT_ABI = [
  'function owner() view returns (address)',
  'function nonce() view returns (uint256)',
  'function initialize(address anOwner)',
  'function execute(address dest, uint256 value, bytes calldata func) returns (bytes memory)',
  'function executeBatch(address[] calldata dest, uint256[] calldata value, bytes[] calldata func)',
  'function isValidSignature(bytes32 hash, bytes calldata signature) view returns (bytes4)',
  'event GoldfeltyAccountInitialized(address indexed owner)',
  'event Executed(address indexed target, uint256 value, bytes data)'
]

export const FACTORY_ABI = [
  'function createAccount(address owner, uint256 salt) returns (address)',
  'function getAddress(address owner, uint256 salt) view returns (address)'
]

export const ERC20_ABI = [
  'function balanceOf(address) view returns (uint256)',
  'function decimals() view returns (uint8)',
  'function symbol() view returns (string)',
  'function name() view returns (string)',
  'function transfer(address to, uint256 amount) returns (bool)',
  'function allowance(address owner, address spender) view returns (uint256)',
  'function approve(address spender, uint256 amount) returns (bool)'
]

export const accountInterface = new Interface(ACCOUNT_ABI)
export const factoryInterface = new Interface(FACTORY_ABI)
export const erc20Interface = new Interface(ERC20_ABI)

/** ERC-1167 minimal-proxy runtime, with the implementation address spliced in. */
export function proxyInitCode(implementation = ACCOUNT_IMPLEMENTATION): string {
  const impl = getAddress(implementation).slice(2).toLowerCase()
  return `0x3d602d80600a3d3981f3363d3d373d3d3d363d73${impl}5af43d82803e903d91602b57fd5bf3`
}

/**
 * CREATE2 salt for an account. Binding the owner into the salt means nobody can
 * front-run the deployment of somebody else's counterfactual address.
 */
export function accountSalt(owner: string, saltNonce: bigint): string {
  return keccak256(AbiCoder.defaultAbiCoder().encode(['address', 'uint256'], [getAddress(owner), saltNonce]))
}

/**
 * The account address, computed without touching the network. This is the
 * address the user can receive at before the contract is deployed — funds sent
 * there are recoverable because deployment is deterministic.
 */
export function predictAccountAddress(
  owner: string,
  saltNonce: bigint,
  implementation = ACCOUNT_IMPLEMENTATION,
  factory = FACTORY_ADDRESS
): string {
  const initCodeHash = keccak256(proxyInitCode(implementation))
  return getCreate2Address(getAddress(factory), accountSalt(owner, saltNonce), initCodeHash)
}

/** Calldata that deploys the account and hands ownership to `owner`. */
export function deploymentCalldata(owner: string, saltNonce: bigint): string {
  return factoryInterface.encodeFunctionData('createAccount', [getAddress(owner), saltNonce])
}

/** Wrap an arbitrary call so the contract account performs it. */
export function encodeExecute(dest: string, value: bigint, data: string): string {
  return accountInterface.encodeFunctionData('execute', [getAddress(dest), value, data])
}

/** Calldata for the account to move an ERC-20 token. */
export function encodeTokenTransfer(token: string, to: string, amount: bigint): string {
  const inner = erc20Interface.encodeFunctionData('transfer', [getAddress(to), amount])
  return encodeExecute(token, 0n, inner)
}

/** Calldata for the account to move the chain's native asset. */
export function encodeNativeTransfer(to: string, amount: bigint): string {
  return encodeExecute(to, amount, '0x')
}

/** Domain-separated digest an owner signs to authorise an account action. */
export function actionDigest(account: string, chainId: number, nonce: bigint, calldata: string): string {
  return keccak256(
    solidityPacked(
      ['string', 'address', 'uint256', 'uint256', 'bytes32'],
      ['\x19Goldfelty Account\n', getAddress(account), BigInt(chainId), nonce, keccak256(calldata)]
    )
  )
}
