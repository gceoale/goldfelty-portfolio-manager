# Security audit: Goldfelty 1.1.1

Date: 24 October 2026. Scope: the desktop app (`src/`), its build and release
pipeline (`scripts/`, `electron-builder.yml`, `.github/workflows/`), the
account API (`api/`) and goldfelty.com (`site/`). This was an internal review
done alongside the 1.1.1 rewrite, not an independent audit; that still needs
doing before Goldfelty is trusted with significant funds.

## Summary

Goldfelty 1.1.1 holds no keys. Every transfer and signature is approved in the
user's own wallet, so the worst outcomes this review looks for are: a send the
user didn't intend (wrong recipient, amount or network), a receive address that
isn't theirs, local data about their holdings leaking, and abuse of the
goldfelty.com service.

The review found 5 high, 14 medium and 9 low severity issues. All are fixed in
1.1.1 except where marked as accepted, and each fix is covered by a test
(listed under *Verification*). The largest residual risks are unsigned builds,
malware already running as the user, and funds already sent to addresses that
version 1.0 created.

## Threat model

| Actor | Can | Goldfelty should |
|---|---|---|
| A web page in the user's browser | Send requests to `127.0.0.1`, navigate to the bridge, try DNS rebinding | Refuse everything that isn't the app's own tab |
| A malicious browser extension | Announce itself under any wallet's name | Nothing beyond what the user approves in that "wallet"; see accepted risk A5 |
| Someone on the same network | Nothing: every local service binds to `127.0.0.1` | |
| Another user, or malware, on the same computer | Read files, browser history, environment, other local ports | Keep holdings encrypted at rest; never leave a working secret in history; malware running as the user is out of scope (A1) |
| A compromised goldfelty.com (GitHub Pages) | Change the fee rate, change the site | Never redirect funds; keep the rate within 0 to 10% and visible before every send |
| A compromised RPC provider or price feed | Lie about balances and prices | Never cause a send the wallet didn't show the user |
| An internet attacker against api.goldfelty.com | Flood it, guess names, replay bodies, forge signatures | Rate-limit, bound inputs, verify signatures exactly |
| The renderer, if compromised by a bug | Call any IPC verb | Only reach named verbs with validated arguments; no network; no new windows |

## Findings

Severity: **High** can lose funds or expose secrets with little user action;
**Medium** needs another condition or exposes less; **Low** is defence in depth.

### High

| ID | Area | Finding | Status |
|---|---|---|---|
| H1 | Runtime | Electron 33 is out of support, so the app shipped a Chromium with unpatched, publicly known vulnerabilities. | Fixed: Electron 44.9.3. |
| H2 | Build | electron-builder 25 depended on a `tar` with a critical path-traversal advisory, and produced AppImages with an uncontrolled library search path. | Fixed: electron-builder 26.18.0. `npm audit`: 0 vulnerabilities. |
| H3 | Wallets (1.0) | Smart-account addresses created by 1.0 point at a placeholder implementation that can never be deployed, so funds sent to them can't be moved. | Mitigated: wallet creation is removed. Those addresses are kept read-only, never offered as a receive address, and flagged if entered as a recipient. Funds already there remain stuck (A9). |
| H4 | Browser bridge | The bridge's secret token sat in the page URL, so it was saved in browser history. Anything able to read history could pose as the wallet tab: hand the app a fake account (a receive address the user doesn't own), read pending transfer requests, or return fake signatures. | Fixed: the app opens a one-time ticket that is swapped for a random session secret in an `HttpOnly`, `SameSite=Strict` cookie, and redirects to a clean URL. A used ticket grants nothing. |
| H5 | Sends | Browser wallets and Frame send on whatever network they're currently on. A Base transfer could go out on Ethereum, to a token address that means something else there. | Fixed: the app switches the wallet to the right chain, adds it if unknown, reads the chain back and refuses to send on a mismatch. `chainId` also travels in the transaction. |

### Medium

