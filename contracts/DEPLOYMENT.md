# Deploying the Goldfelty account contracts

Every wallet address the app shows is derived from two constants in
`src/main/smartAccount.ts`:

| Constant | Meaning |
| --- | --- |
| `FACTORY_ADDRESS` | Where `GoldfeltyAccountFactory` is deployed |
| `ACCOUNT_IMPLEMENTATION` | The `GoldfeltyAccount` the clones delegate to |

Change either one and **every user's wallet address changes with it**. Treat them
the way you would a database primary key.

## Why the addresses are the same on every chain

The factory is deployed through the standard deterministic-deployment proxy at
`0x4e59b44847b379578588920cA78FbF26c0B4956C`, which exists at that address on
every major EVM chain. Given the same bytecode and the same salt, it produces
the same factory address everywhere — and the factory in turn produces the same
account address everywhere. That is what lets the Receive tab hand out one
address that works on Ethereum, Base, Arbitrum, OP and Polygon alike.

## Deploying

```bash
# 1. Compile
forge build

# 2. Deploy the factory through the deterministic proxy, with a fixed salt.
cast send 0x4e59b44847b379578588920cA78FbF26c0B4956C \
  "$(cast concat-hex 0x0000000000000000000000000000000000000000000000000000000047464d31 \
     "$(forge inspect GoldfeltyAccountFactory bytecode)")" \
  --rpc-url "$RPC_URL" --private-key "$DEPLOYER_KEY"

# 3. Read back the deployed addresses.
cast call "$FACTORY" "accountImplementation()(address)" --rpc-url "$RPC_URL"
```

Repeat step 2 on every chain in `src/shared/chains.ts`, from the same deployer
with the same salt, and confirm the resulting factory address matches.

## Wiring the app to your deployment

Either edit the two constants in `src/main/smartAccount.ts`, or build with:

```bash
GOLDFELTY_FACTORY=0x… GOLDFELTY_IMPLEMENTATION=0x… npm run dist
```

## Before real money

Neither contract in this directory has been through an independent security
audit, and neither has the desktop application that drives them. Get both
reviewed before anyone funds a wallet they would miss.
