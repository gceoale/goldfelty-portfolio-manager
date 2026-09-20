## Which file do I download?

| Your machine | File |
| --- | --- |
| Mac, Apple silicon (M1–M4) | `…-arm64.dmg` |
| Mac, Intel | `…-x64.dmg` |
| Windows 10/11, Intel or AMD | `…-x64-setup.exe` |
| Windows on ARM (Snapdragon, Surface Pro X) | `…-arm64-setup.exe` |
| Windows, unsure which | `…-setup.exe` — one installer carrying both |
| Linux, 64-bit Intel or AMD | `…-x86_64.AppImage`, `…_amd64.deb`, or `…x86_64.rpm` |
| Linux, ARM64 (Raspberry Pi 5, Ampere) | `…-arm64.AppImage`, `…_arm64.deb`, or `…aarch64.rpm` |

Files ending `-portable.exe` run without installing anything. The `-mac.zip`
and `.tar.gz` builds are the same app without an installer, for putting
somewhere yourself.

AppImages need the execute bit before they will run:

```bash
chmod +x 'Goldfelty Portfolio Manager-1.0.1-x86_64.AppImage'
```

## Read this before you put money in it

**These builds are unsigned, and macOS will refuse them by default.**

On a Mac you will most likely see:

> "Goldfelty Portfolio Manager" is damaged and can't be opened. You should
> move it to the Trash.

The app is not damaged. macOS quarantines anything downloaded from the
internet, and because these builds carry no Apple Developer ID certificate,
Gatekeeper rejects them rather than offering the usual "open anyway" prompt.
Clear the quarantine flag after dragging the app to Applications:

```bash
xattr -dr com.apple.quarantine "/Applications/Goldfelty Portfolio Manager.app"
```

Then open it normally. You only need to do this once per install.

On Windows, SmartScreen will object for the same reason — choose "More info"
then "Run anyway".

Only bypass either warning for a file you fetched from this releases page.
Both warnings exist precisely to stop you running an unsigned binary of
unknown origin, and a wallet is exactly the kind of program an attacker would
want to substitute. Verifying what you downloaded matches what CI built is
worth the two minutes.

**Nothing here has been audited.** Neither the desktop application nor the
contracts in `contracts/` have had an independent security review. Treat this
as software to evaluate, not somewhere to park savings.

**The account contracts are not deployed yet.** `FACTORY_ADDRESS` and
`ACCOUNT_IMPLEMENTATION` in `src/main/smartAccount.ts` still carry placeholder
defaults. Until the factory exists on a given chain, wallet addresses are
computed correctly and **receiving works**, but the first *send* on that chain
will revert — there is no factory to deploy the account through. See
[`contracts/DEPLOYMENT.md`](../blob/main/contracts/DEPLOYMENT.md) for how to
deploy your own and point the app at them.

**Your recovery phrase is shown once.** During onboarding, and never again —
there is no "reveal seed" anywhere in the app. Write it down on paper at that
moment or you will not get another chance.

## What's in it

Four tabs behind a left-hand rail — Home, Send, Receive, Settings.

- **Up to 256 smart-contract wallets** per vault, all derived from one 24-word
  phrase, across Ethereum, Base, Arbitrum, OP, Polygon, BNB and Avalanche.
- **Routing is always your choice.** When more than one wallet holds a token,
  Send and Receive list every wallet-and-chain pair and wait for you to pick,
  with filters that stay usable at 250 routes.
- **scrypt + AES-256-GCM vault.** The seed never leaves the main process; the
  renderer is sandboxed with a strict CSP and sees only addresses.
- Auto-lock on idle, quit and crash. Every transfer re-checks your password.
