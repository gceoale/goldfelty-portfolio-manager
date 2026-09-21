# Goldfelty API

Account registration for goldfelty.com, running on Cloudflare Workers with D1.

The desktop app calls this to claim a username. Everything else it does happens
on the user's own machine.

## What it does, and what it can't

It checks that whoever is claiming a username controls the address they say
they do, by recovering the signer from a signature. There are no passwords
here, no seed phrases, and nothing secret is ever posted. If this service were
compromised tomorrow nobody would lose funds — the worst case is a wrong
username.

## Endpoints

    GET  /health
    GET  /v1/accounts/username-available?username=alice
    POST /v1/accounts

`POST /v1/accounts` takes:

```json
{
  "username": "alice",
  "email": "alice@example.com",
  "address": "0x…",
  "issuedAt": "2026-01-01T12:00:00.000Z",
  "signature": "0x…"
}
```

The signature must cover exactly this, newline separated:

    Goldfelty account registration
    username: <username>
    email: <email>
    address: <address>
    issued: <issuedAt>

Usernames must arrive lowercase. The server verifies the string it was sent
rather than normalising first, because normalising would mean checking a
signature over something the client never signed.

Registrations older than ten minutes are refused, so a captured body can't be
replayed later. Re-registering an address that already has an account returns
that account instead of failing — the app does exactly this every time it
re-links after being offline.

## Setting it up

```sh
npm install
npm run db:create          # prints a database_id — paste it into wrangler.toml
npm run db:migrate         # creates the table and its unique indexes
npm run deploy
```

Local development, against a local copy of the database:

```sh
npm run db:migrate:local
npm run dev
```

`wrangler.toml` claims `api.goldfelty.com` as a custom domain, which needs the
zone on Cloudflare. Delete that `routes` block to deploy on workers.dev instead.

## Tests

```sh
npm test
```

21 tests, no Cloudflare needed: the logic in `accounts.js` takes storage as an
argument, so the suite runs it against a Map that mimics D1's unique indexes.
`verify.js` is checked against ethers — it signs, our own recovery code reads
it back, and they have to agree.

## Layout

    src/verify.js     personal_sign recovery and EIP-55 checksums
    src/accounts.js   the actual logic, storage injected
    src/worker.js     Cloudflare entry point, binds D1
    schema.sql        table and unique indexes

`verify.js` exists because pulling ethers into a Worker for one function is a
lot of bundle for very little. The two noble packages it uses are a few
kilobytes and are the same primitives ethers uses underneath.