| ID | Area | Finding | Status |
|---|---|---|---|
| M1 | Browser bridge | No `Host` check, so DNS rebinding could reach the bridge from a web page. | Fixed: `Host` must be `127.0.0.1:<port>`; foreign `Origin` and `Sec-Fetch-Site: cross-site` are refused; POSTs must be JSON. |
| M2 | Browser bridge | The bridge page built HTML from URL parameters, including a link `href`, which could have been a `javascript:` URL. | Fixed: the page reads nothing from its URL, builds its DOM without HTML strings, and its script and style are pinned by SHA-256 in its CSP. |
| M3 | IPC | IPC handlers didn't check who was calling. | Fixed: only the main window's top frame, loaded from the app's own URL, may call. |
| M4 | Settings | The renderer could write any setting, including a custom RPC or price URL of any scheme. | Fixed: every field is validated; endpoints must be `https://` (or `http://` on loopback) with no credentials; unknown keys are dropped. |
| M5 | Storage | Holdings, addresses, history and settings sat in plaintext `state.json`. | Fixed: stored AES-256-GCM encrypted under a random data key that the password unwraps. The old file is converted and deleted. Only theme, greeting name and unlock-throttle state stay in plaintext. |
| M6 | Lock screen | No limit on password attempts. | Fixed: after 5 wrong tries each further try waits, doubling up to 15 minutes, persisted across restarts. Against a copied vault file, scrypt (N=2^17) is the defence. |
| M7 | Vault | KDF parameters were trusted from the vault file, so an edited file could weaken them or hang the app. | Fixed: scrypt parameters must fall within fixed bounds. |
| M8 | Deep links | `goldfelty://wc?uri=…` forwarded a link's contents into the wallet layer. | Fixed: links only bring the window forward. |
| M9 | Renderer | The renderer CSP allowed inline styles and same-origin connections. | Fixed: production CSP is `default-src 'none'` with only the bundle allowed, plus a session filter that cancels any renderer request off `file:`. |
| M10 | Account client | Every failure, including "username taken" and "bad signature", fell back to a local account silently. Redirects were followed with a signed body. | Fixed: unreachable and refused are told apart; redirects are refused; responses are size-capped and shape-checked. |
| M11 | Account API | No rate limiting, unbounded bodies, and loose timestamp and signature parsing. | Fixed: per-IP limits in D1 (IPs stored only as hashes), 4 KB bodies, JSON only, exact ISO timestamps, 65-byte signatures, low-S enforced. |
| M12 | CI | The release workflow gave every job write access, passed a token to the build, and left checkout credentials on disk. | Fixed: read-only by default, write only for the publish job, no token in builds, `persist-credentials: false`. |
| M13 | Releases | No way to check a download against what CI built. | Fixed: `SHA256SUMS.txt` is published with every release. |
| M14 | Packaging | Electron fuses were left at defaults, so the shipped binary could be run as plain Node (`ELECTRON_RUN_AS_NODE`) or steered with `NODE_OPTIONS` or `--inspect`. | Fixed: those fuses are off; app code loads only from `app.asar`; cookie encryption is on. |

### Low

| ID | Area | Finding | Status |
|---|---|---|---|
| L1 | Lock | Auto-lock could be turned off; nothing locked on sleep. | Fixed: 1 to 120 minutes; also locks on sleep, screen lock, window close and renderer crash. |
| L2 | Sends | Address-poisoning lookalikes went unnoticed. | Fixed: a recipient that shares the first and last characters of an address the user has used, but isn't it, is flagged. |
| L3 | Sends | Nothing checked what the wallet actually sent. | Fixed: after confirmation the transaction's sender, recipient, value and data are compared with what was asked; a difference is flagged in Activity. |
| L4 | Windows | Only the main window had navigation guards. | Fixed: every web contents denies new windows, navigation, redirects and webviews; downloads and all permissions (including devices) are refused. |
| L5 | Clipboard | The generic copy verb accepted anything. | Fixed: limited to short text; one-time bridge links go straight to the clipboard and never pass through the renderer. |
| L6 | Errors | Error messages could carry stacks and paths across IPC. | Fixed: messages are trimmed; stacks are only logged in development. |
| L7 | Dependencies | `electron-updater` was bundled but unused. | Removed. |
| L8 | Account tokens | (New in 1.1.1.) Reporting tokens could leak through the renderer. | Designed out: tokens stay in the main process, only their hashes are stored server-side, and re-linking replaces them. |
| L9 | Owner dashboard | Account data is user-supplied and shown on a page that holds an admin token. | Rendered only with `textContent` (tested with a hostile username); strict CSP; token kept in `sessionStorage`; page is `noindex`. GitHub Pages can't send `frame-ancestors`, so framing isn't prevented; low impact, as the page shows nothing without the token. |

## Design choices worth knowing

- **The fee address is fixed at build time** (`GOLDFELTY_FEE_ADDRESS`). Only the rate is read from goldfelty.com, clamped to 0 to 10%. A compromised site could raise the rate within that range, but couldn't redirect anyone's money, and the app never charges more than the rate shown on the review screen.
- **The fee goes after the transfer** as its own transaction, so it is only ever requested once the user's transfer has gone out, and the wallet shows it for what it is.
- **Sharing portfolio totals is off by default.** When on, it sends one number, its currency and a wallet count. Turning it off deletes the server copy.
- **WalletConnect is the only third-party relay**, used for phones only. Browser wallets and Frame are reached directly on the user's machine.

