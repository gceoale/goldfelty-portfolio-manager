# Security

## Reporting a problem

Email **security@goldfelty.com** with what you found and how to reproduce it.
Please don't open a public issue for anything that could put someone's funds or
data at risk. You'll get a reply within a few days, and credit in the release
notes if you'd like it.

## What's in scope

The desktop app in this repository, the account API in `api/`, and
goldfelty.com. Goldfelty holds no private keys, so the most serious issues are
ones that could make a user send something they didn't intend, show them a
receive address that isn't theirs, or expose what they hold.

## Past review

[docs/SECURITY-AUDIT.md](docs/SECURITY-AUDIT.md) records the internal review
done for 1.1.1: findings, fixes, and the risks accepted for now.
