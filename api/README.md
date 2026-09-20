# Goldfelty API

Account registration for goldfelty.com. The desktop app calls this to claim a
username; everything else it does happens locally.

## What it does and does not do

It verifies that whoever is claiming a username controls the address they say
they do, by checking a signature. There are no passwords here, no seed
phrases, and nothing secret is ever posted. If this service were compromised
tomorrow, nobody would lose funds — the worst case is a wrong username.

## Endpoints

    GET  /health
    GET  /v1/accounts/username-available?username=alice
    POST /v1/accounts

`POST /v1/accounts` expects:

```json
{
  "username": "alice",
  "email": "alice@example.com",
  "address": "0x…",
  "issuedAt": "2026-01-01T12:00:00.000Z",
  "signature": "0x…"
}
```

The signature must cover exactly this text, newline separated:

    Goldfelty account registration
    username: <username>
    email: <email>
    address: <address>
    issued: <issuedAt>

Registrations older than ten minutes are refused, so a captured body cannot be
replayed later. Re-registering an address that already has an account returns
the existing one rather than failing, because that is how the app re-links
after being offline.

## Running it

```sh
npm install
npm start           # :8080, accounts in ./data
npm test
```

Or:

```sh
docker build -t goldfelty-api .
docker run -p 8080:8080 -v goldfelty-data:/data goldfelty-api
```

## Storage

A JSON file, written through a temp file and a rename. That is the right size
for the problem: the records are tiny and there are two lookups. Swap it for a
database when the numbers justify one — `src/store.js` is the only file that
would change.