## Accepted risks

| ID | Risk | Why accepted, or what would fix it |
|---|---|---|
| A1 | Malware running as the user can read the password as it's typed, alter the installed app, set environment variables the app honours (`GOLDFELTY_API_URL` and similar), pose as Frame on port 1248, or open its own bridge tab. | Out of scope for any desktop app. Code signing (A2) and asar integrity (A3) would make tampering detectable. |
| A2 | Builds aren't signed by Apple or Microsoft, so users can't verify where a download came from beyond the published checksums. | Set `CSC_LINK`, `CSC_KEY_PASSWORD` and the `APPLE_*` secrets; the release workflow already handles signing and notarisation when they exist. |
| A3 | The embedded asar integrity fuse is off. | It needs per-platform support from the packager and testing on each OS; turn it on once signed builds exist. |
| A4 | Decrypted data passes through JavaScript strings, which can't be zeroed. | Keys are held in buffers and wiped on lock; the strings are garbage collected. |
| A5 | EIP-6963 has no authentication, so a malicious extension can announce itself as any wallet. | Inherent to browser wallets. The user still approves everything in what they believe is their wallet; the post-send mismatch check (L3) catches substituted transfers after the fact. |
| A6 | Public RPC providers and the price feed can report false balances and prices. | Display only. Users can set their own node per network. |
| A7 | A user can decline the fee transaction. | A business choice, covered in the Terms. Charging the fee first would mean charging for transfers that never happen. |
| A8 | Wrangler's local development server (miniflare) pulls in an `undici` with known advisories. | Resolved 25 October 2026: `api/package.json` overrides `undici` to a patched 7.30.x; `npm audit` in `api/` reports 0. |
| A9 | Funds already sent to 1.0 smart-account addresses can't be recovered. | Nothing in software can move them; see H3. |
| A10 | The owner dashboard is protected by a single bearer secret. | Use a long random value and rotate it by updating the `GOLDFELTY_ADMIN_TOKEN` secret and redeploying. |
| A11 | Account emails are stored in plaintext in D1. | Needed to contact users; D1 is encrypted at rest by Cloudflare. |

## Verification

- `npm test`: 85 tests over the main process, including the bridge's ticket, cookie, Host, Origin, CSP and tab-isolation rules over real HTTP; Frame against a mock socket (chain switching, refusal on mismatch); vault v2 and v1 migration; encrypted store; settings rules; unlock throttling; fees; lookalike and mismatch detection; and the account client against mock servers.
- `api/`: 35 tests, including the Worker's SQL run against real SQLite.
- `scripts/e2e.cjs`: drives the built app with a fake browser wallet, the real account API code and mock RPC. It checks that the renderer can't reach the network, a reused bridge link is refused, a send goes out on the right chain with the right fee, and no wallet address or email is readable in any file on disk. Any CSP violation or console error fails the run.
- `npm audit`: 0 vulnerabilities in the app.

## Follow-up review, 25 October 2026

| ID | Severity | Finding | Status |
|---|---|---|---|
| F1 | High | The GitHub account was renamed from `gceoalexyt-ops` to `gceoale`, but the site's download button, its release lookups, the owner dashboard, `security.txt`, electron-builder's publish target and the `www` DNS record still named the old account. A freed GitHub username can be registered by anyone; whoever took it could publish their own "releases" and goldfelty.com would send visitors to them. | Fixed in the repository: every reference now names `gceoale`. The `www` CNAME in Cloudflare must be changed by hand (see `docs/DNS.md`). |
| F2 | High (development only) | `undici` 7.29.1 under wrangler/miniflare: GHSA-xjj6-f33q-929c, GHSA-4qv8-2p9j-2685, GHSA-f72v-6w45-q472. Never deployed to the Worker. | Fixed: overridden to 7.30.1. |
| F3 | Low | The release workflow's third-party action, which holds a token that can write releases, was referenced by a movable tag. | Fixed: pinned to a commit. |
| F4 | Low | The site deploy workflow left checkout credentials on disk. | Fixed: `persist-credentials: false`. |

## Recommended next steps

1. Get the builds signed (A2), then turn on asar integrity (A3).
2. Commission an independent audit before promoting Goldfelty for significant amounts.
3. Review the Terms and Privacy Policy with a lawyer for the places you operate.

Reports go to the address in `SECURITY.md`, also published at
`https://goldfelty.com/.well-known/security.txt`.
