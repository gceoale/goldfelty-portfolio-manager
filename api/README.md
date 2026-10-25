# Goldfelty API

Accounts for goldfelty.com, on Cloudflare Workers with D1, served at
`https://api.goldfelty.com`.

The desktop app uses it to claim a username, and, only for users who turn it
on, to share a portfolio total. The owner dashboard at goldfelty.com/admin
reads from it.

## Putting it live

The `Deploy account API` workflow does everything: runs the tests, creates the
`goldfelty-accounts` database if it doesn't exist, applies `schema.sql`,
deploys the Worker to `api.goldfelty.com`, sets the admin token, and checks
`/health` answers. It runs on every push to `main` that touches `api/`, and
from the Actions tab at any time.

It needs these repository secrets (Settings > Secrets and variables > Actions):

| Secret | Value |
|---|---|
| `CLOUDFLARE_ACCOUNT_ID` | On the Cloudflare dashboard, in the right-hand column of any zone's Overview, or under Workers & Pages. |
| `CLOUDFLARE_API_TOKEN` | A token from My Profile > API Tokens. Start from the **Edit Cloudflare Workers** template, then add **Account > D1 > Edit** and **Zone > DNS > Edit**, and limit Zone Resources to goldfelty.com. |
| `GOLDFELTY_ADMIN_TOKEN` | At least 16 characters, for the owner dashboard. Wrong guesses are limited to 10 every 15 minutes. Optional; without it the dashboard stays off. |

The goldfelty.com zone must be on Cloudflare, and there must be **no existing
DNS record named `api`**: Cloudflare creates it when the Worker claims the
custom domain. If a run fails with a permissions error, the log names the
missing one.

Until the secrets exist the workflow passes but deploys nothing, and the app
keeps new accounts on the user's computer, offering to link them later.

## Endpoints

    GET    /health
    GET    /v1/accounts/username-available?username=alice
    POST   /v1/accounts               register, proved by a wallet signature
    POST   /v1/reports                share a portfolio total (Bearer: account token)
    DELETE /v1/reports                stop sharing and delete it (Bearer: account token)
    GET    /v1/admin/stats            owner dashboard (Bearer: ADMIN_TOKEN)

`POST /v1/accounts` takes `username`, `email`, `address`, `issuedAt` and
`signature`. The signature is `personal_sign` over exactly:

    Goldfelty account registration
    username: <username>
    email: <email>
    address: <address>
    issued: <issuedAt>

It returns the account id, the username, and a reporting token. Only the
token's SHA-256 is stored, and registering again from the same address issues
a fresh one. Registrations older than ten minutes are refused, usernames must
arrive lowercase (the signature covers the exact string), and an address that
already has an account gets it back rather than an error.

`POST /v1/reports` takes `{ value, currency, wallets }` and nothing else.

## Limits

Per IP address, stored only as a hash: 10 registrations an hour, 120 username
checks a minute, 30 reports an hour, 60 admin requests a minute. Bodies over
4 KB and anything that isn't JSON are refused.

## Manual deploy

```sh
npm install
npm run db:create      # prints a database_id; paste it into wrangler.toml
npm run db:migrate
npm run deploy
printf '%s' "$ADMIN_TOKEN" | npx wrangler secret put ADMIN_TOKEN
```

## Tests

```sh
npm test
```

No Cloudflare needed. `accounts.js` takes storage as an argument, so most tests
run it against a Map; `test/worker.test.mjs` runs the Worker's real SQL against
SQLite through a small D1 stand-in.

## Layout

    src/verify.js     personal_sign recovery and EIP-55 checksums
    src/accounts.js   the logic, storage injected
    src/worker.js     Cloudflare entry point and the D1 queries
    schema.sql        accounts, tokens, shared totals, rate limits
