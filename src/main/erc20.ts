import { Interface } from 'ethers'

/** The slice of ERC-20 the app uses: reading balances and building transfers. */
export const erc20Interface = new Interface([
  'function balanceOf(address) view returns (uint256)',
  'function transfer(address to, uint256 amount) returns (bool)'
])
